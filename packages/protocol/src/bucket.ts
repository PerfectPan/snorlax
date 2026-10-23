import * as z from "zod/mini";

import { agentIdSchema, deviceIdSchema, nonNegativeIntSchema, nonNegativeNumberSchema } from "./shared.ts";

/**
 * One hour of usage for one device, agent and model, holding absolute totals for that key (plan 3.3.1).
 * The same row shape is the local ledger row (minus bookkeeping columns), the upload body row and the pull
 * result row; uploads carry only these fields (Spec R10). A count the log does not record is 0.
 */
export const bucketSchema = z.object({
  deviceId: deviceIdSchema,
  /** UTC hour start, epoch seconds. */
  hour: nonNegativeIntSchema,
  agent: agentIdSchema,
  /** Model id as the agent logged it; empty string when the record names none. */
  model: z.string(),
  /** Includes cache reads and writes. */
  inputTokens: nonNegativeIntSchema,
  cacheReadTokens: nonNegativeIntSchema,
  cacheWriteTokens: nonNegativeIntSchema,
  /** Includes reasoning tokens. */
  outputTokens: nonNegativeIntSchema,
  reasoningTokens: nonNegativeIntSchema,
  requests: nonNegativeIntSchema,
  sessionsStarted: nonNegativeIntSchema,
  costUsd: nonNegativeNumberSchema,
  unpricedRequests: nonNegativeIntSchema
});
export type Bucket = z.output<typeof bucketSchema>;
