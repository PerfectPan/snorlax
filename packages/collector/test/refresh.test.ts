import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { snapshotSchema, type Snapshot } from "@rivus/snorlax-protocol";
import * as z from "zod/mini";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { openLedger, type BucketRow } from "../src/ledger/ledger.ts";
import { createLogger, type Logger } from "../src/log/logger.ts";
import { runRefresh } from "../src/refresh/refresh.ts";
import { readSnapshotFile } from "../src/snapshot/read.ts";
import { nodeFileOps } from "../src/data-dir/node-fs.ts";
import { appendClaudeRequests, quietMtime, writeClaudeSession, writeCodexRollout } from "./fixtures/agents.ts";
import { createRefreshSetup, type RefreshSetup } from "./fixtures/platform.ts";

/**
 * Spec S1–S5 over generated fixtures under a temporary home, with the clock fixed at 2026-10-22T12:00:00Z
 * and every file read counted through the platform, which proves a later refresh decodes no unchanged
 * source again (S2). Buckets are UTC hours; the snapshot windows run in Asia/Shanghai. Every fixture's
 * mtime is pinned one hour before the fixed clock, so the kit decodes it as a quiet, final source.
 */

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MTIME = quietMtime(NOW);
const HOUR_9 = Date.UTC(2026, 9, 22, 9) / 1000;
const HOUR_10 = Date.UTC(2026, 9, 22, 10) / 1000;
const TIME_ZONE = "Asia/Shanghai";
const CC_PROJECT = join(".claude", "projects", "-Users-tester-fixture");

const silentLog: Logger = { event: async () => {} };

let setup: RefreshSetup;

beforeAll(async () => {
  setup = await createRefreshSetup({ now: NOW });
});

afterAll(async () => {
  await setup.remove();
});

const refresh = (hooks?: Parameters<typeof runRefresh>[1]) =>
  runRefresh({ platform: setup.platform, dataDir: setup.dataDir, log: silentLog, timeZone: TIME_ZONE }, hooks);

const snapshot = async (): Promise<Snapshot> => {
  const read = await readSnapshotFile(setup.platform, setup.dataDir);
  if (read.kind !== "ok") {
    throw new Error(`no valid snapshot: ${read.kind}`);
  }
  return read.snapshot;
};

const buckets = async (): Promise<BucketRow[]> => {
  const ledger = await openLedger(setup.platform, setup.dataDir);
  try {
    return ledger.readBuckets();
  } finally {
    ledger.close();
  }
};

const claudeRequest = (
  requestId: string,
  model: string,
  minuteOfHour: number,
  inputTokens: number,
  outputTokens: number
) => ({
  requestId,
  model,
  timestampMs: (HOUR_9 + minuteOfHour * 60) * 1000,
  usage: { inputTokens, outputTokens }
});

/** S1's fixtures: two Claude Code sessions (two models) and one Codex rollout, all inside the 09:00Z hour. */
const writeS1Fixtures = async (): Promise<void> => {
  await writeClaudeSession(setup.home, {
    sessionId: "cc-1",
    mtimeMs: MTIME,
    requests: [
      {
        requestId: "req_1",
        model: "claude-opus-5-5",
        timestampMs: (HOUR_9 + 5 * 60) * 1000,
        usage: {
          inputTokens: 5400,
          cacheReadTokens: 5000,
          cacheWriteTokens: 300,
          outputTokens: 50,
          reasoningTokens: 10
        }
      },
      {
        requestId: "req_2",
        model: "claude-opus-5-5",
        timestampMs: (HOUR_9 + 35 * 60) * 1000,
        usage: { inputTokens: 1100, cacheReadTokens: 1000, outputTokens: 20 }
      },
      {
        requestId: "req_3",
        model: "claude-haiku-4-5",
        timestampMs: (HOUR_9 + 50 * 60) * 1000,
        usage: { inputTokens: 600, outputTokens: 30 }
      }
    ]
  });
  await writeClaudeSession(setup.home, {
    sessionId: "cc-2",
    mtimeMs: MTIME,
    requests: [
      {
        requestId: "req_4",
        model: "claude-haiku-4-5",
        timestampMs: (HOUR_10 + 20 * 60) * 1000,
        usage: { inputTokens: 2000, outputTokens: 100 }
      }
    ]
  });
  await writeCodexRollout(setup.home, {
    sessionId: "cx-1",
    model: "gpt-6.2",
    mtimeMs: MTIME,
    requests: [
      {
        responseId: "resp_1",
        timestampMs: (HOUR_9 + 10 * 60) * 1000,
        usage: {
          inputTokens: 1200,
          cacheReadTokens: 400,
          cacheWriteTokens: 100,
          outputTokens: 200,
          reasoningTokens: 50
        }
      },
      { responseId: "resp_2", timestampMs: (HOUR_9 + 40 * 60) * 1000, usage: { inputTokens: 300, outputTokens: 30 } }
    ]
  });
};

