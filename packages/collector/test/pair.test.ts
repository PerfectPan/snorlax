import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { failureSchema, httpPushRequestSchema, okSchema, pairResultSchema } from "@rivus/snorlax-protocol";
import { createApp } from "@rivus/snorlax-worker";
import { createSqliteD1 } from "@rivus/snorlax-worker/sqlite-d1";
import { Effect, Layer } from "effect";
import * as z from "zod/mini";
import { describe, expect, it } from "vite-plus/test";

import { Backend, type BackendFetch } from "../src/capabilities/backend/backend.ts";
import { Secrets } from "../src/capabilities/secrets/secrets.ts";
import { CliEnv } from "../src/cli/env.ts";
import { runCli } from "../src/cli/run.ts";
import { configSchema } from "../src/modules/config/config.ts";
import { NodeFiles, SnorlaxPlatform } from "../src/modules/platform/platform.ts";
import { TimeZone } from "../src/modules/time-zone/time-zone.ts";
import { quietMtime, writeClaudeSession } from "./fixtures/agents.ts";
import { createRefreshSetup, type RefreshSetup, type TestPlatform } from "./fixtures/platform.ts";
import { fakeScheduler } from "./fixtures/scheduler.ts";
import { writeSecretStubs } from "./fixtures/secret-stubs.ts";

/**
 * `pair` and `unpair` through the CLI, a stub `security`, and the Worker app on an in-memory D1.
 * Nothing here starts `/usr/bin/security` or contacts a deployed Worker.
 */

const ADMIN = "admin-token-not-a-device-token";
const BASE = "https://snorlax.test";
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const OLD_HOUR = Date.UTC(2026, 9, 20, 0) / 1000;
const TIME_ZONE = "UTC";
const PLANT = "00000000-0000-4000-8000-000000000099";
const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../worker/migrations/0001_init.sql", import.meta.url)),
  "utf8"
);

const countSchema = z.object({ n: z.number() });
const hourSchema = z.object({ hour: z.number() });
const deviceSchema = z.object({ device_id: z.string() });
const invocationSchema = z.object({ argv: z.array(z.string()), stdin: z.string() });
const storeSchema = z.record(z.string(), z.string());

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: string | null;
}

const createCapture = () => {
  const chunks: string[] = [];
  return { chunks, sink: { write: (text: string): void => void chunks.push(text) } };
};

const createLab = (fail: "put" | "register" | undefined) => {
  const database = new DatabaseSync(":memory:");
  database.exec(MIGRATION);
  const app = createApp({ db: createSqliteD1(database), adminToken: ADMIN, now: () => NOW });
  const requests: Recorded[] = [];
  const fetchImpl: BackendFetch = async (request) => {
    const text = request.method === "GET" || request.method === "DELETE" ? null : await request.text();
    requests.push({ method: request.method, url: request.url, body: text });
    const path = new URL(request.url).pathname;
    if (fail === "register" && request.method === "POST" && path === "/v1/devices") {
      throw new Error("backend down");
    }
    if (fail === "put" && request.method === "PUT") {
      throw new Error("push failed");
    }
    return app.fetch(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: text ?? undefined,
        signal: request.signal
      })
    );
  };
  return { database, fetchImpl, requests };
};

const withDb = <A>(dataDir: string, readOnly: boolean, body: (db: DatabaseSync) => A): A => {
  const db = new DatabaseSync(join(dataDir, "ledger.db"), { readOnly, timeout: 200 });
  try {
    return body(db);
  } finally {
    db.close();
  }
};

const countRows = (dataDir: string, sql: string): number =>
  withDb(dataDir, true, (db) => z.parse(countSchema, db.prepare(sql).get()).n);

const deviceIdOf = (dataDir: string): string =>
  withDb(
    dataDir,
    true,
    (db) => z.parse(deviceSchema, db.prepare("SELECT device_id FROM meta WHERE id = 0").get()).device_id
  );

const bucketHours = (dataDir: string): number[] =>
  withDb(dataDir, true, (db) =>
    db
      .prepare("SELECT hour FROM buckets")
      .all()
      .map((row) => z.parse(hourSchema, row).hour)
  );

