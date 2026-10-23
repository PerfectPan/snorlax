import { rm } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { openLedger, type BucketRow } from "../src/ledger/ledger.ts";
import { rebuildStartHour, REBUILD_MAX_DAYS, runRebuild } from "../src/rebuild/rebuild.ts";
import { runRefresh } from "../src/refresh/refresh.ts";
import { readSnapshotFile } from "../src/snapshot/read.ts";
import type { Logger } from "../src/log/logger.ts";
import { quietMtime, writeClaudeSession } from "./fixtures/agents.ts";
import { createRefreshSetup, type RefreshSetup } from "./fixtures/platform.ts";

/**
 * `snorlax rebuild --days n` (plan 3.4.3): the last n days of local buckets are zeroed and rescanned in one
 * transaction with the scan's own writes, so a killed rebuild changes nothing; usage older than the window
 * and deleted-log usage behave per Spec R4 (zeroed rows stay as zeros to replace later uploads).
 */

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MTIME = quietMtime(NOW);
const TIME_ZONE = "UTC";
const SILENT_LOG: Logger = { event: async () => {} };

const HOUR = 3_600;
const DAY = 86_400;
const hourOf = (daysAgo: number, minute: number): number => (NOW - daysAgo * DAY * 1000) / 1000 + minute * 60;

let setup: RefreshSetup;

beforeAll(async () => {
  setup = await createRefreshSetup({ now: NOW });
});

afterAll(async () => {
  await setup.remove();
});

const refresh = (hooks?: Parameters<typeof runRefresh>[1]) =>
  runRefresh({ platform: setup.platform, dataDir: setup.dataDir, log: SILENT_LOG, timeZone: TIME_ZONE }, hooks);

const rebuild = (days: number, hooks?: Parameters<typeof runRebuild>[2]) =>
  runRebuild({ platform: setup.platform, dataDir: setup.dataDir, log: SILENT_LOG, timeZone: TIME_ZONE }, days, hooks);

const rows = async (): Promise<BucketRow[]> => {
  const ledger = await openLedger(setup.platform, setup.dataDir);
  try {
    return ledger.readBuckets();
  } finally {
    ledger.close();
  }
};

const totalsOf = async (): Promise<{ tokens: number; requests: number; sessions: number }> => {
  const read = await readSnapshotFile(setup.platform, setup.dataDir);
  if (read.kind !== "ok") {
    throw new Error(`no valid snapshot: ${read.kind}`);
  }
  const { tokens, requests, sessions } = read.snapshot.totals.last30d;
  return { tokens, requests, sessions };
};

describe("rebuildStartHour", () => {
  it("hour-aligns the window start n whole days back and accepts the documented range", () => {
    expect(rebuildStartHour(NOW, 3)).toBe(Math.floor((NOW - 3 * DAY * 1000) / (HOUR * 1000)) * HOUR);
    expect(rebuildStartHour(NOW + 17 * 60_000, 1) % HOUR).toBe(0);
    expect(REBUILD_MAX_DAYS).toBe(30);
  });
});

