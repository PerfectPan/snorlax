import { readFileSync } from "node:fs";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  httpDeviceRegisterRequestSchema,
  httpDeviceRegisterResponseSchema,
  httpPushRequestSchema,
  refreshResultSchema
} from "@rivus/snorlax-protocol";
import { createApp } from "@rivus/snorlax-worker";
import { createSqliteD1 } from "@rivus/snorlax-worker/sqlite-d1";
import { Effect, Layer } from "effect";
import * as z from "zod/mini";
import { describe, expect, it } from "vite-plus/test";

import { Backend, pairedSync, PUSH_BATCH, type BackendFetch } from "../src/capabilities/backend/backend.ts";
import { rebuildFlow } from "../src/commands/rebuild/flow.ts";
import { refreshFlow } from "../src/commands/refresh/flow.ts";
import { CliEnv } from "../src/cli/env.ts";
import { runCli } from "../src/cli/run.ts";
import { refreshScan, scanAndCommit } from "../src/modules/ledger/ledger.ts";
import type { Logger } from "../src/modules/log/log.ts";
import { NodeFiles, SnorlaxPlatform } from "../src/modules/platform/platform.ts";
import { readSnapshotFile } from "../src/modules/snapshot-file/snapshot-file.ts";
import { Secrets } from "../src/capabilities/secrets/secrets.ts";
import { TimeZone } from "../src/modules/time-zone/time-zone.ts";
import { quietMtime, writeClaudeSession, type UsageCounts } from "./fixtures/agents.ts";
import { readLedger } from "./fixtures/flows.ts";
import { createRefreshSetup, type RefreshSetup } from "./fixtures/platform.ts";
import { fakeScheduler } from "./fixtures/scheduler.ts";

/**
 * Two collectors and one in-memory Worker (plan 3.2.4, Spec S6–S8, S15). Homes are temporary and the logs
 * are generated fixtures. The fetch is the Worker's own app; nothing here contacts a deployed Worker or a
 * real keychain.
 */

const ADMIN = "test-admin-token-do-not-use";
const BASE = "https://snorlax.test/";
const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const TIME_ZONE = "Asia/Shanghai";
const MIGRATION = readFileSync(
  fileURLToPath(new URL("../../worker/migrations/0001_init.sql", import.meta.url)),
  "utf8"
);

const countSchema = z.object({ n: z.number() });
const deviceSchema = z.object({ device_id: z.string() });
const silentLog: Logger = { event: () => Effect.void };

interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: string | null;
}

interface ForcedPut {
  readonly status: number;
  readonly body: unknown;
}

interface PullPage {
  readonly buckets: readonly unknown[];
  readonly next: number | null;
}

const countDirty = (dataDir: string): number => {
  const db = new DatabaseSync(join(dataDir, "ledger.db"), { readOnly: true, timeout: 200 });
  try {
    return z.parse(countSchema, db.prepare("SELECT COUNT(*) AS n FROM buckets WHERE dirty != 0").get()).n;
  } finally {
    db.close();
  }
};

const createLab = () => {
  const database = new DatabaseSync(":memory:");
  database.exec(MIGRATION);
  const app = createApp({ db: createSqliteD1(database), adminToken: ADMIN, now: () => NOW });
  const requests: Recorded[] = [];
  const dirtyDuringPush: number[] = [];
  const dirs = new Map<string, string>();
  let down = false;
  let forced: ForcedPut | undefined;
  let pullPage: ((after: number, seen: number) => PullPage | undefined) | undefined;
  let pullSeen = 0;
  const fetchImpl: BackendFetch = async (request) => {
    const text = request.method === "GET" || request.method === "DELETE" ? null : await request.text();
    requests.push({ method: request.method, url: request.url, body: text });
    if (pullPage !== undefined && request.method === "GET" && new URL(request.url).pathname.endsWith("/v1/buckets")) {
      pullSeen += 1;
      const after = Number(new URL(request.url).searchParams.get("after") ?? "0");
      const page = pullPage(after, pullSeen);
      if (page !== undefined) {
        return new Response(JSON.stringify(page), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
    }
    if (request.method === "PUT") {
      const deviceId = decodeURIComponent(new URL(request.url).pathname.split("/")[3] ?? "");
      const dataDir = dirs.get(deviceId);
      if (dataDir !== undefined) {
        dirtyDuringPush.push(countDirty(dataDir));
      }
    }
    if (down) {
      throw new Error("backend down");
    }
    if (forced !== undefined && request.method === "PUT") {
      return new Response(JSON.stringify(forced.body), {
        status: forced.status,
        headers: { "content-type": "application/json" }
      });
    }
    return Promise.resolve(
      app.fetch(
        new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: text ?? undefined,
          signal: request.signal
        })
      )
    );
  };
  return {
    database,
    fetchImpl,
    requests,
    dirtyDuringPush,
    noteDevice: (deviceId: string, dataDir: string) => dirs.set(deviceId, dataDir),
    setDown: (value: boolean) => {
      down = value;
    },
    setForcedPut: (value: ForcedPut | undefined) => {
      forced = value;
    },
    setPullPage: (value: ((after: number, seen: number) => PullPage | undefined) | undefined) => {
      pullPage = value;
      pullSeen = 0;
    }
  };
};