const clearDirty = (dataDir: string): void => {
  withDb(dataDir, false, (db) => {
    db.prepare("UPDATE buckets SET dirty = 0").run();
  });
};

const plantRemote = (dataDir: string): void => {
  withDb(dataDir, false, (db) => {
    db.prepare(
      `INSERT INTO remote_buckets (
         device_id, hour, agent, model,
         input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens,
         requests, sessions_started, cost_usd, unpriced_requests, seq
       ) VALUES (?, ?, 'claude-code', 'planted', 1, 0, 0, 1, 0, 1, 0, 0, 0, 1)`
    ).run(PLANT, OLD_HOUR);
    db.prepare("INSERT INTO remote_devices (id, name, last_push_at, revoked) VALUES (?, 'Planted', NULL, 0)").run(
      PLANT
    );
  });
};

const readConfigFile = async (dataDir: string) => {
  const path = join(dataDir, "config.json");
  if (!existsSync(path)) {
    return undefined;
  }
  return z.parse(configSchema, JSON.parse(await readFile(path, "utf8")));
};

const treeText = async (root: string): Promise<string> => {
  if (!existsSync(root)) {
    return "";
  }
  const parts: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(path);
        continue;
      }
      parts.push(await readFile(path, "utf8"));
    }
  };
  await walk(root);
  return parts.join("\n");
};