/** The bucket rows S1's fixtures must produce; the tests below compare against these exact numbers. */
const expectedS1Buckets = (): readonly Omit<BucketRow, "dirty">[] => [
  {
    hour: HOUR_9,
    agent: "claude-code",
    model: "claude-haiku-4-5",
    inputTokens: 600,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 30,
    reasoningTokens: 0,
    requests: 1,
    sessionsStarted: 0,
    costUsd: 0,
    unpricedRequests: 1
  },
  {
    hour: HOUR_9,
    agent: "claude-code",
    model: "claude-opus-5-5",
    inputTokens: 6500,
    cacheReadTokens: 6000,
    cacheWriteTokens: 300,
    outputTokens: 70,
    reasoningTokens: 10,
    requests: 2,
    sessionsStarted: 1,
    costUsd: 0,
    unpricedRequests: 2
  },
  {
    hour: HOUR_9,
    agent: "codex",
    model: "gpt-6.2",
    inputTokens: 1500,
    cacheReadTokens: 400,
    cacheWriteTokens: 100,
    outputTokens: 230,
    reasoningTokens: 50,
    requests: 2,
    sessionsStarted: 1,
    costUsd: 0,
    unpricedRequests: 2
  },
  {
    hour: HOUR_10,
    agent: "claude-code",
    model: "claude-haiku-4-5",
    inputTokens: 2000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 100,
    reasoningTokens: 0,
    requests: 1,
    sessionsStarted: 1,
    costUsd: 0,
    unpricedRequests: 1
  }
];

