import { join } from "node:path";

import { createPricing, priceRecord } from "@rivus/agent-kit/cost";
import { litellmPrices } from "@rivus/agent-kit/cost/prices";
import type { UsageRecord } from "@rivus/agent-kit/transcript/usage";
import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { accumulateRecord, createAccumulator, partRequestCounts } from "../src/core/buckets/buckets.ts";
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
 * Spec S11, S12 and the bucket arithmetic of plan 3.4.1 step 4: the kit's `priceRecord` prices each record
 * (the agent's own amount first, else the kit's LiteLLM snapshot), a `turn` record splits by `usageByModel`
 * with the kit's rule, a request whose model has no price counts as unpriced, and snorlax divides a record's
 * requests among its parts.
 */

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MTIME = quietMtime(NOW);
const HOUR_9 = Date.UTC(2026, 9, 22, 9) / 1000;
const TIME_ZONE = "UTC";

const silentLog: Logger = { event: () => Effect.void };

/** The pricing every run uses: the kit's LiteLLM snapshot, without fallbacks. */
const snapshotPricing = createPricing(litellmPrices);

/** A record with only the fields the splitting and accumulation rules read. */
const record = (overrides: Partial<UsageRecord> & Pick<UsageRecord, "timestamp" | "usage">): UsageRecord => ({
  agent: "claude-code",
  sessionId: "s1",
  granularity: "request",
  source: { file: "fixture.jsonl", offset: 0, length: 0, line: 1 },
  ...overrides
});

describe("partRequestCounts (plan 3.4.1 step 4)", () => {
  const usage = { inputTokens: 1, outputTokens: 1 };
  const splitTurn = (overrides: { modelCalls?: number; usageByModel: UsageRecord["usageByModel"] }): UsageRecord =>
    record({
      granularity: "turn",
      timestamp: 0,
      usage,
      ...(overrides.modelCalls === undefined ? {} : { modelCalls: overrides.modelCalls }),
      usageByModel: overrides.usageByModel
    });

  it("counts 1 for every portion of a request record", () => {
    const request = record({
      granularity: "request",
      timestamp: 0,
      model: "grok-4",
      modelCalls: 7,
      usage,
      usageByModel: { "grok-4": { usage } }
    });
    expect(partRequestCounts(request, priceRecord(request, snapshotPricing).parts)).toEqual([1]);
  });

  it("counts an unsplit turn's modelCalls, else 1", () => {
    const counted = record({ granularity: "turn", timestamp: 0, modelCalls: 3, usage });
    expect(partRequestCounts(counted, priceRecord(counted, snapshotPricing).parts)).toEqual([3]);
    const uncounted = record({ granularity: "turn", timestamp: 0, usage });
    expect(partRequestCounts(uncounted, priceRecord(uncounted, snapshotPricing).parts)).toEqual([1]);
  });

  it("gives a counted record's calls to its token-largest portion when no share names its own (all missing)", () => {
    const turn = splitTurn({
      modelCalls: 3,
      usageByModel: {
        "grok-4": { usage: { inputTokens: 100, outputTokens: 20 } },
        "grok-4-fast": { usage: { inputTokens: 200, outputTokens: 40 } }
      }
    });
    expect(partRequestCounts(turn, priceRecord(turn, snapshotPricing).parts)).toEqual([0, 3]);
  });

  it("gives the leftover calls to the token-largest share without its own count (some missing)", () => {
    const turn = splitTurn({
      modelCalls: 3,
      usageByModel: {
        "grok-4": { usage: { inputTokens: 200, outputTokens: 40 } },
        "grok-4-fast": { usage: { inputTokens: 100, outputTokens: 20 }, modelCalls: 1 }
      }
    });
    expect(partRequestCounts(turn, priceRecord(turn, snapshotPricing).parts)).toEqual([2, 1]);
  });

  it("uses every share's own count when each names one (all present)", () => {
    const turn = splitTurn({
      modelCalls: 3,
      usageByModel: {
        "grok-4": { usage: { inputTokens: 200, outputTokens: 40 }, modelCalls: 2 },
        "grok-4-fast": { usage: { inputTokens: 100, outputTokens: 20 }, modelCalls: 1 }
      }
    });
    expect(partRequestCounts(turn, priceRecord(turn, snapshotPricing).parts)).toEqual([2, 1]);
  });

  it("keeps known counts that exceed the record's and leaves the missing shares at 0 (over)", () => {
    const turn = splitTurn({
      modelCalls: 2,
      usageByModel: {
        "grok-4": { usage: { inputTokens: 200, outputTokens: 40 }, modelCalls: 2 },
        "grok-4-fast": { usage: { inputTokens: 100, outputTokens: 20 } }
      }
    });
    expect(partRequestCounts(turn, priceRecord(turn, snapshotPricing).parts)).toEqual([2, 0]);
  });

  it("uses each share's own count, else 1, when the record reports no modelCalls", () => {
    const turn = splitTurn({
      usageByModel: {
        "grok-4": { usage: { inputTokens: 200, outputTokens: 40 }, modelCalls: 2 },
        "grok-4-fast": { usage: { inputTokens: 100, outputTokens: 20 } }
      }
    });
    expect(partRequestCounts(turn, priceRecord(turn, snapshotPricing).parts)).toEqual([2, 1]);
  });
});

