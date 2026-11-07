import { join } from "node:path";

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { readSnapshotFile } from "../src/modules/snapshot-file/snapshot-file.ts";
import {
  quietMtime,
  writeClaudeSession,
  writeGrokSession,
  writeOpencodeDatabase,
  writePiSession
} from "./fixtures/agents.ts";
import { readLedger, runRefresh } from "./fixtures/flows.ts";
import { createRefreshSetup, type RefreshSetup } from "./fixtures/platform.ts";
import { snapshotCost } from "./fixtures/pricing.ts";
import type { Logger } from "../src/modules/log/log.ts";

/**
 * Spec S11 and S12 through the refresh flow over real fixture logs: a model the pricing table does not
 * list counts as unpriced, an agent-logged cost wins over the kit's table, a Claude Code API-error entry
 * the CLI wrote itself yields no record, and a turn record with a per-model split divides its tokens,
 * requests and logged cost across its models. The bucket arithmetic itself is unit-tested beside
 * `src/core/buckets/buckets.ts`.
 */

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MTIME = quietMtime(NOW);
const HOUR_9 = Date.UTC(2026, 9, 22, 9) / 1000;
const TIME_ZONE = "UTC";

const silentLog: Logger = { event: () => Effect.void };

describe("S11: a model the pricing table does not list", () => {
  it("counts its tokens, leaves it out of the cost and reports its requests as unpriced", async () => {
    const setup = await createRefreshSetup({ now: NOW });
    try {
      const priced = { inputTokens: 5400, cacheReadTokens: 5000, cacheWriteTokens: 300, outputTokens: 50 };
      await writeClaudeSession(setup.home, {
        sessionId: "cc-s11",
        mtimeMs: MTIME,
        requests: [
          { requestId: "r1", model: "claude-opus-5-5", timestampMs: (HOUR_9 + 5 * 60) * 1000, usage: priced },
          {
            requestId: "r2",
            model: "claude-unlisted-test",
            timestampMs: (HOUR_9 + 10 * 60) * 1000,
            usage: { inputTokens: 800, outputTokens: 40 }
          },
          {
            requestId: "r3",
            model: "claude-unlisted-test",
            timestampMs: (HOUR_9 + 15 * 60) * 1000,
            usage: { inputTokens: 200, outputTokens: 10 }
          }
        ]
      });
      await runRefresh({ platform: setup.platform, dataDir: setup.dataDir, log: silentLog, timeZone: TIME_ZONE });

      const rows = await readLedger(setup.platform, setup.dataDir, (ledger) => ledger.readBuckets());
      const listed = rows.find((row) => row.model === "claude-opus-5-5");
      expect(listed).toMatchObject({ requests: 1, unpricedRequests: 0 });
      expect(listed?.costUsd).toBeCloseTo(snapshotCost("claude-opus-5-5", priced), 12);
      expect(rows.find((row) => row.model === "claude-unlisted-test")).toMatchObject({
        inputTokens: 1000,
        outputTokens: 50,
        requests: 2,
        costUsd: 0,
        unpricedRequests: 2
      });

      const snapshot = await readSnapshotFile(setup.platform, setup.dataDir);
      const totals = snapshot.kind === "ok" ? snapshot.snapshot.totals.today : undefined;
      expect(totals).toMatchObject({ tokens: 5450 + 1050, requests: 3, unpricedRequests: 2 });
      expect(totals?.costUsd).toBeCloseTo(snapshotCost("claude-opus-5-5", priced), 12);
    } finally {
      await setup.remove();
    }
  });
});

describe("a Claude Code API-error entry the CLI wrote itself (<synthetic>)", () => {
  it("yields no record, so it counts into no request and no unpriced request", async () => {
    const setup = await createRefreshSetup({ now: NOW });
    try {
      await writeClaudeSession(setup.home, {
        sessionId: "cc-synthetic",
        mtimeMs: MTIME,
        requests: [
          {
            requestId: "r1",
            model: "claude-opus-5-5",
            timestampMs: (HOUR_9 + 5 * 60) * 1000,
            usage: { inputTokens: 1000, outputTokens: 50 }
          }
        ],
        syntheticEntries: [{ requestId: "syn-1", timestampMs: (HOUR_9 + 10 * 60) * 1000 }]
      });
      const outcome = await runRefresh({
        platform: setup.platform,
        dataDir: setup.dataDir,
        log: silentLog,
        timeZone: TIME_ZONE
      });

      expect(outcome.result.records).toBe(1);
      const rows = await readLedger(setup.platform, setup.dataDir, (ledger) => ledger.readBuckets());
      expect(rows.map((row) => [row.model, row.requests, row.unpricedRequests])).toEqual([["claude-opus-5-5", 1, 0]]);
    } finally {
      await setup.remove();
    }
  });
});

