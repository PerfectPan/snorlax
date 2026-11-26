import * as z from "zod/mini";

import { agentIdSchema, deviceIdSchema, nonNegativeIntSchema, nonNegativeNumberSchema } from "./shared.ts";

/** The bucket fields; both the lenient and the strict schema are built on this one shape. */
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
 * One hour of usage for one device, agent and model, holding absolute totals for that key.
 * The same row shape is the local ledger row (minus bookkeeping columns), the upload body row and the pull
 * result row; uploads carry only these fields. A count the log does not record is 0.
 */
export const bucketSchema = z.object(bucketFields);
export type Bucket = z.output<typeof bucketSchema>;

/**
 * The upload body row: the same fields as `bucketSchema`, but unknown keys are rejected
 * instead of dropped, so nothing beyond the bucket fields can pass validation.
 */
export const strictBucketSchema = z.strictObject(bucketFields);
export type StrictBucket = z.output<typeof strictBucketSchema>;

/**
 * The bucket column values in the ledger's and the worker store's column order (`hour` through
 * `unpricedRequests`, without the device or bookkeeping columns) — one list, so the two inserts cannot drift.
 */
export const bucketColumnValues = (
  bucket: Pick<
    Bucket,
    | "hour"
    | "agent"
    | "model"
    | "inputTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "outputTokens"
    | "reasoningTokens"
    | "requests"
    | "sessionsStarted"
    | "costUsd"
    | "unpricedRequests"
  >
): [number, string, string, number, number, number, number, number, number, number, number, number] => [
  bucket.hour,
  bucket.agent,
  bucket.model,
  bucket.inputTokens,
  bucket.cacheReadTokens,
  bucket.cacheWriteTokens,
  bucket.outputTokens,
  bucket.reasoningTokens,
  bucket.requests,
  bucket.sessionsStarted,
  bucket.costUsd,
  bucket.unpricedRequests
];