describe("S1: the first run counts the history", () => {
  it("writes buckets that equal the fixture totals and a snapshot that aggregates them", async () => {
    await writeS1Fixtures();
    const outcome = await refresh();

    // Four of the six agents have no home here; a missing root is detection, not a decode failure.
    expect(outcome.result).toMatchObject({ ok: true, records: 6, failures: 0 });
    expect(outcome.result.scannedAt).toBe(new Date(NOW).toISOString());
    expect(outcome.result.sync).toEqual({ ok: false, pushed: 0, pulled: 0 });

    expect((await buckets()).map(({ dirty: _dirty, ...row }) => row)).toEqual(expectedS1Buckets());

    const snap = await snapshot();
    expect(snap.timeZone).toBe(TIME_ZONE);
    expect(snap.status.lastScanAt).toBe(new Date(NOW).toISOString());
    // 12:00Z is 20:00 in Asia/Shanghai, so every fixture hour is today's local day.
    expect(snap.totals.today).toMatchObject({
      tokens: 11_030,
      inputTokens: 10_600,
      outputTokens: 430,
      cacheReadTokens: 6400,
      requests: 6,
      sessions: 3,
      unpricedRequests: 6,
      costUsd: 0
    });
    expect(snap.totals.last30d).toMatchObject({ tokens: 11_030, requests: 6 });
    expect(snap.byAgent.map((entry) => [entry.agent, entry.today.tokens])).toEqual([
      ["claude-code", 9300],
      ["codex", 1730]
    ]);
    expect(snap.byModel.map((entry) => [entry.model, entry.today.tokens])).toEqual([
      ["claude-haiku-4-5", 2730],
      ["claude-opus-5-5", 6570],
      ["gpt-6.2", 1730]
    ]);
    expect(z.safeParse(snapshotSchema, snap).success).toBe(true);
  });

  it("creates the ledger with a device id and persists the scan time", async () => {
    const ledger = await openLedger(setup.platform, setup.dataDir);
    try {
      expect(ledger.meta.deviceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(ledger.meta.lastScanCompletedAt).toBe(NOW);
      expect(ledger.scanState).toBeDefined();
    } finally {
      ledger.close();
    }
  });
});

describe("S2: later runs read only new content", () => {
  it("grows by exactly the appended requests and decodes no unchanged source again", async () => {
    const before = (await snapshot()).totals.today;
    setup.readBytes.clear();

    const appended = [
      claudeRequest("req_5", "claude-opus-5-5", 80, 700, 40),
      claudeRequest("req_6", "claude-opus-5-5", 81, 800, 60),
      claudeRequest("req_7", "claude-haiku-4-5", 82, 900, 70)
    ];
    // HOUR_9 + 80 min is 10:20Z, inside the next run's `since` window (last scan − 2 h).
    await appendClaudeRequests(join(setup.home, CC_PROJECT, "cc-1.jsonl"), appended, "cc-1", MTIME);

    const outcome = await refresh();
    expect(outcome.result.records).toBe(3);
    expect(outcome.result.failures).toBe(0);

    const after = (await snapshot()).totals.today;
    expect(after.requests).toBe(before.requests + 3);
    expect(after.tokens).toBe(before.tokens + (700 + 40) + (800 + 60) + (900 + 70));

    // The appended file was the only source decoded again. Every unchanged source is touched by at most the
    // kit's one-byte cursor probe (`continuesAt`), so no line of it is read, let alone decoded.
    const appendedPath = join(setup.home, CC_PROJECT, "cc-1.jsonl");
    expect(setup.readBytes.get(appendedPath)).toBeGreaterThan(1);
    const unchanged = [...setup.readBytes.entries()].filter(
      ([path]) => path.startsWith(setup.home) && !path.startsWith(setup.dataDir) && path !== appendedPath
    );
    expect(unchanged).not.toHaveLength(0);
    expect(unchanged.filter(([, bytes]) => bytes > 1).map(([path]) => path)).toEqual([]);
  });
});

describe("S3: a killed run does not double count", () => {
  it("leaves the ledger and snapshot as they were, and a rerun counts the new request once", async () => {
    const before = await buckets();
    const beforeSnapshot = await snapshot();

    await appendClaudeRequests(
      join(setup.home, CC_PROJECT, "cc-1.jsonl"),
      [claudeRequest("req_8", "claude-opus-5-5", 90, 1000, 10)],
      "cc-1",
      MTIME
    );

    await expect(refresh({ failBeforeCommit: true })).rejects.toThrow(/simulated crash/);
    expect(await buckets()).toEqual(before);
    await expect(snapshot()).resolves.toEqual(beforeSnapshot);

    const rerun = await refresh();
    expect(rerun.result.records).toBe(1);

    const claude = (await snapshot()).byAgent.find((agent) => agent.agent === "claude-code");
    // S1's four Claude requests, S2's three, the one appended here: eight, each counted once.
    expect(claude?.today.requests).toBe(8);
    expect(claude?.today.tokens).toBe(9300 + 2570 + 1010);
  });
});

describe("S4: repeated records count once", () => {
  it("counts a subagent file's copies of its parent's requests once", async () => {
    const copied = [
      claudeRequest("sub_req_1", "claude-opus-5-5", 130, 1000, 100),
      claudeRequest("sub_req_2", "claude-opus-5-5", 131, 1100, 110)
    ];
    await writeClaudeSession(setup.home, {
      sessionId: "cc-parent",
      mtimeMs: MTIME,
      requests: [
        ...copied,
        // HOUR_9 + 132 min is 11:12Z; the requests land in the 11:00Z hour.
        claudeRequest("sub_req_3", "claude-opus-5-5", 132, 1200, 120)
      ]
    });
    // The subagent file starts with copies of the parent's records, then adds its own request.
    await writeClaudeSession(setup.home, {
      sessionId: "cc-parent",
      subagent: "lane-1",
      mtimeMs: MTIME,
      requests: [
        ...copied.map((request) => ({ ...request, sessionId: "cc-parent" })),
        claudeRequest("sub_req_lane", "claude-haiku-4-5", 133, 500, 50)
      ]
    });

    const outcome = await refresh();
    expect(outcome.result.records).toBe(4);

    const hour11 = Date.UTC(2026, 9, 22, 11) / 1000;
    const rows = (await buckets()).filter((row) => row.hour === hour11 && row.agent === "claude-code");
    // Three parent requests plus the lane's own one, each once; the session started once.
    expect(rows.reduce((sum, row) => sum + row.requests, 0)).toBe(4);
    expect(rows.find((row) => row.model === "claude-opus-5-5")?.requests).toBe(3);
    expect(rows.find((row) => row.model === "claude-haiku-4-5")?.requests).toBe(1);
    expect(rows.reduce((sum, row) => sum + row.sessionsStarted, 0)).toBe(1);
  });
});

describe("S5: deleted logs keep their usage", () => {
  it("keeps every bucket total after the session's files are deleted", async () => {
    const before = await buckets();
    const beforeTotals = (await snapshot()).totals;

    await rm(join(setup.home, CC_PROJECT, "cc-parent.jsonl"));
    await rm(join(setup.home, CC_PROJECT, "cc-parent"), { recursive: true });
    const outcome = await refresh();
    expect(outcome.result.records).toBe(0);

    expect(await buckets()).toEqual(before);
    expect((await snapshot()).totals).toEqual(beforeTotals);
  });
});

describe("failures", () => {
  it("counts a source that cannot be decoded per agent", async () => {
    const path = join(setup.home, CC_PROJECT, "cc-broken.jsonl");
    // A record of an unknown format generation fails the decode; a non-JSON line the kit skips silently.
    await writeFile(path, `${JSON.stringify({ type: "assistant", formatVersion: 99 })}\n`, "utf8");
    await utimes(path, new Date(MTIME), new Date(MTIME));

    const outcome = await refresh();
    expect(outcome.result.failures).toBeGreaterThan(0);
    expect(outcome.failuresByAgent["claude-code"]).toBeGreaterThan(0);
    expect((await snapshot()).status.failuresByAgent["claude-code"]).toBeGreaterThan(0);

    await rm(path);
    expect((await refresh()).result.failures).toBe(0);
  });
});

describe("logging", () => {
  it("writes one summary line per refresh", async () => {
    const log = await createLogger(setup.platform, nodeFileOps, setup.dataDir);
    await runRefresh({ platform: setup.platform, dataDir: setup.dataDir, log, timeZone: TIME_ZONE });
    const text = await readFile(join(setup.dataDir, "logs", "snorlax.log"), "utf8");
    const refreshLine = text
      .trimEnd()
      .split("\n")
      .filter((line) => / refresh \{"records":/.test(line))
      .at(-1);
    expect(refreshLine).toMatch(/"records":\d+,"failures":\d+,"pushed":0,"pulled":0,"durationMs":\d+}/);
  });
});

describe("a month of history", () => {
  it("completes a refresh over 30 days of generated fixtures; the duration is logged, not asserted", async () => {
    const month = await createRefreshSetup({ now: NOW });
    try {
      for (let day = 29; day >= 0; day -= 1) {
        const base = NOW - day * 86_400_000;
        await writeClaudeSession(month.home, {
          sessionId: `cc-${day}`,
          mtimeMs: MTIME,
          requests: Array.from({ length: 40 }, (_position, index) => ({
            requestId: `m-${day}-${index}`,
            model: index % 2 === 0 ? "claude-opus-5-5" : "claude-haiku-4-5",
            timestampMs: base - 3_600_000 + index * 60_000,
            usage: { inputTokens: 10_000 + index, outputTokens: 500 + index }
          }))
        });
        await writeCodexRollout(month.home, {
          sessionId: `cx-${day}`,
          model: "gpt-6.2",
          mtimeMs: MTIME,
          requests: Array.from({ length: 20 }, (_position, index) => ({
            responseId: `mresp-${day}-${index}`,
            timestampMs: base - 3_600_000 + index * 90_000,
            usage: { inputTokens: 20_000 + index, outputTokens: 900 + index }
          }))
        });
      }
      const started = performance.now();
      const outcome = await runRefresh({
        platform: month.platform,
        dataDir: month.dataDir,
        log: silentLog,
        timeZone: TIME_ZONE
      });
      const durationMs = Math.round(performance.now() - started);
      expect(outcome.result.records).toBe(30 * 60);
      expect(outcome.result.failures).toBe(0);
      console.log(`refresh over one month of generated fixtures: ${durationMs} ms (informational, not asserted)`);
    } finally {
      await month.remove();
    }
  });
});

describe("bundled CLI end to end", () => {
  it("refresh, snapshot and status answer over generated fixtures under a temporary HOME", async () => {
    const bundle = fileURLToPath(new URL("../dist/snorlax.mjs", import.meta.url));
    if (!existsSync(bundle)) {
      throw new Error(`${bundle} is missing; run "pnpm --filter @rivus/snorlax run build" first`);
    }

    const home = await mkdtemp(join(tmpdir(), "snorlax-e2e-"));
    const run = (args: readonly string[]) =>
      spawnSync(process.execPath, [bundle, ...args], {
        encoding: "utf8",
        env: { HOME: home, SNORLAX_HOME: join(home, "data"), PATH: "/usr/bin:/bin" }
      });
    try {
      const at = Date.now() - 3_600_000;
      await writeClaudeSession(home, {
        sessionId: "e2e-1",
        requests: [
          {
            requestId: "e2e-req-1",
            model: "claude-opus-5-5",
            timestampMs: at,
            usage: { inputTokens: 1234, outputTokens: 55 }
          },
          {
            requestId: "e2e-req-2",
            model: "claude-opus-5-5",
            timestampMs: at + 60_000,
            usage: { inputTokens: 4321, outputTokens: 66 }
          }
        ]
      });
      await writeCodexRollout(home, {
        sessionId: "e2e-cx",
        model: "gpt-6.2",
        requests: [
          { responseId: "e2e-resp-1", timestampMs: at + 120_000, usage: { inputTokens: 999, outputTokens: 44 } }
        ]
      });

      const refreshed = run(["refresh", "--json"]);
      expect(refreshed.stderr).toBe("");
      expect(refreshed.status).toBe(0);
      const result: unknown = JSON.parse(refreshed.stdout);
      expect(result).toMatchObject({ ok: true, records: 3, failures: 0, sync: { ok: false, pushed: 0, pulled: 0 } });

      const printed = run(["snapshot", "--json"]);
      expect(printed.status).toBe(0);
      const parsed = z.safeParse(snapshotSchema, JSON.parse(printed.stdout));
      expect(parsed.success ? "valid" : z.prettifyError(parsed.error)).toBe("valid");
      expect(parsed.success && parsed.data.totals.last30d.requests).toBe(3);

      const status = run(["status", "--json"]);
      expect(status.status).toBe(0);
      expect(JSON.parse(status.stdout).device.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(JSON.parse(status.stdout).lastScanAt).toBe((result as { scannedAt: string }).scannedAt);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