describe("rebuild", () => {
  it("recomputes the window to the same totals when every log still exists", async () => {
    await writeClaudeSession(setup.home, {
      sessionId: "old-1",
      mtimeMs: MTIME,
      requests: [
        {
          requestId: "old-1-r1",
          model: "claude-opus-5-5",
          timestampMs: hourOf(5, 10) * 1000,
          usage: { inputTokens: 5000, outputTokens: 100 }
        }
      ]
    });
    await writeClaudeSession(setup.home, {
      sessionId: "recent-1",
      mtimeMs: MTIME,
      requests: [
        {
          requestId: "recent-1-r1",
          model: "claude-opus-5-5",
          timestampMs: hourOf(0, -180) * 1000,
          usage: { inputTokens: 3000, outputTokens: 60 }
        },
        {
          requestId: "recent-1-r2",
          model: "claude-haiku-4-5",
          timestampMs: hourOf(0, -179) * 1000,
          usage: { inputTokens: 400, outputTokens: 8 }
        }
      ]
    });
    await refresh();
    const before = await totalsOf();
    expect(before).toEqual({ tokens: 5000 + 100 + 3000 + 60 + 400 + 8, requests: 3, sessions: 2 });

    const outcome = await rebuild(3);
    expect(outcome.result.ok).toBe(true);
    expect(outcome.result.records).toBe(2);
    expect(await totalsOf()).toEqual(before);
  });

  it("zeroes a deleted log's recent usage and keeps the older usage, leaving zero rows behind", async () => {
    const before = await rows();
    const oldRow = before.find((row) => row.requests > 0 && row.hour < rebuildStartHour(NOW, 3));
    expect(oldRow).toBeDefined();

    await rm(join(setup.home, ".claude", "projects", "-Users-tester-fixture", "recent-1.jsonl"));

    await rebuild(3);
    const after = await rows();
    // The old session's row is untouched, dirty included (it never uploaded in this milestone).
    expect(after.find((row) => row.hour === oldRow?.hour)).toEqual(oldRow);
    // The recent session's rows exist, zeroed and marked dirty for the next upload.
    const zeroed = after.filter((row) => row.hour >= rebuildStartHour(NOW, 3));
    expect(zeroed).not.toHaveLength(0);
    for (const row of zeroed) {
      expect([
        row.inputTokens,
        row.outputTokens,
        row.requests,
        row.sessionsStarted,
        row.costUsd,
        row.unpricedRequests
      ]).toEqual([0, 0, 0, 0, 0, 0]);
      expect(row.dirty).toBe(true);
    }
    // The deleted session's start no longer counts; the old one stays.
    expect(await totalsOf()).toEqual({ tokens: 5000 + 100, requests: 1, sessions: 1 });
  });

  it("counts usage appended after a rebuild once the rebuild runs again", async () => {
    await writeClaudeSession(setup.home, {
      sessionId: "recent-2",
      mtimeMs: MTIME,
      requests: [
        {
          requestId: "recent-2-r1",
          model: "claude-opus-5-5",
          timestampMs: hourOf(0, -120) * 1000,
          usage: { inputTokens: 2000, outputTokens: 40 }
        }
      ]
    });
    await refresh();
    const before = await totalsOf();

    await writeClaudeSession(setup.home, {
      sessionId: "recent-3",
      mtimeMs: MTIME,
      requests: [
        {
          requestId: "recent-3-r1",
          model: "claude-haiku-4-5",
          timestampMs: hourOf(0, -60) * 1000,
          usage: { inputTokens: 900, outputTokens: 15 }
        }
      ]
    });
    // A rebuild whose window holds every fixture recomputes each record once, old and new alike.
    await rebuild(3);
    expect(await totalsOf()).toEqual({
      tokens: before.tokens + 900 + 15,
      requests: before.requests + 1,
      sessions: before.sessions + 1
    });
  });

  it("changes nothing when it dies before the commit, and the rerun lands on the same totals", async () => {
    const before = await rows();
    const beforeTotals = await totalsOf();

    await writeClaudeSession(setup.home, {
      sessionId: "recent-4",
      mtimeMs: MTIME,
      requests: [
        {
          requestId: "recent-4-r1",
          model: "claude-opus-5-5",
          timestampMs: hourOf(0, -30) * 1000,
          usage: { inputTokens: 111, outputTokens: 2 }
        }
      ]
    });
    await expect(rebuild(3, { failBeforeCommit: true })).rejects.toThrow(/simulated crash/);
    expect(await rows()).toEqual(before);
    await expect(totalsOf()).resolves.toEqual(beforeTotals);

    const outcome = await rebuild(3);
    // recent-2, recent-3 and the appended recent-4 are all inside the window and its fresh request window.
    expect(outcome.result.records).toBe(3);
    expect((await totalsOf()).tokens).toBe(beforeTotals.tokens + 111 + 2);
  });

  it("can run twice in a row safely", async () => {
    const before = await totalsOf();
    await rebuild(30);
    await rebuild(30);
    expect(await totalsOf()).toEqual(before);
  });
});
