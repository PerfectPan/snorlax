import { litellmPrices } from "@rivus/agent-kit/cost/prices";

import type { UsageCounts } from "./agents.ts";

/**
 * What the kit's LiteLLM snapshot charges for one request of `model`, by the rule the kit documents for
 * `priceRecord` (README, `/cost`): input without cache, cache reads and cache writes (five-minute ones, the only
 * kind these fixtures write), and output, each at its price per million tokens. Tests read the snapshot's prices
 * through it instead of copying them, so a kit release that moves a price does not break them.
 */
export const snapshotCost = (model: string, usage: UsageCounts): number => {
  const price = litellmPrices[model];
  if (price === undefined) {
    throw new Error(`the kit's pricing snapshot has no ${model}`);
  }
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  return (
    ((usage.inputTokens - cacheRead - cacheWrite) * price.input +
      cacheRead * price.cacheRead +
      cacheWrite * price.cacheWrite +
      usage.outputTokens * price.output) /
    1_000_000
  );
};

/**
 * What the kit's LiteLLM snapshot charges for one request of `model` in its long-context tier, by the rule the
 * kit documents on `Price.longContext`: a single request whose total input — cache reads and writes included —
 * strictly exceeds the tier's `thresholdTokens` bills whole, every token of it, at the tier's rates, and a rate
 * the tier lacks keeps the model's base price. Like `snapshotCost`, it reads the snapshot's numbers instead of
 * copying them.
 */
export const snapshotTierCost = (model: string, usage: UsageCounts): number => {
  const price = litellmPrices[model];
  const tier = price?.longContext;
  if (price === undefined || tier === undefined) {
    throw new Error(`the kit's pricing snapshot has no long-context tier for ${model}`);
  }
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  return (
    ((usage.inputTokens - cacheRead - cacheWrite) * (tier.input ?? price.input) +
      cacheRead * (tier.cacheRead ?? price.cacheRead) +
      cacheWrite * (tier.cacheWrite ?? price.cacheWrite) +
      usage.outputTokens * (tier.output ?? price.output)) /
    1_000_000
  );
};
