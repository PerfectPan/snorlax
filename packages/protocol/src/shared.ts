import * as z from "zod/mini";

/**
 * Scalar shapes shared by the bucket, snapshot and CLI output schemas. Everything here is wire format:
 * the collector emits and parses these shapes, the Worker validates HTTP bodies against them (Batch 6) and
 * `scripts/generate.ts` exports them as JSON Schema for the Swift code generator (Batch 4).
 */

/** Every emitted shape carries this marker; the app refuses a newer value (plan 3.7). */
export const schemaVersionSchema = z.literal(1);

/** UTC instant with a `Z` suffix, as `Date.prototype.toISOString` writes it. */
export const utcTimestampSchema = z.iso.datetime();

/** Local hour of the hourly series, ISO with a numeric offset, e.g. `2026-10-22T09:00:00+08:00`. */
export const localHourTimestampSchema = z.iso.datetime({ offset: true });

/** Local calendar day, e.g. `2026-10-22`. */
export const localDateSchema = z.iso.date();

/** agent-kit `CodingAgentId`, an opaque slug such as `claude-code`. */
export const agentIdSchema = z.string().check(z.minLength(1));

/** Device ids are UUIDs generated once per data directory (plan 2.4 D7). */
export const deviceIdSchema = z.uuid();

export const nonNegativeIntSchema = z.int().check(z.minimum(0));

export const nonNegativeNumberSchema = z.number().check(z.minimum(0));

/** Sync states `status` and the snapshot report. */
export const syncStateSchema = z.enum(["ok", "failed", "unpaired", "revoked"]);
export type SyncState = z.output<typeof syncStateSchema>;
