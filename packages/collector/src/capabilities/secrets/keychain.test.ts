import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { createNodePlatform } from "@rivus/agent-kit/node";
import { Effect, Layer } from "effect";
import * as z from "zod/mini";
import { describe, expect, it } from "vite-plus/test";

import { SnorlaxPlatform } from "../../modules/platform/platform.ts";
import { Secrets } from "./secrets.ts";

/**
 * `security -i` and `secret-tool` through stub scripts. The token is written on stdin and must not appear in
 * argv. Nothing here starts `/usr/bin/security` or `secret-tool`.
 */

const invocationSchema = z.object({
  argv: z.array(z.string()),
  stdin: z.string()
});

const TOKEN = "tok_test_value_123";
const OTHER = "override-token-456";
const DEVICE = "6f1c8d2e-4a3b-4c5d-9e6f-7a8b9c0d1e2f";

const securityStub = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv: process.argv, stdin }) + "\\n");
  const parts = stdin.trim().split(/\\s+/).filter((part) => part !== "");
  const flag = (name) => {
    const index = parts.indexOf(name);
    return index >= 0 ? parts[index + 1] : undefined;
  };
  const storePath = process.env.STUB_STORE;
  const items = existsSync(storePath) ? JSON.parse(readFileSync(storePath, "utf8")) : {};
  const account = flag("-a");
  const op = parts[0];
  if (op === "add-generic-password") {
    items[account] = flag("-w") ?? "";
    writeFileSync(storePath, JSON.stringify(items));
    process.exit(0);
  }
  if (op === "find-generic-password") {
    if (items[account] === undefined) process.exit(44);
    process.stdout.write(String(items[account]) + "\\n");
    process.exit(0);
  }
  if (op === "delete-generic-password") {
    if (items[account] === undefined) process.exit(44);
    delete items[account];
    writeFileSync(storePath, JSON.stringify(items));
    process.exit(0);
  }
  process.stderr.write("unknown command\\n");
  process.exit(2);
});
`;

const secretToolStub = `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv: process.argv, stdin }) + "\\n");
  const storePath = process.env.STUB_STORE;
  const items = existsSync(storePath) ? JSON.parse(readFileSync(storePath, "utf8")) : {};
  const args = process.argv.slice(2);
  const accountAt = args.indexOf("account");
  const account = accountAt >= 0 ? args[accountAt + 1] : undefined;
  const op = args[0];
  if (op === "store") {
    items[account] = stdin.endsWith("\\n") ? stdin.slice(0, -1) : stdin;
    writeFileSync(storePath, JSON.stringify(items));
    process.exit(0);
  }
  if (op === "lookup") {
    if (items[account] === undefined) process.exit(1);
    process.stdout.write(String(items[account]) + "\\n");
    process.exit(0);
  }
  if (op === "clear") {
    if (items[account] === undefined) process.exit(1);
    delete items[account];
    writeFileSync(storePath, JSON.stringify(items));
    process.exit(0);
  }
  process.stderr.write("unknown command\\n");
  process.exit(2);
});
`;

const readInvocations = async (logPath: string) => {
  const text = await readFile(logPath, "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const json: unknown = JSON.parse(line);
      return z.parse(invocationSchema, json);
    });
};

const assertTokenNotInArgv = (calls: readonly { argv: readonly string[]; stdin: string }[], token: string) => {
  for (const call of calls) {
    for (const arg of call.argv) {
      expect(arg).not.toContain(token);
    }
  }
};

describe("macOS keychain through security -i", () => {
  it("keeps the token on stdin, round-trips it, and treats a missing item as absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "snorlax-keychain-"));
    const logPath = join(home, "security.log");
    const storePath = join(home, "items.json");
    const stubPath = join(home, "security-stub");
    try {
      await writeFile(stubPath, securityStub);
      await chmod(stubPath, 0o755);
      await writeFile(logPath, "");
      const platform = createNodePlatform({
        home,
        env: {
          PATH: "/usr/bin:/bin",
          SNORLAX_SECURITY: stubPath,
          STUB_LOG: logPath,
          STUB_STORE: storePath
        }
      });
      const run = <A, E>(effect: Effect.Effect<A, E, Secrets>) =>
        Effect.runPromise(
          effect.pipe(Effect.provide(Layer.provide(Secrets.keychain, Layer.succeed(SnorlaxPlatform, platform))))
        );
      const secrets = await run(
        Effect.gen(function* () {
          return yield* Secrets;
        })
      );
      await Effect.runPromise(secrets.store(DEVICE, TOKEN));
      expect(await Effect.runPromise(secrets.read(DEVICE))).toBe(TOKEN);
      expect(await Effect.runPromise(secrets.read("00000000-0000-4000-8000-000000000001"))).toBeUndefined();
      await Effect.runPromise(secrets.delete(DEVICE));
      await Effect.runPromise(secrets.delete(DEVICE));
      expect(await Effect.runPromise(secrets.read(DEVICE))).toBeUndefined();

      const calls = await readInvocations(logPath);
      assertTokenNotInArgv(calls, TOKEN);
      const store = calls[0];
      expect(store?.argv.slice(2)).toEqual(["-i"]);
      expect(store?.stdin).toBe(`add-generic-password -U -s snorlax -a ${DEVICE} -w ${TOKEN}\n`);
      expect(calls[1]?.stdin).toBe(`find-generic-password -s snorlax -a ${DEVICE} -w\n`);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("returns SNORLAX_DEVICE_TOKEN without starting security", async () => {
    const home = await mkdtemp(join(tmpdir(), "snorlax-keychain-override-"));
    const logPath = join(home, "security.log");
    const stubPath = join(home, "security-stub");
    try {
      await writeFile(stubPath, securityStub);
      await chmod(stubPath, 0o755);
      const platform = createNodePlatform({
        home,
        env: {
          PATH: "/usr/bin:/bin",
          SNORLAX_SECURITY: stubPath,
          SNORLAX_DEVICE_TOKEN: OTHER,
          STUB_LOG: logPath,
          STUB_STORE: join(home, "items.json")
        }
      });
      const token = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* Secrets).read(DEVICE);
        }).pipe(Effect.provide(Layer.provide(Secrets.keychain, Layer.succeed(SnorlaxPlatform, platform))))
      );
      expect(token).toBe(OTHER);
      await expect(readFile(logPath, "utf8")).rejects.toThrow("ENOENT");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("fails when the security binary cannot be started and does not call /usr/bin/security", async () => {
    const home = await mkdtemp(join(tmpdir(), "snorlax-keychain-missing-"));
    try {
      const platform = createNodePlatform({
        home,
        env: { PATH: "/usr/bin:/bin", SNORLAX_SECURITY: join(home, "missing-security") }
      });
      const error = await Effect.runPromise(
        Effect.flip(
          Effect.gen(function* () {
            return yield* (yield* Secrets).read(DEVICE);
          }).pipe(Effect.provide(Layer.provide(Secrets.keychain, Layer.succeed(SnorlaxPlatform, platform))))
        )
      );
      expect(error._tag).toBe("KeychainUnavailable");
      expect(error.message).toContain("missing-security");
      expect(error.message).not.toContain("/usr/bin/security");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("Linux secret service through secret-tool", () => {
  it("keeps the token on stdin and round-trips it", async () => {
    const home = await mkdtemp(join(tmpdir(), "snorlax-libsecret-"));
    const logPath = join(home, "secret-tool.log");
    const storePath = join(home, "items.json");
    const stubPath = join(home, "secret-tool-stub");
    try {
      await writeFile(stubPath, secretToolStub);
      await chmod(stubPath, 0o755);
      await writeFile(logPath, "");
      const platform = createNodePlatform({
        home,
        env: {
          PATH: "/usr/bin:/bin",
          SNORLAX_SECRET_TOOL: stubPath,
          STUB_LOG: logPath,
          STUB_STORE: storePath
        }
      });
      const secrets = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* Secrets;
        }).pipe(Effect.provide(Layer.provide(Secrets.libsecret, Layer.succeed(SnorlaxPlatform, platform))))
      );
      await Effect.runPromise(secrets.store(DEVICE, TOKEN));
      expect(await Effect.runPromise(secrets.read(DEVICE))).toBe(TOKEN);
      expect(await Effect.runPromise(secrets.read("00000000-0000-4000-8000-000000000001"))).toBeUndefined();
      await Effect.runPromise(secrets.delete(DEVICE));
      expect(await Effect.runPromise(secrets.read(DEVICE))).toBeUndefined();

      const calls = await readInvocations(logPath);
      assertTokenNotInArgv(calls, TOKEN);
      expect(calls[0]?.argv.slice(2)).toEqual(["store", "--label=snorlax", "service", "snorlax", "account", DEVICE]);
      expect(calls[0]?.stdin).toBe(`${TOKEN}\n`);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
