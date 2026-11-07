import { createPricing, priceRecord } from "@rivus/agent-kit/cost";
import { litellmPrices } from "@rivus/agent-kit/cost/prices";
import type { UsageRecord } from "@rivus/agent-kit/transcript/usage";
import { describe, expect, it } from "vite-plus/test";

import { accumulateRecord, createAccumulator, partRequestCounts } from "./buckets.ts";
import { snapshotCost, snapshotTierCost } from "../../../test/fixtures/pricing.ts";

/**
 * The bucket arithmetic of plan 3.4.1 step 4 and the pricing of one record through the kit: the kit's
 * `priceRecord` prices each record (the agent's own amount first, else the kit's LiteLLM snapshot), a
 * `turn` record splits by `usageByModel` with the kit's rule, a request whose model has no price counts
 * as unpriced, and snorlax divides a record's requests among its parts. What a refresh writes for real
 * fixture logs is pinned by the flow tests in `test/`.
 */

const HOUR_9 = Date.UTC(2026, 9, 22, 9) / 1000;

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

describe("accumulateRecord prices a long-context request through the kit's tier", () => {
  const tierModel = "gpt-6.1-sol";

  const bucketOf = (priced: UsageRecord) => {
    const accumulator = createAccumulator();
    accumulateRecord(priced, snapshotPricing, accumulator, new Map());
    return [...accumulator.buckets.values()][0];
  };

  it("bills a single request whose total input strictly exceeds the threshold whole at the tier, else at the base price", () => {
    const tier = litellmPrices[tierModel]?.longContext;
    if (tier === undefined) {
      throw new Error("the kit's pricing snapshot has no long-context tier for gpt-6.1-sol");
    }
    // A `request` record is one model call, so the tier applies to its total input, cache counts included.
    // The non-cache input alone stays 70k below the threshold; only the total — cache reads and writes
    // counted — crosses it. The expectation is `snapshotTierCost`'s: each count priced at the `gpt-6.1-sol`
    // tier's unit rate read from `litellmPrices`.
    const above = {
      inputTokens: tier.thresholdTokens + 50_000,
      cacheReadTokens: 100_000,
      cacheWriteTokens: 20_000,
      outputTokens: 20_000
    };
    // The two prices disagree by far enough that this pins the tier, not the base price.
    expect(snapshotTierCost(tierModel, above)).not.toBeCloseTo(snapshotCost(tierModel, above), 6);
    expect(bucketOf(record({ timestamp: 0, model: tierModel, usage: above }))?.costUsd).toBeCloseTo(
      snapshotTierCost(tierModel, above),
      10
    );
    // Equal to the threshold is not strictly above it, so the request bills at the base price.
    const atThreshold = { inputTokens: tier.thresholdTokens, outputTokens: 20_000 };
    expect(bucketOf(record({ timestamp: 0, model: tierModel, usage: atThreshold }))?.costUsd).toBeCloseTo(
      snapshotCost(tierModel, atThreshold),
      10
    );
  });
});
