import * as z from "zod/mini";

import { agentIdSchema, deviceIdSchema, nonNegativeIntSchema, nonNegativeNumberSchema } from "./shared.ts";

/** The bucket fields (plan 3.3.1); both the lenient and the strict schema are built on this one shape. */
const bucketFields = {
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
};

/**
 * One hour of usage for one device, agent and model, holding absolute totals for that key (plan 3.3.1).
 * The same row shape is the local ledger row (minus bookkeeping columns), the upload body row and the pull
 * result row; uploads carry only these fields (Spec R10). A count the log does not record is 0.
 */
export const bucketSchema = z.object(bucketFields);
export type Bucket = z.output<typeof bucketSchema>;

/**
 * The upload body row (plan 3.2.3): the same fields as `bucketSchema`, but unknown keys are rejected
 * instead of dropped, so nothing beyond the bucket fields can pass validation (Spec R10, S15).
 */
export const strictBucketSchema = z.strictObject(bucketFields);
export type StrictBucket = z.output<typeof strictBucketSchema>;
