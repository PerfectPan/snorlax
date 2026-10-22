import type { UsageRecord } from "@rivus/agent-kit/transcript/usage";

import type { BucketDelta } from "../ledger/ledger.ts";
import { splitByModel } from "./split.ts";

/** Sessions already counted in `sessions_seen`, by agent id then session id. */
export type SeenSessions = Map<string, Set<string>>;

/** A bucket delta being accumulated: the same fields, mutable while the scan runs. */
type MutableBucket = { -readonly [Field in keyof BucketDelta]: BucketDelta[Field] };

export interface Accumulator {
  /** Bucket deltas of this run, keyed by `${hour}|${agent}|${model}`. */
  readonly buckets: Map<string, MutableBucket>;
  /** Sessions first seen in this run, to insert into `sessions_seen`. */
  readonly newSessions: { agent: string; sessionId: string; firstHour: number }[];
}

export const createAccumulator = (): Accumulator => ({ buckets: new Map(), newSessions: [] });

/**
 * How many model requests one portion of a record stands for (plan 3.4.1 step 4): 1 for a `request`
 * record; for a `turn`/`session` aggregate the model's `modelCalls`, else the record's, else 1.
 */
export function portionRequests(record: UsageRecord, modelCalls: number | undefined): number {
  return record.granularity === "request" ? 1 : (modelCalls ?? record.modelCalls ?? 1);
}

const hourOf = (timestampMs: number): number => Math.floor(timestampMs / 3_600_000) * 3600;

/**
 * Adds one record's usage into the accumulator (plan 3.4.1 step 4). A count the log does not record adds
 * 0; a portion whose cost the agent did not log adds its requests to `unpricedRequests` (until Batch 5's
 * pricing table, every portion without a logged amount is unpriced). A session first seen adds 1 to the
 * `sessionsStarted` of the hour it was first seen, on the record's first portion's bucket.
 */
export function accumulateRecord(record: UsageRecord, into: Accumulator, seen: SeenSessions): void {
  const portions = splitByModel(record);
  const hour = hourOf(record.timestamp);
  const bucketOf = (model: string | undefined): MutableBucket => {
    const key = `${hour}|${record.agent}|${model ?? ""}`;
    const existing = into.buckets.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const bucket: MutableBucket = {
      hour,
      agent: record.agent,
      model: model ?? "",
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      requests: 0,
      sessionsStarted: 0,
      costUsd: 0,
      unpricedRequests: 0
    };
    into.buckets.set(key, bucket);
    return bucket;
  };

  const known = seen.get(record.agent);
  const isNewSession = known === undefined ? true : !known.has(record.sessionId);
  if (isNewSession) {
    const sessions = seen.get(record.agent) ?? new Set<string>();
    seen.set(record.agent, sessions);
    sessions.add(record.sessionId);
    into.newSessions.push({ agent: record.agent, sessionId: record.sessionId, firstHour: hour });
    bucketOf(portions[0]?.model).sessionsStarted += 1;
  }

  for (const part of portions) {
    const bucket = bucketOf(part.model);
    bucket.inputTokens += part.usage.inputTokens ?? 0;
    bucket.cacheReadTokens += part.usage.cacheReadTokens ?? 0;
    bucket.cacheWriteTokens += part.usage.cacheWriteTokens ?? 0;
    bucket.outputTokens += part.usage.outputTokens ?? 0;
    bucket.reasoningTokens += part.usage.reasoningTokens ?? 0;
    const requests = portionRequests(record, part.modelCalls);
    bucket.requests += requests;
    if (part.costUsd !== undefined) {
      bucket.costUsd += part.costUsd;
    } else {
      bucket.unpricedRequests += requests;
    }
  }
}
