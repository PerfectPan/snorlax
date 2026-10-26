import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { createNodePlatform } from "@rivus/agent-kit/node";
import { Effect, Layer } from "effect";
import * as z from "zod/mini";
import { describe, expect, it } from "vite-plus/test";

import { SnorlaxPlatform } from "../../modules/platform/platform.ts";
import { Secrets, storeProgramMissingNotice } from "./secrets.ts";

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
    items[account] = stdin;
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

  it("reports a missing security binary instead of an absent item and does not call /usr/bin/security", async () => {
    const home = await mkdtemp(join(tmpdir(), "snorlax-keychain-missing-"));
    const missing = join(home, "missing-security");
    try {
      const base = createNodePlatform({
        home,
        env: { PATH: "/usr/bin:/bin", SNORLAX_SECURITY: missing }
      });
      const spawned: string[] = [];
      const platform = {
        ...base,
        process: {
          ...base.process,
          spawn: ((command: string, args: readonly string[], options: Parameters<typeof base.process.spawn>[2]) => {
            spawned.push(command);
            if (command === "/usr/bin/security") {
              throw new Error("refused /usr/bin/security");
            }
            return base.process.spawn(command, args, options);
          }) as typeof base.process.spawn
        }
      };
      const provide = Layer.provide(Secrets.keychain, Layer.succeed(SnorlaxPlatform, platform));
      const read = await Effect.runPromise(
        Effect.flip(
          Effect.gen(function* () {
            return yield* (yield* Secrets).read(DEVICE);
          }).pipe(Effect.provide(provide))
        )
      );
      expect(read._tag).toBe("StoreBinaryMissing");
      if (read._tag !== "StoreBinaryMissing") {
        return;
      }
      expect(read.command).toBe(missing);
      expect(storeProgramMissingNotice(read.command)).toContain(missing);
      expect(read.message).not.toContain(TOKEN);
      const removed = await Effect.runPromise(
        Effect.flip(
          Effect.gen(function* () {
            return yield* (yield* Secrets).delete(DEVICE);
          }).pipe(Effect.provide(provide))
        )
      );
      expect(removed._tag).toBe("StoreBinaryMissing");
      if (removed._tag !== "StoreBinaryMissing") {
        return;
      }
      expect(removed.command).toBe(missing);
      const stored = await Effect.runPromise(
        Effect.flip(
          Effect.gen(function* () {
            return yield* (yield* Secrets).store(DEVICE, TOKEN);
          }).pipe(Effect.provide(provide))
        )
      );
      expect(stored._tag).toBe("KeychainUnavailable");
      expect(stored.message).toContain("missing-security");
      expect(stored.message).not.toContain("/usr/bin/security");
      expect(stored.message).not.toContain(TOKEN);
      expect(spawned.every((command) => command === missing)).toBe(true);
      expect(spawned).not.toContain("/usr/bin/security");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("stays unavailable when the security path exists but is not a program", async () => {
    const home = await mkdtemp(join(tmpdir(), "snorlax-keychain-not-a-program-"));
    try {
      const platform = createNodePlatform({
        home,
        env: { PATH: "/usr/bin:/bin", SNORLAX_SECURITY: home }
      });
      const error = await Effect.runPromise(
        Effect.flip(
          Effect.gen(function* () {
            return yield* (yield* Secrets).read(DEVICE);
          }).pipe(Effect.provide(Layer.provide(Secrets.keychain, Layer.succeed(SnorlaxPlatform, platform))))
        )
      );
      expect(error._tag).toBe("KeychainUnavailable");
      expect(error.message).not.toContain("/usr/bin/security");
      expect(error.message).toContain(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("treats a locked keychain (exit 36) as unavailable", async () => {
    const home = await mkdtemp(join(tmpdir(), "snorlax-keychain-locked-"));
    const stubPath = join(home, "security-stub");
    const locked = `#!${process.execPath}
process.stderr.write("user interaction is not allowed\\n");
process.exit(36);
`;
    try {
      await writeFile(stubPath, locked);
      await chmod(stubPath, 0o755);
      const platform = createNodePlatform({
        home,
        env: { PATH: "/usr/bin:/bin", SNORLAX_SECURITY: stubPath }
      });
      const error = await Effect.runPromise(
        Effect.flip(
          Effect.gen(function* () {
            return yield* (yield* Secrets).read(DEVICE);
          }).pipe(Effect.provide(Layer.provide(Secrets.keychain, Layer.succeed(SnorlaxPlatform, platform))))
        )
      );
      expect(error._tag).toBe("KeychainUnavailable");
      expect(error.message).toContain("36");
      expect(error.message).not.toContain(TOKEN);
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
      expect(calls[0]?.stdin).toBe(TOKEN);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("treats exit 1 with stderr as unavailable and exit 1 with empty stderr as a missing item", async () => {
    const home = await mkdtemp(join(tmpdir(), "snorlax-libsecret-down-"));
    const downPath = join(home, "secret-tool-down");
    const missingPath = join(home, "secret-tool-missing");
    const down = `#!${process.execPath}
process.stderr.write("Cannot connect to the secret service\\n");
process.exit(1);
`;
    const missing = `#!${process.execPath}
process.exit(1);
`;
    const provide = (binary: string) => {
      const platform = createNodePlatform({
        home,
        env: { PATH: "/usr/bin:/bin", SNORLAX_SECRET_TOOL: binary }
      });
      return Layer.provide(Secrets.libsecret, Layer.succeed(SnorlaxPlatform, platform));
    };
    const read = (binary: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* Secrets).read(DEVICE);
        }).pipe(Effect.provide(provide(binary)))
      );
    try {
      await writeFile(downPath, down);
      await writeFile(missingPath, missing);
      await chmod(downPath, 0o755);
      await chmod(missingPath, 0o755);
      const error = await Effect.runPromise(
        Effect.flip(
          Effect.gen(function* () {
            const secrets = yield* Secrets;
            return yield* secrets.read(DEVICE);
          }).pipe(Effect.provide(provide(downPath)))
        )
      );
      expect(error._tag).toBe("KeychainUnavailable");
      expect(error.message).toContain("Cannot connect to the secret service");
      expect(error.message).not.toContain(TOKEN);
      const cleared = await Effect.runPromise(
        Effect.flip(
          Effect.gen(function* () {
            return yield* (yield* Secrets).delete(DEVICE);
          }).pipe(Effect.provide(provide(downPath)))
        )
      );
      expect(cleared._tag).toBe("KeychainUnavailable");
      expect(await read(missingPath)).toBeUndefined();
      await Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* Secrets).delete(DEVICE);
        }).pipe(Effect.provide(provide(missingPath)))
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("reports a missing secret-tool binary instead of an absent item and does not call secret-tool", async () => {
    const home = await mkdtemp(join(tmpdir(), "snorlax-libsecret-enoent-"));
    const missing = join(home, "missing-secret-tool");
    try {
      const base = createNodePlatform({
        home,
        env: { PATH: "/usr/bin:/bin", SNORLAX_SECRET_TOOL: missing }
      });
      const spawned: string[] = [];
      const platform = {
        ...base,
        process: {
          ...base.process,
          spawn: ((command: string, args: readonly string[], options: Parameters<typeof base.process.spawn>[2]) => {
            spawned.push(command);
            if (command === "secret-tool" || command === "/usr/bin/security") {
              throw new Error(`refused ${command}`);
            }
            return base.process.spawn(command, args, options);
          }) as typeof base.process.spawn
        }
      };
      const provide = Layer.provide(Secrets.libsecret, Layer.succeed(SnorlaxPlatform, platform));
      const read = await Effect.runPromise(
        Effect.flip(
          Effect.gen(function* () {
            return yield* (yield* Secrets).read(DEVICE);
          }).pipe(Effect.provide(provide))
        )
      );
      expect(read._tag).toBe("StoreBinaryMissing");
      if (read._tag !== "StoreBinaryMissing") {
        return;
      }
      expect(read.command).toBe(missing);
      expect(storeProgramMissingNotice(read.command)).toContain("missing-secret-tool");
      expect(read.message).not.toContain(TOKEN);
      const removed = await Effect.runPromise(
        Effect.flip(
          Effect.gen(function* () {
            return yield* (yield* Secrets).delete(DEVICE);
          }).pipe(Effect.provide(provide))
        )
      );
      expect(removed._tag).toBe("StoreBinaryMissing");
      if (removed._tag !== "StoreBinaryMissing") {
        return;
      }
      expect(removed.command).toBe(missing);
      const stored = await Effect.runPromise(
        Effect.flip(
          Effect.gen(function* () {
            return yield* (yield* Secrets).store(DEVICE, TOKEN);
          }).pipe(Effect.provide(provide))
        )
      );
      expect(stored._tag).toBe("KeychainUnavailable");
      expect(stored.message).toContain("missing-secret-tool");
      expect(stored.message).not.toContain(TOKEN);
      expect(spawned.every((command) => command === missing)).toBe(true);
      expect(spawned).not.toContain("secret-tool");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