const readInvocations = async (logPath: string) => {
  const text = await readFile(logPath, "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => z.parse(invocationSchema, JSON.parse(line)));
};

const readStore = async (storePath: string): Promise<Record<string, string>> => {
  if (!existsSync(storePath)) {
    return {};
  }
  return z.parse(storeSchema, JSON.parse(await readFile(storePath, "utf8")));
};

const pushedHours = (requests: readonly Recorded[]): number[] =>
  requests
    .filter((request) => request.method === "PUT")
    .flatMap((request) => {
      const parsed = z.safeParse(httpPushRequestSchema, JSON.parse(request.body ?? ""));
      return parsed.success ? parsed.data.buckets.map((bucket) => bucket.hour) : [];
    });

interface Harness {
  readonly setup: RefreshSetup;
  readonly env: Record<string, string>;
  readonly requests: Recorded[];
  readonly logPath: string;
  readonly storePath: string;
  readonly fetchImpl: BackendFetch;
  readonly run: (
    args: readonly string[],
    stdin?: string
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  readonly close: () => Promise<void>;
}

const open = async (fail?: "put" | "register"): Promise<Harness> => {
  const lab = createLab(fail);
  const setup = await createRefreshSetup({ now: NOW });
  const stubDir = join(setup.home, "stub");
  await mkdir(stubDir);
  const stubs = await writeSecretStubs(stubDir);
  const env: Record<string, string> = {
    ...setup.platform.env,
    PATH: "/usr/bin:/bin",
    SNORLAX_HOME: setup.dataDir,
    SNORLAX_SECURITY: stubs.security,
    STUB_LOG: stubs.logPath,
    STUB_STORE: stubs.storePath
  };
  const platform: TestPlatform = { ...setup.platform, env };
  const run = async (args: readonly string[], stdin?: string) => {
    const out = createCapture();
    const err = createCapture();
    const platformLayer = Layer.succeed(SnorlaxPlatform, platform);
    const exit = await Effect.runPromise(
      Effect.flip(
        runCli(
          args,
          Layer.mergeAll(
            platformLayer,
            NodeFiles.live,
            fakeScheduler([], { jobFile: join(setup.home, "job") }),
            Layer.succeed(
              CliEnv,
              CliEnv.of({
                stdout: out.sink,
                stderr: err.sink,
                colors: false,
                ...(stdin === undefined ? {} : { stdin })
              })
            ),
            Backend.layer(lab.fetchImpl),
            Layer.succeed(TimeZone, TIME_ZONE),
            Layer.provide(Secrets.keychain, platformLayer)
          )
        )
      )
    );
    return { exitCode: exit.exitCode, stdout: out.chunks.join(""), stderr: err.chunks.join("") };
  };
  return {
    setup,
    env,
    requests: lab.requests,
    logPath: stubs.logPath,
    storePath: stubs.storePath,
    fetchImpl: lab.fetchImpl,
    run,
    close: async () => {
      lab.database.close();
      await setup.remove();
    }
  };
};

const writeOldUsage = (home: string) =>
  writeClaudeSession(home, {
    sessionId: "pair-old",
    mtimeMs: quietMtime(NOW),
    requests: [
      {
        requestId: "pair-old-1",
        model: "claude-haiku-4-5",
        timestampMs: OLD_HOUR * 1000,
        usage: { inputTokens: 10, outputTokens: 1 }
      }
    ]
  });

/** A scanned ledger with the old hour cleared and one remote row, so pair has something it must not touch on failure. */
const prepareLedger = async (harness: Harness): Promise<void> => {
  await writeOldUsage(harness.setup.home);
  const refreshed = await harness.run(["refresh", "--json"]);
  expect(refreshed.exitCode).toBe(0);
  expect(bucketHours(harness.setup.dataDir)).toContain(OLD_HOUR);
  clearDirty(harness.setup.dataDir);
  plantRemote(harness.setup.dataDir);
};

const pairingUnchanged = async (harness: Harness): Promise<void> => {
  const config = await readConfigFile(harness.setup.dataDir);
  expect(config?.backendUrl).toBeUndefined();
  expect(await readStore(harness.storePath)).toEqual({});
  expect(countRows(harness.setup.dataDir, "SELECT COUNT(*) AS n FROM buckets WHERE dirty != 0")).toBe(0);
  expect(
    countRows(harness.setup.dataDir, `SELECT COUNT(*) AS n FROM remote_buckets WHERE device_id = '${PLANT}'`)
  ).toBe(1);
};

const registerAgain = (harness: Harness, deviceId: string) =>
  harness.fetchImpl(
    new Request(`${BASE}/v1/devices`, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify({ deviceId, name: "Desk" })
    })
  );

describe("pair", () => {
  it("stores the token on security stdin, marks every bucket dirty, clears remote rows, and pushes", async () => {
    const harness = await open();
    try {
      await prepareLedger(harness);
      const paired = await harness.run(["pair", "--url", BASE, "--name", "Desk", "--json"], `${ADMIN}\r\n`);
      expect(paired.stderr).toBe("");
      expect(paired.exitCode).toBe(0);
      const payload = z.parse(pairResultSchema, JSON.parse(paired.stdout));
      expect(Object.keys(JSON.parse(paired.stdout)).sort()).toEqual(["deviceId", "name", "ok", "schemaVersion"]);
      const deviceId = deviceIdOf(harness.setup.dataDir);
      expect(payload).toEqual({ schemaVersion: 1, ok: true, deviceId, name: "Desk" });
      expect(await readConfigFile(harness.setup.dataDir)).toEqual({ backendUrl: BASE, deviceName: "Desk" });

      const calls = await readInvocations(harness.logPath);
      const store = calls.find((call) => call.stdin.includes("add-generic-password"));
      const token = (await readStore(harness.storePath))[deviceId];
      expect(token).toBeDefined();
      expect(store?.argv.slice(2)).toEqual(["-i"]);
      expect(store?.stdin).toContain(`-w ${token}`);
      for (const call of calls) {
        for (const arg of call.argv) {
          expect(arg).not.toContain(token);
          expect(arg).not.toContain(ADMIN);
        }
        expect(call.stdin).not.toContain(ADMIN);
      }
      expect(pushedHours(harness.requests)).toContain(OLD_HOUR);
      expect(
        countRows(harness.setup.dataDir, `SELECT COUNT(*) AS n FROM remote_buckets WHERE device_id = '${PLANT}'`)
      ).toBe(0);

      const written = await treeText(harness.setup.dataDir);
      expect(written).not.toContain(ADMIN);
      expect(paired.stdout).not.toContain(ADMIN);
      expect(paired.stderr).not.toContain(ADMIN);
    } finally {
      await harness.close();
    }
  });

  it("rejects a wrong admin token and leaves the ledger, config, and remote rows alone", async () => {
    const harness = await open();
    try {
      await prepareLedger(harness);
      const failed = await harness.run(["pair", "--url", BASE, "--name", "Desk", "--json"], "wrong-admin-token\n");
      expect(failed.exitCode).toBe(1);
      expect(z.parse(failureSchema, JSON.parse(failed.stdout)).error.code).toBe("unauthorized");
      await pairingUnchanged(harness);
      expect(failed.stdout).not.toContain(ADMIN);
      expect(failed.stderr).not.toContain(ADMIN);
      expect(await treeText(harness.setup.dataDir)).not.toContain(ADMIN);
    } finally {
      await harness.close();
    }
  });

  it("maps a registered device to conflict and changes nothing else", async () => {
    const harness = await open();
    try {
      await prepareLedger(harness);
      const deviceId = deviceIdOf(harness.setup.dataDir);
      expect((await registerAgain(harness, deviceId)).status).toBe(201);
      const failed = await harness.run(["pair", "--url", BASE, "--name", "Desk", "--json"], `${ADMIN}\n`);
      expect(failed.exitCode).toBe(1);
      const error = z.parse(failureSchema, JSON.parse(failed.stdout)).error;
      expect(error.code).toBe("conflict");
      expect(error.message).toContain(`device ${deviceId} is already registered`);
      expect(error.message).toContain("admin token");
      await pairingUnchanged(harness);
    } finally {
      await harness.close();
    }
  });

  it("rejects an illegal URL before creating the data directory", async () => {
    const harness = await open();
    try {
      await rm(harness.setup.dataDir, { recursive: true, force: true });
      const failed = await harness.run(
        ["pair", "--url", "http://example.com", "--name", "Desk", "--json"],
        `${ADMIN}\n`
      );
      expect(failed.exitCode).toBe(2);
      expect(z.parse(failureSchema, JSON.parse(failed.stdout)).error.code).toBe("invalid-arguments");
      expect(existsSync(harness.setup.dataDir)).toBe(false);
      expect(failed.stdout).not.toContain(ADMIN);
    } finally {
      await harness.close();
    }
  });

  it("rejects an empty admin token before creating the data directory", async () => {
    const harness = await open();
    try {
      await rm(harness.setup.dataDir, { recursive: true, force: true });
      const failed = await harness.run(["pair", "--url", BASE, "--name", "Desk", "--json"], "\n");
      expect(failed.exitCode).toBe(2);
      const error = z.parse(failureSchema, JSON.parse(failed.stdout)).error;
      expect(error.code).toBe("invalid-arguments");
      expect(error.message).toContain("empty");
      expect(existsSync(harness.setup.dataDir)).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("reports keychain when the token cannot be stored after the device was registered", async () => {
    const harness = await open();
    try {
      await prepareLedger(harness);
      const deviceId = deviceIdOf(harness.setup.dataDir);
      harness.env.STUB_FAIL_STORE = "1";
      const failed = await harness.run(["pair", "--url", BASE, "--name", "Desk", "--json"], `${ADMIN}\n`);
      expect(failed.exitCode).toBe(1);
      const error = z.parse(failureSchema, JSON.parse(failed.stdout)).error;
      expect(error.code).toBe("keychain");
      expect(error.message).toContain("already registered");
      expect(error.message).toContain("admin token");
      await pairingUnchanged(harness);
      expect((await registerAgain(harness, deviceId)).status).toBe(409);
      expect(failed.stdout).not.toContain(ADMIN);
      expect(await treeText(harness.setup.dataDir)).not.toContain(ADMIN);
    } finally {
      await harness.close();
    }
  });

  it("exits 0 when the refresh after a successful pair cannot push", async () => {
    const harness = await open("put");
    try {
      await writeOldUsage(harness.setup.home);
      const paired = await harness.run(["pair", "--url", BASE, "--name", "Desk", "--json"], `${ADMIN}\n`);
      expect(paired.exitCode).toBe(0);
      const payload = z.parse(pairResultSchema, JSON.parse(paired.stdout));
      expect(payload.name).toBe("Desk");
      expect(Object.keys(JSON.parse(paired.stdout)).sort()).toEqual(["deviceId", "name", "ok", "schemaVersion"]);
      const log = await readFile(join(harness.setup.dataDir, "logs", "snorlax.log"), "utf8");
      expect(log).toContain('"sync":"failed"');
      expect(log).not.toContain(ADMIN);
      expect(paired.stdout).not.toContain(ADMIN);

      const human = await open("put");
      try {
        await writeOldUsage(human.setup.home);
        const text = await human.run(["pair", "--url", BASE, "--name", "Desk"], `${ADMIN}\n`);
        expect(text.exitCode).toBe(0);
        expect(text.stdout).toContain("sync: failed");
        expect(text.stdout).toContain("paired Desk");
        expect(text.stdout).not.toContain(ADMIN);
        expect(text.stderr).not.toContain(ADMIN);
      } finally {
        await human.close();
      }
    } finally {
      await harness.close();
    }
  });

  it("reports network and leaves the pairing unchanged when registration cannot connect", async () => {
    const harness = await open("register");
    try {
      await prepareLedger(harness);
      const failed = await harness.run(["pair", "--url", BASE, "--name", "Desk", "--json"], `${ADMIN}\n`);
      expect(failed.exitCode).toBe(1);
      const error = z.parse(failureSchema, JSON.parse(failed.stdout)).error;
      expect(error.code).toBe("network");
      await pairingUnchanged(harness);
      expect(await treeText(harness.setup.dataDir)).not.toContain(ADMIN);
    } finally {
      await harness.close();
    }
  });
});

describe("unpair", () => {
  it("deletes the token, drops backendUrl, keeps the name and local buckets, and clears remote rows", async () => {
    const harness = await open();
    try {
      await prepareLedger(harness);
      const localBefore = countRows(harness.setup.dataDir, "SELECT COUNT(*) AS n FROM buckets");
      const paired = await harness.run(["pair", "--url", BASE, "--name", "Desk", "--json"], `${ADMIN}\n`);
      expect(paired.exitCode).toBe(0);
      plantRemote(harness.setup.dataDir);
      const text = await harness.run(["unpair"]);
      expect(text.exitCode).toBe(0);
      expect(text.stdout).toContain("local data is kept");
      expect(text.stdout).toContain("admin token");
      expect(await readConfigFile(harness.setup.dataDir)).toEqual({ deviceName: "Desk" });
      expect(await readStore(harness.storePath)).toEqual({});
      expect(countRows(harness.setup.dataDir, "SELECT COUNT(*) AS n FROM remote_buckets")).toBe(0);
      expect(countRows(harness.setup.dataDir, "SELECT COUNT(*) AS n FROM remote_devices")).toBe(0);
      expect(countRows(harness.setup.dataDir, "SELECT COUNT(*) AS n FROM buckets")).toBe(localBefore);
      const calls = await readInvocations(harness.logPath);
      expect(
        calls.some((call) => call.stdin.includes("delete-generic-password") && call.argv.slice(2).join(" ") === "-i")
      ).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it("succeeds when nothing is paired and creates no data directory", async () => {
    const harness = await open();
    try {
      await rm(harness.setup.dataDir, { recursive: true, force: true });
      const text = await harness.run(["unpair", "--json"]);
      expect(text.exitCode).toBe(0);
      expect(z.parse(okSchema, JSON.parse(text.stdout)).ok).toBe(true);
      expect(existsSync(harness.setup.dataDir)).toBe(false);
    } finally {
      await harness.close();
    }
  });

  it("changes nothing else when the keychain delete fails", async () => {
    const harness = await open();
    try {
      await prepareLedger(harness);
      const paired = await harness.run(["pair", "--url", BASE, "--name", "Desk", "--json"], `${ADMIN}\n`);
      expect(paired.exitCode).toBe(0);
      const deviceId = deviceIdOf(harness.setup.dataDir);
      plantRemote(harness.setup.dataDir);
      harness.env.STUB_FAIL_DELETE = "1";
      const failed = await harness.run(["unpair", "--json"]);
      expect(failed.exitCode).toBe(1);
      expect(z.parse(failureSchema, JSON.parse(failed.stdout)).error.code).toBe("keychain");
      expect(await readConfigFile(harness.setup.dataDir)).toEqual({ backendUrl: BASE, deviceName: "Desk" });
      expect((await readStore(harness.storePath))[deviceId]).toBeDefined();
      expect(
        countRows(harness.setup.dataDir, `SELECT COUNT(*) AS n FROM remote_buckets WHERE device_id = '${PLANT}'`)
      ).toBe(1);
    } finally {
      await harness.close();
    }
  });
});
