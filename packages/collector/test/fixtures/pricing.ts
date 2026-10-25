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
