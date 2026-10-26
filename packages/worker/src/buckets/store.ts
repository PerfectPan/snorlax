import * as z from "zod/mini";

import { bucketSchema, nonNegativeIntSchema, type Bucket } from "@rivus/snorlax-protocol";

import type { D1Database } from "../db.ts";

/**
 * SQL on `buckets` (plan 3.3.3), including the push batch's `devices.last_push_at` update. Rows are parsed
 * with zod at this boundary, so the use cases see typed values.
 */

const PUT_BUCKET_SQL = `INSERT INTO buckets (device_id, hour, agent, model, input_tokens, cache_read_tokens,
                     cache_write_tokens, output_tokens, reasoning_tokens, requests, sessions_started, cost_usd, unpriced_requests, seq)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
        (SELECT COALESCE(MAX(seq), 0) + 1 FROM buckets))
ON CONFLICT (device_id, hour, agent, model) DO UPDATE SET
  input_tokens = excluded.input_tokens, cache_read_tokens = excluded.cache_read_tokens,
  cache_write_tokens = excluded.cache_write_tokens, output_tokens = excluded.output_tokens,
  reasoning_tokens = excluded.reasoning_tokens, requests = excluded.requests,
  sessions_started = excluded.sessions_started, cost_usd = excluded.cost_usd,
  unpriced_requests = excluded.unpriced_requests, seq = excluded.seq`;

const seqSchema = z.object({ seq: nonNegativeIntSchema });

/**
 * Writes one push as one batch: the first statement reads the current top seq, each row's upsert then
 * assigns the next one in order, and the batch ends with the device's `last_push_at`. Returns the top seq
 * the first statement read, from inside the batch's transaction, so a concurrent push never counts in it.
 */
export const writePush = async (
  db: D1Database,
  deviceId: string,
  buckets: readonly Bucket[],
  pushedAt: number
): Promise<number> => {
  const statements = [
    db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM buckets"),
    ...buckets.map((bucket) =>
      db
        .prepare(PUT_BUCKET_SQL)
        .bind(
          bucket.deviceId,
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
        )
    ),
    db.prepare("UPDATE devices SET last_push_at = ?1 WHERE id = ?2").bind(pushedAt, deviceId)
  ];
  const results = await db.batch(statements);
  return z.parse(seqSchema, results[0]?.results[0] ?? null).seq;
};

const BUCKET_COLUMNS =
  "device_id AS deviceId, hour, agent, model, input_tokens AS inputTokens, " +
  "cache_read_tokens AS cacheReadTokens, cache_write_tokens AS cacheWriteTokens, " +
  "output_tokens AS outputTokens, reasoning_tokens AS reasoningTokens, requests, " +
  "sessions_started AS sessionsStarted, cost_usd AS costUsd, unpriced_requests AS unpricedRequests";

const sequencedBucketSchema = z.intersection(bucketSchema, seqSchema);

/** Up to `limit` buckets whose seq is above `after`, in seq order, each with its seq. */
export const readBucketsAfter = async (
  db: D1Database,
  after: number,
  limit: number
): Promise<Array<Bucket & { readonly seq: number }>> => {
  const result = await db
    .prepare(`SELECT ${BUCKET_COLUMNS}, seq FROM buckets WHERE seq > ?1 ORDER BY seq LIMIT ?2`)
    .bind(after, limit)
    .all();
  return result.results.map((row) => z.parse(sequencedBucketSchema, row));
};
