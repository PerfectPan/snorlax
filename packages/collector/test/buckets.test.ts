import { join } from "node:path";

import type { UsageRecord } from "@rivus/agent-kit/transcript/usage";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { accumulateRecord, createAccumulator, portionRequests } from "../src/buckets/accumulate.ts";
import { splitByModel } from "../src/buckets/split.ts";
import { openLedger, type BucketRow } from "../src/ledger/ledger.ts";
import { runRefresh } from "../src/refresh/refresh.ts";
import { readSnapshotFile } from "../src/snapshot/read.ts";
import { quietMtime, writeGrokSession, writeOpencodeDatabase, writePiSession } from "./fixtures/agents.ts";
import { createRefreshSetup, type RefreshSetup } from "./fixtures/platform.ts";
import type { Logger } from "../src/log/logger.ts";

/**
 * Spec S12 and the bucket arithmetic of plan 3.4.1 step 4: agent-logged costs (Pi, opencode) land in the
 * buckets as logged, a `turn` record splits by `usageByModel` with the kit's rule, and every request whose
 * cost nobody logged counts as unpriced (until Batch 5's pricing table).
 */

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MTIME = quietMtime(NOW);
const HOUR_9 = Date.UTC(2026, 9, 22, 9) / 1000;
const TIME_ZONE = "UTC";

const silentLog: Logger = { event: async () => {} };

/** A record with only the fields the splitting and accumulation rules read. */
const record = (overrides: Partial<UsageRecord> & Pick<UsageRecord, "timestamp" | "usage">): UsageRecord => ({
  agent: "claude-code",
  sessionId: "s1",
  granularity: "request",
  source: { file: "fixture.jsonl", offset: 0, length: 0, line: 1 },
  ...overrides
});

describe("splitByModel (the kit's rule until agent-kit K2)", () => {
  it("returns the whole record as one portion when it has no model split", () => {
    const portions = splitByModel(
      record({
        timestamp: 0,
        model: "claude-opus-5-5",
        usage: { inputTokens: 100, outputTokens: 10 },
        costUsd: 0.5,
        costSource: "agent"
      })
    );
    expect(portions).toEqual([
      { model: "claude-opus-5-5", usage: { inputTokens: 100, outputTokens: 10 }, modelCalls: undefined, costUsd: 0.5 }
    ]);
  });

  it("splits by usageByModel, one portion per model with each model's own usage and cost", () => {
    const portions = splitByModel(
      record({
        timestamp: 0,
        granularity: "turn",
        model: "grok-4",
        modelCalls: 3,
        costUsd: 0.03,
        costSource: "agent",
        usage: { inputTokens: 300, outputTokens: 60 },
        usageByModel: {
          "grok-4": {
            usage: { inputTokens: 200, outputTokens: 40 },
            modelCalls: 2,
            costUsd: 0.02,
            costSource: "agent"
          },
          "grok-4-fast": {
            usage: { inputTokens: 100, outputTokens: 20 },
            modelCalls: 1,
            costUsd: 0.01,
            costSource: "agent"
          }
        }
      })
    );
    expect(portions).toEqual([
      { model: "grok-4", usage: { inputTokens: 200, outputTokens: 40 }, modelCalls: 2, costUsd: 0.02 },
      { model: "grok-4-fast", usage: { inputTokens: 100, outputTokens: 20 }, modelCalls: 1, costUsd: 0.01 }
    ]);
  });

  it("keeps the record whole when the agent logged one amount the split does not divide among every model", () => {
    const portions = splitByModel(
      record({
        timestamp: 0,
        model: "grok-4",
        costUsd: 0.03,
        costSource: "agent",
        usage: { inputTokens: 300, outputTokens: 60 },
        usageByModel: {
          // The fast model has no cost of its own, so charging it at table prices would replace the
          // agent's amount for the record; the kit keeps the record whole instead.
          "grok-4": { usage: { inputTokens: 200, outputTokens: 40 }, costUsd: 0.03, costSource: "agent" },
          "grok-4-fast": { usage: { inputTokens: 100, outputTokens: 20 } }
        }
      })
    );
    expect(portions).toEqual([
      {
        model: "grok-4",
        usage: { inputTokens: 300, outputTokens: 60 },
        modelCalls: undefined,
        costUsd: 0.03
      }
    ]);
  });

  it("splits a record whose record-level cost came from a price table", () => {
    const portions = splitByModel(
      record({
        timestamp: 0,
        costUsd: 0.04,
        costSource: "pricing-table",
        usage: { inputTokens: 10, outputTokens: 1 },
        usageByModel: {
          "grok-4": { usage: { inputTokens: 6, outputTokens: 1 } },
          "grok-4-fast": { usage: { inputTokens: 4, outputTokens: 0 } }
        }
      })
    );
    expect(portions.map((portion) => portion.model)).toEqual(["grok-4", "grok-4-fast"]);
    expect(portions.every((portion) => portion.costUsd === undefined)).toBe(true);
  });
});

describe("portionRequests (plan 3.4.1 step 4)", () => {
  it("counts 1 for a request record and the modelCalls of a turn or session record", () => {
    const usage = { inputTokens: 1, outputTokens: 1 };
    const request = record({ granularity: "request", timestamp: 0, usage });
    expect(portionRequests(request, 7)).toBe(1);
    const turn = record({ granularity: "turn", timestamp: 0, usage });
    expect(portionRequests(turn, 3)).toBe(3);
    expect(portionRequests(turn, undefined)).toBe(1);
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
      accumulator,
      seen
    );
    accumulateRecord(
      record({
        sessionId: "s2",
        timestamp: HOUR_9 * 1000 + 120_000,
        usage: { inputTokens: 50, outputTokens: 5 }
      }),
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
      accumulator,
      new Map()
    );
    expect(accumulator.buckets.get(`${HOUR_9}|claude-code|`)).toMatchObject({ model: "", requests: 1 });
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

  it("puts the logged amounts into the buckets and prices nothing else", async () => {
    const outcome = await runRefresh({
      platform: setup.platform,
      dataDir: setup.dataDir,
      log: silentLog,
      timeZone: TIME_ZONE
    });
    expect(outcome.result.records).toBe(4);
    expect(outcome.result.failures).toBe(0);

    const ledger = await openLedger(setup.platform, setup.dataDir);
    let rows: BucketRow[];
    try {
      rows = ledger.readBuckets();
    } finally {
      ledger.close();
    }

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

      const ledger = await openLedger(setup.platform, setup.dataDir);
      let rows: BucketRow[];
      try {
        rows = ledger.readBuckets();
      } finally {
        ledger.close();
      }
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

      const ledger = await openLedger(setup.platform, setup.dataDir);
      let rows: BucketRow[];
      try {
        rows = ledger.readBuckets();
      } finally {
        ledger.close();
      }
      // The record stays whole under its own model: no per-model rows, the turn's amount, its two calls.
      expect(rows.map((row) => [row.model, row.requests, row.costUsd])).toEqual([["grok-4", 2, 0.025]]);
      expect(rows[0]?.unpricedRequests).toBe(0);
    } finally {
      await setup.remove();
    }
  });
});
