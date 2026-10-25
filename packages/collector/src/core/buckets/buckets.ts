import { priceRecord, type PricedPart, type Pricing } from "@rivus/agent-kit/cost";
import type { UsageRecord } from "@rivus/agent-kit/transcript/usage";

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

/** A part's usage in the kit's `tokens` convention: input plus output. */
const partTokens = (part: PricedPart): number => (part.usage.inputTokens ?? 0) + (part.usage.outputTokens ?? 0);

/**
 * How many model requests each part of a priced record stands for (plan 3.4.1 step 4): every part of a
 * `request` record counts 1; a whole `turn`/`session` record counts its `modelCalls`, else 1. The kit gives a
 * part of a split only its own share's `modelCalls`, so a split record that reports the record's `modelCalls`
 * divides them here: a part naming its own `modelCalls` keeps it, and the calls left over — never below zero —
 * go to the token-largest part without a count of its own, so the parts add back up to the record's calls; the
 * other missing parts count 0 (a Grok turn logs per-model calls only when the log carries them). Known counts
 * that already exceed the record's leave the missing parts at 0. Without the record's `modelCalls`, every part
 * counts its own, else 1.
 */
export function partRequestCounts(record: UsageRecord, parts: readonly PricedPart[]): number[] {
  if (record.granularity === "request") {
    return parts.map(() => 1);
  }
  if (record.modelCalls === undefined) {
    return parts.map((part) => part.modelCalls ?? 1);
  }
  let remainder = record.modelCalls;
  let largest = -1;
  const known: (number | undefined)[] = parts.map((part, index) => {
    if (part.modelCalls !== undefined) {
      remainder -= part.modelCalls;
      return part.modelCalls;
    }
    const largestSoFar = parts[largest];
    if (largest < 0 || (largestSoFar !== undefined && partTokens(part) > partTokens(largestSoFar))) {
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
 * Adds one record's usage into the accumulator (plan 3.4.1 step 4). The kit's `priceRecord` decides the parts
 * and their costs — the agent's own amount, else the table's prices times the record's multiplier — so snorlax
 * keeps only its own rules: the bucket key, the requests each part counts, and sessions. A count the log does not
 * record adds 0; a part without a cost adds its requests to `unpricedRequests` and nothing to `costUsd`. A session
 * first seen adds 1 to the `sessionsStarted` of the hour it was first seen, on the record's first part's bucket.
 */
export function accumulateRecord(record: UsageRecord, pricing: Pricing, into: Accumulator, seen: SeenSessions): void {
  const { parts } = priceRecord(record, pricing);
  const requests = partRequestCounts(record, parts);
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
    bucketOf(parts[0]?.model).sessionsStarted += 1;
  }

  for (const [index, part] of parts.entries()) {
    const bucket = bucketOf(part.model);
    bucket.inputTokens += part.usage.inputTokens ?? 0;
    bucket.cacheReadTokens += part.usage.cacheReadTokens ?? 0;
    bucket.cacheWriteTokens += part.usage.cacheWriteTokens ?? 0;
    bucket.outputTokens += part.usage.outputTokens ?? 0;
    bucket.reasoningTokens += part.usage.reasoningTokens ?? 0;
    const counted = requests[index] ?? 0;
    bucket.requests += counted;
    if (part.cost !== undefined) {
      bucket.costUsd += part.cost.costUsd;
    } else {
      bucket.unpricedRequests += counted;
    }
  }
}