describe("S12: agent-logged cost over real fixture logs", () => {
  let setup: RefreshSetup;

  beforeAll(async () => {
    setup = await createRefreshSetup({ now: NOW });
    await writePiSession(setup.home, {
      sessionId: "pi-1",
      mtimeMs: MTIME,
      entries: [
        {
          entryId: "e1",
          model: "gemini-3-pro",
          timestampMs: (HOUR_9 + 5 * 60) * 1000,
          usage: { inputTokens: 1350, cacheReadTokens: 300, cacheWriteTokens: 50, outputTokens: 200 },
          costUsd: 0.0123
        },
        {
          entryId: "e2",
          model: "gemini-3-flash",
          timestampMs: (HOUR_9 + 10 * 60) * 1000,
          usage: { inputTokens: 500, outputTokens: 50 },
          // Pi logs a cost of 0 as a logged amount, not an unknown one.
          costUsd: 0
        }
      ]
    });
    await writeOpencodeDatabase(
      join(setup.home, ".local", "share", "opencode"),
      [
        {
          messageId: "msg_1",
          sessionId: "oc-1",
          model: "anthropic/claude-sonnet-5-5",
          timestampMs: (HOUR_9 + 20 * 60) * 1000,
          usage: {
            inputTokens: 1250,
            cacheReadTokens: 200,
            cacheWriteTokens: 50,
            outputTokens: 110,
            reasoningTokens: 10
          },
          costUsd: 0.0456
        },
        {
          messageId: "msg_2",
          sessionId: "oc-1",
          model: "anthropic/claude-sonnet-5-5",
          timestampMs: (HOUR_9 + 25 * 60) * 1000,
          usage: { inputTokens: 300, outputTokens: 30 },
          costUsd: 0.0012
        }
      ],
      MTIME
    );
  });

  afterAll(async () => {
    await setup.remove();
  });

  it("puts the logged amounts into the buckets, even for a model the pricing table lists", async () => {
    const outcome = await runRefresh({
      platform: setup.platform,
      dataDir: setup.dataDir,
      log: silentLog,
      timeZone: TIME_ZONE
    });
    expect(outcome.result.records).toBe(4);
    expect(outcome.result.failures).toBe(0);

    const rows = await readLedger(setup.platform, setup.dataDir, (ledger) => ledger.readBuckets());

    const pi = rows.find((row) => row.agent === "pi" && row.model === "gemini-3-pro");
    expect(pi).toMatchObject({
      inputTokens: 1350,
      cacheReadTokens: 300,
      cacheWriteTokens: 50,
      outputTokens: 200,
      requests: 1,
      sessionsStarted: 1,
      costUsd: 0.0123,
      unpricedRequests: 0
    });
    const piZeroCost = rows.find((row) => row.agent === "pi" && row.model === "gemini-3-flash");
    expect(piZeroCost).toMatchObject({ costUsd: 0, unpricedRequests: 0, requests: 1 });

    // The kit's snapshot prices `anthropic/claude-sonnet-5-5`; the amounts opencode logged still win (Spec S12).
    const opencode = rows.find((row) => row.agent === "opencode" && row.model === "anthropic/claude-sonnet-5-5");
    expect(opencode).toMatchObject({
      inputTokens: 1550,
      cacheReadTokens: 200,
      cacheWriteTokens: 50,
      outputTokens: 140,
      reasoningTokens: 10,
      requests: 2,
      sessionsStarted: 1,
      unpricedRequests: 0
    });
    expect(opencode?.costUsd).toBeCloseTo(0.0456 + 0.0012, 10);

    const snapshot = await readSnapshotFile(setup.platform, setup.dataDir);
    const totals = snapshot.kind === "ok" ? snapshot.snapshot.totals.today : undefined;
    expect(totals).toMatchObject({
      tokens: 1350 + 200 + (500 + 50) + (1550 + 140),
      unpricedRequests: 0,
      requests: 4,
      sessions: 2
    });
    expect(totals?.costUsd).toBeCloseTo(0.0123 + 0.0456 + 0.0012, 10);
  });
});