describe("accumulateRecord", () => {
  it("adds a portion's logged cost or counts its requests as unpriced", () => {
    const accumulator = createAccumulator();
    const seen = new Map<string, Set<string>>();
    accumulateRecord(
      record({
        timestamp: HOUR_9 * 1000 + 60_000,
        usage: { inputTokens: 100, outputTokens: 10 },
        costUsd: 0.25,
        costSource: "agent"
      }),
      snapshotPricing,
      accumulator,
      seen
    );
    accumulateRecord(
      record({
        sessionId: "s2",
        timestamp: HOUR_9 * 1000 + 120_000,
        usage: { inputTokens: 50, outputTokens: 5 }
      }),
      snapshotPricing,
      accumulator,
      seen
    );

    // Both records fall in the same hour, agent and model, so they merge into one bucket.
    expect(accumulator.buckets.size).toBe(1);
    expect([...accumulator.buckets.values()][0]).toMatchObject({
      requests: 2,
      costUsd: 0.25,
      unpricedRequests: 1,
      sessionsStarted: 2
    });
    expect(accumulator.newSessions.map((session) => session.sessionId).sort()).toEqual(["s1", "s2"]);
  });

  it("uses the empty-string model for a record that names none", () => {
    const accumulator = createAccumulator();
    accumulateRecord(
      record({ timestamp: HOUR_9 * 1000, usage: { inputTokens: 1, outputTokens: 1 } }),
      snapshotPricing,
      accumulator,
      new Map()
    );
    expect(accumulator.buckets.get(`${HOUR_9}|claude-code|`)).toMatchObject({ model: "", requests: 1 });
  });
});

describe("accumulateRecord prices through the kit", () => {
  /** Round prices in USD per million tokens, so the expected amounts are plain numbers. */
  const roundPricing = createPricing({
    "round-model": { input: 2, output: 10, cacheRead: 0.5, cacheWrite: 3, cacheWrite1h: 5 }
  });

  const bucketOf = (priced: UsageRecord) => {
    const accumulator = createAccumulator();
    accumulateRecord(priced, roundPricing, accumulator, new Map());
    return [...accumulator.buckets.values()][0];
  };

  it("multiplies a table price by the record's pricingMultiplier, but not an amount the agent logged", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000 };
    // (1M input × $2 + 0.1M output × $10) × 2 for Codex's priority tier.
    expect(bucketOf(record({ timestamp: 0, model: "round-model", usage, pricingMultiplier: 2 }))).toMatchObject({
      costUsd: 6,
      unpricedRequests: 0
    });
    // The agent's own amount is what it billed, so the multiplier does not apply to it.
    const logged = record({
      timestamp: 0,
      model: "round-model",
      usage,
      pricingMultiplier: 2,
      costUsd: 0.5,
      costSource: "agent"
    });
    expect(bucketOf(logged)).toMatchObject({ costUsd: 0.5, unpricedRequests: 0 });
  });

  it("charges one-hour cache writes at their own rate", () => {
    const usage = { inputTokens: 1_000_000, cacheWriteTokens: 1_000_000, cacheWrite1hTokens: 400_000, outputTokens: 0 };
    // 0.6M five-minute writes × $3 + 0.4M one-hour writes × $5; the bucket keeps one cache-write count.
    const bucket = bucketOf(record({ timestamp: 0, model: "round-model", usage }));
    expect(bucket?.costUsd).toBeCloseTo(3.8, 10);
    expect(bucket).toMatchObject({ cacheWriteTokens: 1_000_000, unpricedRequests: 0 });
  });
});

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