const usage = (inputTokens: number, outputTokens: number): UsageCounts => ({ inputTokens, outputTokens });

describe("collector sync", () => {
  const open = async () => {
    const lab = createLab();
    const tokens = new Map<string, string>();
    const setups: RefreshSetup[] = [];
    const platformFor = (setup: RefreshSetup) => ({
      ...setup.platform,
      env: { ...setup.platform.env, SNORLAX_HOME: setup.dataDir, PATH: "/usr/bin:/bin" }
    });
    const layerFor = (setup: RefreshSetup) => {
      const platform = platformFor(setup);
      return Layer.mergeAll(
        Layer.succeed(SnorlaxPlatform, platform),
        NodeFiles.live,
        Secrets.memory(platform.env, tokens),
        Backend.layer(lab.fetchImpl),
        Layer.succeed(TimeZone, TIME_ZONE)
      );
    };
    const run = (setup: RefreshSetup) => Effect.runPromise(refreshFlow.pipe(Effect.provide(layerFor(setup))));
    const pair = async (homeRequests: { hour: number; inputTokens: number; outputTokens: number }[], name: string) => {
      const setup = await createRefreshSetup({ now: NOW });
      setups.push(setup);
      if (homeRequests.length > 0) {
        await writeClaudeSession(setup.home, {
          sessionId: `session-${name}`,
          mtimeMs: quietMtime(NOW),
          requests: homeRequests.map((request, index) => ({
            requestId: `${name}-${index}`,
            model: "claude-haiku-4-5",
            timestampMs: request.hour * 1000,
            usage: usage(request.inputTokens, request.outputTokens)
          }))
        });
      }
      await run(setup);
      const db = new DatabaseSync(join(setup.dataDir, "ledger.db"), { readOnly: true });
      let deviceId: string;
      try {
        deviceId = z.parse(deviceSchema, db.prepare("SELECT device_id FROM meta WHERE id = 0").get()).device_id;
      } finally {
        db.close();
      }
      lab.noteDevice(deviceId, setup.dataDir);
      const response = await lab.fetchImpl(
        new Request(`${BASE}v1/devices`, {
          method: "POST",
          headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
          body: JSON.stringify({ deviceId, name })
        })
      );
      const json: unknown = await response.json();
      const registered = z.parse(httpDeviceRegisterResponseSchema, json);
      expect(response.status).toBe(201);
      tokens.set(deviceId, registered.deviceToken);
      await writeFile(join(setup.dataDir, "config.json"), JSON.stringify({ backendUrl: BASE, deviceName: name }));
      return { setup, deviceId, platform: platformFor(setup) };
    };
    const close = async () => {
      lab.database.close();
      await Promise.all(setups.map((setup) => setup.remove()));
    };
    return { lab, tokens, run, pair, layerFor, platformFor, close };
  };

  const snapshotOf = async (setup: RefreshSetup) => {
    const read = await readSnapshotFile(setup.platform, setup.dataDir);
    if (read.kind !== "ok") {
      throw new Error(`snapshot was ${read.kind}`);
    }
    return read.snapshot;
  };

  it("S6: each snapshot shows the other device's buckets", async () => {
    const harness = await open();
    try {
      const hour9 = Date.UTC(2026, 9, 22, 9) / 1000;
      const hour10 = Date.UTC(2026, 9, 22, 10) / 1000;
      const alpha = await harness.pair([{ hour: hour9, inputTokens: 1000, outputTokens: 100 }], "Alpha");
      const beta = await harness.pair([{ hour: hour10, inputTokens: 50, outputTokens: 5 }], "Beta");
      await harness.run(alpha.setup);
      await harness.run(beta.setup);
      const synced = await harness.run(alpha.setup);

      expect(synced.result.sync.state).toBe("ok");
      expect(synced.result.sync.ok).toBe(true);
      expect(harness.lab.dirtyDuringPush.length).toBeGreaterThan(0);
      expect(harness.lab.dirtyDuringPush.every((count) => count > 0)).toBe(true);

      const alphaSnap = await snapshotOf(alpha.setup);
      const betaSnap = await snapshotOf(beta.setup);
      expect(alphaSnap.totals.today.tokens).toBe(1155);
      expect(betaSnap.totals.today.tokens).toBe(1155);
      const byName = (names: readonly (string | null)[]): (string | null)[] =>
        [...names].sort((left, right) => String(left).localeCompare(String(right)));
      expect(byName(alphaSnap.byDevice.map((device) => device.name))).toEqual(["Alpha", "Beta"]);
      expect(byName(betaSnap.byDevice.map((device) => device.name))).toEqual(["Alpha", "Beta"]);
      expect(alphaSnap.byDevice.find((device) => device.deviceId === alpha.deviceId)?.today.tokens).toBe(1100);
      expect(alphaSnap.byDevice.find((device) => device.deviceId === beta.deviceId)?.today.tokens).toBe(55);
      expect(alphaSnap.status.paired).toBe(true);
      expect(alphaSnap.status.sync.state).toBe("ok");
      expect(alphaSnap.byDevice.find((device) => device.isThisDevice)?.lastPushAt).toBe(new Date(NOW).toISOString());

      const log = await readFile(join(alpha.setup.dataDir, "logs", "snorlax.log"), "utf8");
      expect(log).toContain(`"pushed":${synced.result.sync.pushed},"pulled":${synced.result.sync.pulled},"sync":"ok"`);

      const stdout: string[] = [];
      const exit = await Effect.runPromise(
        Effect.flip(
          runCli(
            ["refresh"],
            Layer.mergeAll(
              harness.layerFor(alpha.setup),
              fakeScheduler([], { jobFile: join(alpha.setup.home, "job") }),
              Layer.succeed(
                CliEnv,
                CliEnv.of({
                  stdout: { write: (text) => void stdout.push(text) },
                  stderr: { write: () => undefined },
                  colors: false
                })
              )
            )
          )
        )
      );
      expect(exit.exitCode).toBe(0);
      expect(stdout.join("")).toContain("sync: ok, pushed");
    } finally {
      await harness.close();
    }
  });

  it("S7: an unreachable backend keeps the scan and the dirty rows, and the next refresh uploads them", async () => {
    const harness = await open();
    try {
      const hour9 = Date.UTC(2026, 9, 22, 9) / 1000;
      const alpha = await harness.pair([{ hour: hour9, inputTokens: 1000, outputTokens: 100 }], "Alpha");
      const beta = await harness.pair([], "Beta");
      harness.lab.setDown(true);
      let dirty = 0;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const failed = await harness.run(alpha.setup);
        expect(failed.result.sync).toMatchObject({ ok: false, state: "failed", pushed: 0 });
        expect(failed.result.sync.message).toContain("backend down");
        const count = countDirty(alpha.setup.dataDir);
        if (attempt === 0) {
          dirty = count;
        }
        expect(count).toBe(dirty);
        expect((await snapshotOf(alpha.setup)).totals.today.tokens).toBe(1100);
      }
      expect((await snapshotOf(beta.setup)).totals.today.tokens).toBe(0);
      expect(await readFile(join(alpha.setup.dataDir, "logs", "snorlax.log"), "utf8")).toContain("backend down");

      harness.lab.setDown(false);
      const recovered = await harness.run(alpha.setup);
      expect(recovered.result.sync.state).toBe("ok");
      expect(recovered.result.sync.pushed).toBe(dirty);
      expect(z.parse(countSchema, harness.lab.database.prepare("SELECT COUNT(*) AS n FROM buckets").get()).n).toBe(1);
      await harness.run(beta.setup);
      expect((await snapshotOf(beta.setup)).totals.today.tokens).toBe(1100);
      expect(countDirty(alpha.setup.dataDir)).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("S8: pushing again is harmless, and markAllDirty plus resetRemote upload and pull the same totals", async () => {
    const harness = await open();
    try {
      const hour9 = Date.UTC(2026, 9, 22, 9) / 1000;
      const hour10 = Date.UTC(2026, 9, 22, 10) / 1000;
      const alpha = await harness.pair([{ hour: hour9, inputTokens: 1000, outputTokens: 100 }], "Alpha");
      const beta = await harness.pair([{ hour: hour10, inputTokens: 50, outputTokens: 5 }], "Beta");
      const serverRows = (): number =>
        z.parse(countSchema, harness.lab.database.prepare("SELECT COUNT(*) AS n FROM buckets").get()).n;
      await harness.run(alpha.setup);
      await harness.run(beta.setup);
      await harness.run(alpha.setup);
      const before = (await snapshotOf(alpha.setup)).totals.today.tokens;
      expect((await snapshotOf(beta.setup)).totals.today.tokens).toBe(before);
      expect(serverRows()).toBe(2);

      await harness.run(alpha.setup);
      await harness.run(beta.setup);
      expect((await snapshotOf(alpha.setup)).totals.today.tokens).toBe(before);
      expect((await snapshotOf(beta.setup)).totals.today.tokens).toBe(before);
      expect(serverRows()).toBe(2);

      await readLedger(alpha.platform, alpha.setup.dataDir, (ledger) => ledger.markAllDirty());
      const marked = await harness.run(alpha.setup);
      expect(marked.result.sync.pushed).toBeGreaterThan(0);
      expect((await snapshotOf(alpha.setup)).totals.today.tokens).toBe(before);
      expect((await snapshotOf(beta.setup)).totals.today.tokens).toBe(before);
      expect(serverRows()).toBe(2);

      const remoteBefore = await readLedger(alpha.platform, alpha.setup.dataDir, (ledger) =>
        ledger.readRemoteBuckets()
      );
      expect(remoteBefore.length).toBeGreaterThan(0);
      await readLedger(alpha.platform, alpha.setup.dataDir, (ledger) => ledger.resetRemote());
      expect(await readLedger(alpha.platform, alpha.setup.dataDir, (ledger) => ledger.readRemoteBuckets())).toEqual([]);
      expect(
        await readLedger(alpha.platform, alpha.setup.dataDir, (ledger) => Effect.succeed(ledger.meta.pullCursor))
      ).toBe(0);
      await harness.run(alpha.setup);
      expect(
        (await readLedger(alpha.platform, alpha.setup.dataDir, (ledger) => ledger.readRemoteBuckets())).length
      ).toBe(remoteBefore.length);
      expect((await snapshotOf(alpha.setup)).totals.today.tokens).toBe(before);
      expect((await snapshotOf(beta.setup)).totals.today.tokens).toBe(before);
      expect(serverRows()).toBe(2);

      const rebuilt = await Effect.runPromise(rebuildFlow(1).pipe(Effect.provide(harness.layerFor(alpha.setup))));
      expect(rebuilt.result.sync.state).toBe("ok");
      expect((await snapshotOf(alpha.setup)).totals.today.tokens).toBe(before);
      expect((await snapshotOf(beta.setup)).totals.today.tokens).toBe(before);
      expect(serverRows()).toBe(2);
      await harness.run(beta.setup);
      expect((await snapshotOf(beta.setup)).totals.today.tokens).toBe(before);
      expect(serverRows()).toBe(2);
    } finally {
      await harness.close();
    }
  });

  it("S15: request bodies match the strict schemas and carry none of the fixture secrets", async () => {
    const harness = await open();
    try {
      const setup = await createRefreshSetup({ now: NOW });
      const hour9 = Date.UTC(2026, 9, 22, 9);
      const path = await writeClaudeSession(setup.home, {
        sessionId: "PROMPT_DO_NOT_UPLOAD",
        project: "secret-project-path",
        mtimeMs: quietMtime(NOW),
        requests: [
          {
            requestId: "secret-request",
            model: "claude-haiku-4-5",
            timestampMs: hour9,
            usage: usage(10, 1)
          }
        ]
      });
      await harness.run(setup);
      const db = new DatabaseSync(join(setup.dataDir, "ledger.db"), { readOnly: true });
      let deviceId: string;
      try {
        deviceId = z.parse(deviceSchema, db.prepare("SELECT device_id FROM meta WHERE id = 0").get()).device_id;
      } finally {
        db.close();
      }
      harness.lab.noteDevice(deviceId, setup.dataDir);
      const response = await harness.lab.fetchImpl(
        new Request(`${BASE}v1/devices`, {
          method: "POST",
          headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
          body: JSON.stringify({ deviceId, name: "Secret" })
        })
      );
      const registered = z.parse(httpDeviceRegisterResponseSchema, await response.json());
      harness.tokens.set(deviceId, registered.deviceToken);
      await writeFile(join(setup.dataDir, "config.json"), JSON.stringify({ backendUrl: BASE, deviceName: "Secret" }));
      const synced = await harness.run(setup);
      expect(synced.result.sync.state).toBe("ok");

      const forbidden = ["PROMPT_DO_NOT_UPLOAD", "secret-project-path", path];
      expect(harness.lab.requests.length).toBeGreaterThan(0);
      for (const request of harness.lab.requests) {
        const haystack = `${request.url}\n${request.body ?? ""}`;
        for (const secret of forbidden) {
          expect(haystack).not.toContain(secret);
        }
        if (request.body === null) {
          continue;
        }
        const json: unknown = JSON.parse(request.body);
        if (request.method === "PUT") {
          z.parse(httpPushRequestSchema, json);
        } else if (request.method === "POST") {
          z.parse(httpDeviceRegisterRequestSchema, json);
        }
      }
      await setup.remove();
    } finally {
      await harness.close();
    }
  });

  it("maps 401 to revoked and keeps dirty rows, and maps 403 and an illegal body to failed", async () => {
    const harness = await open();
    try {
      const hour9 = Date.UTC(2026, 9, 22, 9) / 1000;
      const alpha = await harness.pair([{ hour: hour9, inputTokens: 10, outputTokens: 1 }], "Alpha");
      await harness.run(alpha.setup);
      await readLedger(alpha.platform, alpha.setup.dataDir, (ledger) => ledger.markAllDirty());
      const revokedResponse = await harness.lab.fetchImpl(
        new Request(`${BASE}v1/devices/${alpha.deviceId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${ADMIN}` }
        })
      );
      expect(revokedResponse.status).toBe(204);

      const stdout: string[] = [];
      const exit = await Effect.runPromise(
        Effect.flip(
          runCli(
            ["refresh"],
            Layer.mergeAll(
              harness.layerFor(alpha.setup),
              fakeScheduler([], { jobFile: join(alpha.setup.home, "job") }),
              Layer.succeed(
                CliEnv,
                CliEnv.of({
                  stdout: { write: (text) => void stdout.push(text) },
                  stderr: { write: () => undefined },
                  colors: false
                })
              )
            )
          )
        )
      );
      expect(exit.exitCode).toBe(0);
      expect(stdout.join("")).toContain("sync: revoked");
      const revokedSnap = await snapshotOf(alpha.setup);
      expect(revokedSnap.status.sync.state).toBe("revoked");
      expect(revokedSnap.status.sync.at).not.toBeNull();
      expect(revokedSnap.status.paired).toBe(false);
      expect(countDirty(alpha.setup.dataDir)).toBeGreaterThan(0);

      const forbidden = await open();
      try {
        const device = await forbidden.pair([{ hour: hour9, inputTokens: 10, outputTokens: 1 }], "Gamma");
        forbidden.lab.setForcedPut({ status: 403, body: { error: { code: "forbidden", message: "no" } } });
        const failed = await forbidden.run(device.setup);
        expect(failed.result.sync.state).toBe("failed");
        expect(failed.result.sync.message).toContain("HTTP 403");
        expect(await readFile(join(device.setup.dataDir, "logs", "snorlax.log"), "utf8")).toContain("HTTP 403");
        expect(countDirty(device.setup.dataDir)).toBeGreaterThan(0);
        forbidden.lab.setForcedPut({ status: 404, body: { error: { code: "not-found", message: "missing" } } });
        const missing = await forbidden.run(device.setup);
        expect(missing.result.sync.state).toBe("failed");
        expect(missing.result.sync.message).toContain("HTTP 404");
        forbidden.lab.setForcedPut({ status: 200, body: { nope: true } });
        await readLedger(device.platform, device.setup.dataDir, (ledger) => ledger.markAllDirty());
        const invalid = await forbidden.run(device.setup);
        expect(invalid.result.sync.state).toBe("failed");
        expect(invalid.result.sync.message).toContain("does not match");
        expect((await snapshotOf(device.setup)).status.paired).toBe(true);
      } finally {
        await forbidden.close();
      }
    } finally {
      await harness.close();
    }
  });

  it("pushes more than 200 rows in batches and follows pull next", async () => {
    const harness = await open();
    const setup = await createRefreshSetup({ now: NOW });
    try {
      await writeClaudeSession(setup.home, {
        sessionId: "batch",
        mtimeMs: quietMtime(NOW),
        requests: Array.from({ length: PUSH_BATCH + 1 }, (_, index) => ({
          requestId: `batch-${index}`,
          model: "claude-haiku-4-5",
          timestampMs: NOW - 60_000 - index * 3_600_000,
          usage: usage(1, 1)
        }))
      });
      await harness.run(setup);
      const db = new DatabaseSync(join(setup.dataDir, "ledger.db"), { readOnly: true });
      let deviceId: string;
      try {
        deviceId = z.parse(deviceSchema, db.prepare("SELECT device_id FROM meta WHERE id = 0").get()).device_id;
      } finally {
        db.close();
      }
      harness.lab.noteDevice(deviceId, setup.dataDir);
      const response = await harness.lab.fetchImpl(
        new Request(`${BASE}v1/devices`, {
          method: "POST",
          headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
          body: JSON.stringify({ deviceId, name: "Batch" })
        })
      );
      harness.tokens.set(deviceId, z.parse(httpDeviceRegisterResponseSchema, await response.json()).deviceToken);
      await writeFile(join(setup.dataDir, "config.json"), JSON.stringify({ backendUrl: BASE, deviceName: "Batch" }));
      const pushed = await harness.run(setup);
      expect(pushed.result.sync.state).toBe("ok");
      expect(pushed.result.sync.pushed).toBe(PUSH_BATCH + 1);
      const puts = harness.lab.requests.filter((request) => request.method === "PUT");
      expect(puts).toHaveLength(2);
      const firstBody: unknown = JSON.parse(puts[0]?.body ?? "");
      const secondBody: unknown = JSON.parse(puts[1]?.body ?? "");
      expect(z.parse(httpPushRequestSchema, firstBody).buckets).toHaveLength(PUSH_BATCH);
      expect(z.parse(httpPushRequestSchema, secondBody).buckets).toHaveLength(1);

      const hour9 = Date.UTC(2026, 9, 22, 9) / 1000;
      const hour10 = Date.UTC(2026, 9, 22, 10) / 1000;
      const hour11 = Date.UTC(2026, 9, 22, 11) / 1000;
      const beta = await harness.pair(
        [
          { hour: hour9, inputTokens: 10, outputTokens: 0 },
          { hour: hour10, inputTokens: 20, outputTokens: 0 },
          { hour: hour11, inputTokens: 30, outputTokens: 0 }
        ],
        "Beta"
      );
      await harness.run(beta.setup);
      const watcher = await harness.pair([], "Watcher");
      const platform = harness.platformFor(watcher.setup);
      const before = harness.lab.requests.length;
      const sync = await Effect.runPromise(
        pairedSync({ platform, dataDir: watcher.setup.dataDir, pullLimit: 2 }).pipe(
          Effect.provide(harness.layerFor(watcher.setup))
        )
      );
      await Effect.runPromise(
        scanAndCommit(
          { platform, dataDir: watcher.setup.dataDir, log: silentLog, timeZone: TIME_ZONE, sync },
          refreshScan
        )
      );
      const pulls = harness.lab.requests
        .slice(before)
        .filter((request) => request.method === "GET" && request.url.includes("/v1/buckets"));
      expect(pulls.length).toBeGreaterThanOrEqual(2);
      expect(new URL(pulls[1]?.url ?? "").searchParams.get("after")).not.toBe("0");
      const remote = await readLedger(platform, watcher.setup.dataDir, (ledger) => ledger.readRemoteBuckets());
      // The watcher has no rows of its own, so it stores the batch device's page plus Beta's three hours.
      expect(remote).toHaveLength(PUSH_BATCH + 1 + 3);
      expect(remote.filter((row) => row.deviceId === beta.deviceId)).toHaveLength(3);
      expect(
        await readLedger(platform, watcher.setup.dataDir, (ledger) => Effect.succeed(ledger.meta.pullCursor))
      ).toBeGreaterThan(0);
      await readLedger(platform, watcher.setup.dataDir, (ledger) => ledger.resetRemote());
      expect(await readLedger(platform, watcher.setup.dataDir, (ledger) => ledger.readRemoteBuckets())).toEqual([]);
      expect(
        await readLedger(platform, watcher.setup.dataDir, (ledger) => Effect.succeed(ledger.meta.pullCursor))
      ).toBe(0);
    } finally {
      await setup.remove();
      await harness.close();
    }
  });

  it("does not re-pull a short page on the next refresh", async () => {
    const harness = await open();
    try {
      const hour9 = Date.UTC(2026, 9, 22, 9) / 1000;
      const alpha = await harness.pair([{ hour: hour9, inputTokens: 1000, outputTokens: 100 }], "Alpha");
      await harness.run(alpha.setup);
      const watcher = await harness.pair([], "Watcher");
      const before = harness.lab.requests.length;
      const first = await harness.run(watcher.setup);
      const pullsOf = (start: number) =>
        harness.lab.requests
          .slice(start)
          .filter((request) => request.method === "GET" && request.url.includes("/v1/buckets"));
      const firstPulls = pullsOf(before);
      expect(first.result.sync.pulled).toBe(1);
      expect(firstPulls.length).toBeGreaterThanOrEqual(2);
      expect(new URL(firstPulls[0]?.url ?? "").searchParams.get("after")).toBe("0");
      const cursor = new URL(firstPulls[1]?.url ?? "").searchParams.get("after");
      expect(cursor).not.toBe("0");
      const secondBefore = harness.lab.requests.length;
      const second = await harness.run(watcher.setup);
      const secondPulls = pullsOf(secondBefore);
      expect(second.result.sync.pulled).toBe(0);
      expect(secondPulls).toHaveLength(1);
      expect(new URL(secondPulls[0]?.url ?? "").searchParams.get("after")).toBe(cursor);
    } finally {
      await harness.close();
    }
  });

  it("does not start security when unpaired, and a missing security binary explains the unpaired refresh", async () => {
    const setup = await createRefreshSetup({ now: NOW });
    const stub = join(setup.home, "security-stub");
    const logPath = join(setup.home, "security.log");
    try {
      await writeFile(stub, '#!/bin/sh\necho called >> "$STUB_LOG"\n');
      const { chmod } = await import("node:fs/promises");
      await chmod(stub, 0o755);
      const platform = {
        ...setup.platform,
        env: {
          ...setup.platform.env,
          PATH: "/usr/bin:/bin",
          SNORLAX_HOME: setup.dataDir,
          SNORLAX_SECURITY: stub,
          STUB_LOG: logPath
        }
      };
      const unpaired = await Effect.runPromise(
        refreshFlow.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(SnorlaxPlatform, platform),
              NodeFiles.live,
              Layer.provide(Secrets.keychain, Layer.succeed(SnorlaxPlatform, platform)),
              Backend.layer(() => Promise.reject(new Error("unpaired test called the backend"))),
              Layer.succeed(TimeZone, TIME_ZONE)
            )
          )
        )
      );
      expect(unpaired.result.sync.state).toBe("unpaired");
      await expect(stat(logPath)).rejects.toThrow("ENOENT");

      const later = {
        ...platform,
        env: { ...platform.env, SNORLAX_SECURITY: join(setup.home, "missing-security") },
        clock: { now: () => NOW + 60_000, monotonic: () => 0 }
      };
      await writeFile(join(setup.dataDir, "config.json"), JSON.stringify({ backendUrl: BASE, deviceName: "Broken" }));
      const stdout: string[] = [];
      const exit = await Effect.runPromise(
        Effect.flip(
          runCli(
            ["refresh"],
            Layer.mergeAll(
              Layer.succeed(SnorlaxPlatform, later),
              NodeFiles.live,
              Layer.provide(Secrets.keychain, Layer.succeed(SnorlaxPlatform, later)),
              Backend.layer(() => Promise.reject(new Error("broken keychain must not call the backend"))),
              Layer.succeed(TimeZone, TIME_ZONE),
              fakeScheduler([], { jobFile: join(setup.home, "job") }),
              Layer.succeed(
                CliEnv,
                CliEnv.of({
                  stdout: { write: (text) => void stdout.push(text) },
                  stderr: { write: () => undefined },
                  colors: false
                })
              )
            )
          )
        )
      );
      expect(exit.exitCode).toBe(0);
      const text = stdout.join("");
      expect(text).toContain("sync: not paired");
      expect(text).toContain("was not deleted");
      expect(text).not.toContain("/usr/bin/security");
      expect(text).not.toContain(setup.home);
      const log = await readFile(join(setup.dataDir, "logs", "snorlax.log"), "utf8");
      expect(log).toContain("was not deleted");
      const snap = await readSnapshotFile(setup.platform, setup.dataDir);
      expect(snap.kind === "ok" && snap.snapshot.generatedAt).toBe(new Date(NOW + 60_000).toISOString());
      expect(snap.kind === "ok" && snap.snapshot.status.sync.state).toBe("unpaired");
      expect(snap.kind === "ok" && snap.snapshot.status.paired).toBe(false);
    } finally {
      await setup.remove();
    }
  });

  it("fails a pull whose next does not move past after, and does not request another page", async () => {
    const harness = await open();
    try {
      const hour9 = Date.UTC(2026, 9, 22, 9) / 1000;
      const alpha = await harness.pair([{ hour: hour9, inputTokens: 10, outputTokens: 1 }], "Alpha");
      const before = harness.lab.requests.length;
      // The second answer would let an unguarded client finish. The guard must stop on the first page.
      harness.lab.setPullPage((after, seen) =>
        seen === 1 ? { buckets: [], next: after } : { buckets: [], next: null }
      );
      const failed = await harness.run(alpha.setup);
      expect(failed.result.sync.state).toBe("failed");
      expect(failed.result.sync.message).toContain("not past after");
      const pulls = harness.lab.requests
        .slice(before)
        .filter((request) => request.method === "GET" && request.url.includes("/v1/buckets"));
      expect(pulls).toHaveLength(1);
      expect((await snapshotOf(alpha.setup)).status.sync.state).toBe("failed");
    } finally {
      await harness.close();
    }
  });

  it("reports sync failed when security throws while starting", async () => {
    const setup = await createRefreshSetup({ now: NOW });
    const stub = join(setup.home, "security-noshebang");
    try {
      await writeFile(stub, "not a script\n");
      await chmod(stub, 0o755);
      await writeClaudeSession(setup.home, {
        sessionId: "noshebang",
        mtimeMs: quietMtime(NOW),
        requests: [
          {
            requestId: "noshebang-1",
            model: "claude-haiku-4-5",
            timestampMs: NOW - 60_000,
            usage: usage(1, 1)
          }
        ]
      });
      const platform = {
        ...setup.platform,
        env: {
          ...setup.platform.env,
          PATH: "/usr/bin:/bin",
          SNORLAX_HOME: setup.dataDir,
          SNORLAX_SECURITY: stub
        }
      };
      const layers = Layer.mergeAll(
        Layer.succeed(SnorlaxPlatform, platform),
        NodeFiles.live,
        Layer.provide(Secrets.keychain, Layer.succeed(SnorlaxPlatform, platform)),
        Backend.layer(() => Promise.reject(new Error("a keychain that cannot start must not call the backend"))),
        Layer.succeed(TimeZone, TIME_ZONE)
      );
      // Create the ledger while unpaired, then point config at a backend so the next refresh starts security.
      await Effect.runPromise(refreshFlow.pipe(Effect.provide(layers)));
      await writeFile(join(setup.dataDir, "config.json"), JSON.stringify({ backendUrl: BASE, deviceName: "Broken" }));
      const stdout: string[] = [];
      const exit = await Effect.runPromise(
        Effect.flip(
          runCli(
            ["refresh"],
            Layer.mergeAll(
              layers,
              fakeScheduler([], { jobFile: join(setup.home, "job") }),
              Layer.succeed(
                CliEnv,
                CliEnv.of({
                  stdout: { write: (text) => void stdout.push(text) },
                  stderr: { write: () => undefined },
                  colors: false
                })
              )
            )
          )
        )
      );
      expect(exit.exitCode).toBe(0);
      expect(stdout.join("")).toContain("sync: failed");
      const snap = await readSnapshotFile(setup.platform, setup.dataDir);
      expect(snap.kind === "ok" && snap.snapshot.status.sync.state).toBe("failed");
    } finally {
      await setup.remove();
    }
  });

  it("reports sync failed when the device token cannot be a header, and does not print it", async () => {
    for (const token of ["probe-secret-123\nhidden", "probe-other-456\rhidden"]) {
      const setup = await createRefreshSetup({ now: NOW });
      try {
        const platform = {
          ...setup.platform,
          env: {
            ...setup.platform.env,
            PATH: "/usr/bin:/bin",
            SNORLAX_HOME: setup.dataDir,
            SNORLAX_DEVICE_TOKEN: token
          }
        };
        const layers = Layer.mergeAll(
          Layer.succeed(SnorlaxPlatform, platform),
          NodeFiles.live,
          Secrets.memory(platform.env),
          Backend.layer(() => Promise.reject(new Error("a bad device token must not call the backend"))),
          Layer.succeed(TimeZone, TIME_ZONE)
        );
        await Effect.runPromise(refreshFlow.pipe(Effect.provide(layers)));
        await writeFile(join(setup.dataDir, "config.json"), JSON.stringify({ backendUrl: BASE, deviceName: "Desk" }));
        const run = async (args: readonly string[]) => {
          const stdout: string[] = [];
          const stderr: string[] = [];
          const exit = await Effect.runPromise(
            Effect.flip(
              runCli(
                args,
                Layer.mergeAll(
                  layers,
                  fakeScheduler([], { jobFile: join(setup.home, "job") }),
                  Layer.succeed(
                    CliEnv,
                    CliEnv.of({
                      stdout: { write: (text) => void stdout.push(text) },
                      stderr: { write: (text) => void stderr.push(text) },
                      colors: false
                    })
                  )
                )
              )
            )
          );
          return { exitCode: exit.exitCode, stdout: stdout.join(""), stderr: stderr.join("") };
        };
        const json = await run(["refresh", "--json"]);
        const human = await run(["refresh"]);
        const log = await readFile(join(setup.dataDir, "logs", "snorlax.log"), "utf8");
        expect(json.exitCode).toBe(0);
        const body = z.parse(refreshResultSchema, JSON.parse(json.stdout));
        expect(body.sync.state).toBe("failed");
        expect(body.sync.message).toContain("device token");
        expect(body.sync.message).toContain("pair");
        expect(human.stdout).toContain("sync: failed");
        expect(human.stdout).toContain("device token");
        for (const surface of [json.stdout, json.stderr, human.stdout, human.stderr, log]) {
          expect(surface).not.toContain(token);
          expect(surface).not.toContain("probe-secret");
          expect(surface).not.toContain("probe-other");
        }
        expect(log).toContain("device token");
      } finally {
        await setup.remove();
      }
    }
  });
});