describe("a turn record with a per-model split (Grok fixtures)", () => {
  it("divides the turn's tokens, requests and logged cost across its models", async () => {
    const setup = await createRefreshSetup({ now: NOW });
    try {
      await writeGrokSession(setup.home, {
        sessionId: "gr-1",
        model: "grok-4",
        mtimeMs: MTIME,
        turns: [
          {
            promptId: "p1",
            timestampMs: (HOUR_9 + 30 * 60) * 1000,
            usage: { inputTokens: 300, outputTokens: 60 },
            modelCalls: 3,
            // 0.02 + 0.01 dollars, as ticks: 2e8 and 1e8.
            costUsdTicks: 300_000_000,
            modelUsage: {
              "grok-4": { usage: { inputTokens: 200, outputTokens: 40 }, modelCalls: 2, costUsdTicks: 200_000_000 },
              "grok-4-fast": { usage: { inputTokens: 100, outputTokens: 20 }, modelCalls: 1, costUsdTicks: 100_000_000 }
            }
          }
        ]
      });
      const outcome = await runRefresh({
        platform: setup.platform,
        dataDir: setup.dataDir,
        log: silentLog,
        timeZone: TIME_ZONE
      });
      expect(outcome.result.records).toBe(1);

      const rows = await readLedger(setup.platform, setup.dataDir, (ledger) => ledger.readBuckets());
      const grok4 = rows.find((row) => row.agent === "grok" && row.model === "grok-4");
      expect(grok4).toMatchObject({
        inputTokens: 200,
        outputTokens: 40,
        requests: 2,
        sessionsStarted: 1,
        costUsd: 0.02,
        unpricedRequests: 0
      });
      const fast = rows.find((row) => row.agent === "grok" && row.model === "grok-4-fast");
      expect(fast).toMatchObject({
        inputTokens: 100,
        outputTokens: 20,
        requests: 1,
        sessionsStarted: 0,
        costUsd: 0.01,
        unpricedRequests: 0
      });
    } finally {
      await setup.remove();
    }
  });

  it("keeps a turn whole when one model's cost is missing, with its requests unpriced-free", async () => {
    const setup = await createRefreshSetup({ now: NOW });
    try {
      await writeGrokSession(setup.home, {
        sessionId: "gr-2",
        model: "grok-4",
        mtimeMs: MTIME,
        turns: [
          {
            promptId: "p1",
            timestampMs: (HOUR_9 + 40 * 60) * 1000,
            usage: { inputTokens: 300, outputTokens: 60 },
            modelCalls: 2,
            costUsdTicks: 250_000_000,
            modelUsage: {
              "grok-4": { usage: { inputTokens: 200, outputTokens: 40 }, modelCalls: 1, costUsdTicks: 250_000_000 },
              "grok-4-fast": { usage: { inputTokens: 100, outputTokens: 20 }, modelCalls: 1 }
            }
          }
        ]
      });
      await runRefresh({ platform: setup.platform, dataDir: setup.dataDir, log: silentLog, timeZone: TIME_ZONE });

      const rows = await readLedger(setup.platform, setup.dataDir, (ledger) => ledger.readBuckets());
      // The record stays whole under its own model: no per-model rows, the turn's amount, its two calls.
      expect(rows.map((row) => [row.model, row.requests, row.costUsd])).toEqual([["grok-4", 2, 0.025]]);
      expect(rows[0]?.unpricedRequests).toBe(0);
    } finally {
      await setup.remove();
    }
  });

  it("adds a turn's leftover calls to its token-largest model when the log names no per-model calls", async () => {
    const setup = await createRefreshSetup({ now: NOW });
    try {
      await writeGrokSession(setup.home, {
        sessionId: "gr-3",
        model: "grok-4",
        mtimeMs: MTIME,
        turns: [
          {
            promptId: "p1",
            timestampMs: (HOUR_9 + 50 * 60) * 1000,
            usage: { inputTokens: 300, outputTokens: 60 },
            modelCalls: 3,
            // No modelUsage share carries `modelCalls`: the decoder fills per-model counts only when the
            // log has them, so the record's three calls have to be distributed, not repeated per model.
            modelUsage: {
              "grok-4": { usage: { inputTokens: 200, outputTokens: 40 } },
              "grok-4-fast": { usage: { inputTokens: 100, outputTokens: 20 }, modelCalls: 1 }
            }
          }
        ]
      });
      await runRefresh({ platform: setup.platform, dataDir: setup.dataDir, log: silentLog, timeZone: TIME_ZONE });

      const rows = await readLedger(setup.platform, setup.dataDir, (ledger) => ledger.readBuckets());
      // The three calls land once each: the leftover two on the token-largest share, one on its own count.
      const grok4 = rows.find((row) => row.agent === "grok" && row.model === "grok-4");
      expect(grok4).toMatchObject({ requests: 2, unpricedRequests: 2 });
      const fast = rows.find((row) => row.agent === "grok" && row.model === "grok-4-fast");
      expect(fast).toMatchObject({ requests: 1, unpricedRequests: 1 });
    } finally {
      await setup.remove();
    }
  });
});
