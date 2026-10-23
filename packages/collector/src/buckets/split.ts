import type { UsageRecord } from "@rivus/agent-kit/transcript/usage";

/** Token counts of one portion, in the kit's convention (`@rivus/agent-kit` exports no `Usage` type). */
export type Usage = UsageRecord["usage"];

/**
 * One model's share of a record, as the bucket accumulator adds it. `model` is `undefined` when the record
 * names none; the bucket then uses the empty string (plan 3.3.1).
 */
export interface UsagePortion {
  readonly model: string | undefined;
  readonly usage: Usage;
  readonly modelCalls: number | undefined;
  readonly costUsd: number | undefined;
}

const portion = (
  model: string | undefined,
  usage: Usage,
  modelCalls: number | undefined,
  costUsd: number | undefined
): UsagePortion => ({
  model,
  usage,
  modelCalls,
  costUsd
});

/**
 * Splits a record into one portion per model, following the kit's `costOf`/`summarize` rule (plan 6.4
 * Batch 2; the kit exports no `portionsOf` until agent-kit K2): a `usageByModel` split replaces the
 * aggregate and wins over it — except when the agent logged a record-level amount that the split does not
 * divide among every model, in which case the record stays whole, because pricing its other models would
 * replace the agent's own amount.
 */
export function splitByModel(record: UsageRecord): UsagePortion[] {
  const split = Object.entries(record.usageByModel ?? {});
  const staysWhole =
    split.length === 0 ||
    (record.costUsd !== undefined &&
      record.costSource !== "pricing-table" &&
      !split.every(([, share]) => share.costUsd !== undefined));
  if (staysWhole) {
    return [portion(record.model, record.usage, record.modelCalls, record.costUsd)];
  }
  return split.map(([model, share]) => portion(model, share.usage, share.modelCalls, share.costUsd));
}
