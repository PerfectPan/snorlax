import type { UsageRecord } from "@rivus/agent-kit/transcript/usage";

import { splitByModel, type UsagePortion } from "./split.ts";

/** One local bucket row: the protocol's bucket fields plus the `dirty` upload flag (plan 3.3.2). */
export interface BucketRow {
  readonly hour: number;
  readonly agent: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly requests: number;
  readonly sessionsStarted: number;
  readonly costUsd: number;
  readonly unpricedRequests: number;
  readonly dirty: boolean;
}

/** What a scan adds to one bucket before it is written; `dirty` is always set on write. */
export type BucketDelta = Omit<BucketRow, "dirty">;

/** One `remote_buckets` row as pulled from the backend; empty until sync arrives (Batch 7). */
export interface RemoteBucketRow extends Omit<BucketRow, "dirty"> {
  readonly deviceId: string;
  readonly seq: number;
}

/** One `remote_devices` row. */
export interface RemoteDeviceRow {
  readonly id: string;
  readonly name: string;
  readonly lastPushAt: number | null;
  readonly revoked: boolean;
}

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

/** A portion's usage in the kit's `tokens` convention: input plus output. */
const portionTokens = (portion: UsagePortion): number =>
  (portion.usage.inputTokens ?? 0) + (portion.usage.outputTokens ?? 0);

/**
 * How many model requests each portion of a record stands for (plan 3.4.1 step 4): every portion of a
 * `request` record counts 1; without a split, a `turn`/`session` record counts its `modelCalls`, else 1.
 * A split record that reports the record's `modelCalls`: a portion naming its own `modelCalls` keeps it,
 * and the calls left over — never below zero — go to the token-largest portion without a count of its own,
 * so the portions add back up to the record's calls; the other missing portions count 0 (a Grok turn logs
 * per-model calls only when the log carries them). Known counts that already exceed the record's leave the
 * missing portions at 0. Without the record's `modelCalls`, every portion counts its own, else 1.
 */
export function portionRequestCounts(record: UsageRecord, portions: readonly UsagePortion[]): number[] {
  if (record.granularity === "request") {
    return portions.map(() => 1);
  }
  if (record.modelCalls === undefined) {
    return portions.map((portion) => portion.modelCalls ?? 1);
  }
  let remainder = record.modelCalls;
  let largest = -1;
  const known: (number | undefined)[] = portions.map((portion, index) => {
    if (portion.modelCalls !== undefined) {
      remainder -= portion.modelCalls;
      return portion.modelCalls;
    }
    const largestSoFar = portions[largest];
    if (largest < 0 || (largestSoFar !== undefined && portionTokens(portion) > portionTokens(largestSoFar))) {
      largest = index;
    }
    return undefined;
  });
  if (largest < 0) {
    return known.map((count) => count ?? 0);
  }
  const leftover = Math.max(remainder, 0);
  return known.map((count, index) => count ?? (index === largest ? leftover : 0));
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
  const requests = portionRequestCounts(record, portions);
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

  for (const [index, part] of portions.entries()) {
    const bucket = bucketOf(part.model);
    bucket.inputTokens += part.usage.inputTokens ?? 0;
    bucket.cacheReadTokens += part.usage.cacheReadTokens ?? 0;
    bucket.cacheWriteTokens += part.usage.cacheWriteTokens ?? 0;
    bucket.outputTokens += part.usage.outputTokens ?? 0;
    bucket.reasoningTokens += part.usage.reasoningTokens ?? 0;
    const counted = requests[index] ?? 0;
    bucket.requests += counted;
    if (part.costUsd !== undefined) {
      bucket.costUsd += part.costUsd;
    } else {
      bucket.unpricedRequests += counted;
    }
  }
}
