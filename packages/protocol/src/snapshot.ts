import * as z from "zod/mini";

import {
  agentIdSchema,
  deviceIdSchema,
  localDateSchema,
  localHourTimestampSchema,
  nonNegativeIntSchema,
  nonNegativeNumberSchema,
  schemaVersionSchema,
  syncStateSchema,
  utcTimestampSchema
} from "./shared.ts";

/**
 * The snapshot file `<data>/snapshot.json` (plan 3.2.2): the whole file is rewritten atomically after every
 * refresh. Windows (today, the last 7 and the last 30 days) follow the time zone of the device that shows
 * them (Spec R8); `tokens` is `inputTokens + outputTokens` in the kit convention.
 */

/** Totals of one window. */
export const windowTotalSchema = z.object({
  tokens: nonNegativeIntSchema,
  inputTokens: nonNegativeIntSchema,
  outputTokens: nonNegativeIntSchema,
  cacheReadTokens: nonNegativeIntSchema,
  costUsd: nonNegativeNumberSchema,
  requests: nonNegativeIntSchema,
  sessions: nonNegativeIntSchema,
  unpricedRequests: nonNegativeIntSchema
});
export type WindowTotal = z.output<typeof windowTotalSchema>;

export const byAgentEntrySchema = z.object({
  agent: agentIdSchema,
  today: windowTotalSchema,
  last7d: windowTotalSchema,
  last30d: windowTotalSchema
});
export type ByAgentEntry = z.output<typeof byAgentEntrySchema>;

export const byModelEntrySchema = z.object({
  model: z.string(),
  today: windowTotalSchema,
  last7d: windowTotalSchema,
  last30d: windowTotalSchema
});
export type ByModelEntry = z.output<typeof byModelEntrySchema>;

export const byDeviceEntrySchema = z.object({
  deviceId: deviceIdSchema,
  name: z.nullable(z.string()),
  isThisDevice: z.boolean(),
  lastPushAt: z.nullable(utcTimestampSchema),
  today: windowTotalSchema,
  last7d: windowTotalSchema,
  last30d: windowTotalSchema
});
export type ByDeviceEntry = z.output<typeof byDeviceEntrySchema>;

/** One local day of the daily series; covers the last 30 local days including today. */
export const dailyEntrySchema = z.object({
  date: localDateSchema,
  tokens: nonNegativeIntSchema,
  costUsd: nonNegativeNumberSchema
});
export type DailyEntry = z.output<typeof dailyEntrySchema>;

/** One local hour of today. */
export const hourlyEntrySchema = z.object({
  hour: localHourTimestampSchema,
  tokens: nonNegativeIntSchema
});
export type HourlyEntry = z.output<typeof hourlyEntrySchema>;

export const snapshotStatusSchema = z.object({
  lastScanAt: z.nullable(utcTimestampSchema),
  sync: z.object({ state: syncStateSchema, at: z.nullable(utcTimestampSchema) }),
  failuresByAgent: z.record(agentIdSchema, nonNegativeIntSchema),
  paired: z.boolean()
});
export type SnapshotStatus = z.output<typeof snapshotStatusSchema>;

export const snapshotSchema = z.object({
  schemaVersion: schemaVersionSchema,
  generatedAt: utcTimestampSchema,
  timeZone: z.string().check(z.minLength(1)),
  totals: z.object({
    today: windowTotalSchema,
    last7d: windowTotalSchema,
    last30d: windowTotalSchema
  }),
  byAgent: z.array(byAgentEntrySchema),
  byModel: z.array(byModelEntrySchema),
  byDevice: z.array(byDeviceEntrySchema),
  daily: z.array(dailyEntrySchema),
  hourlyToday: z.array(hourlyEntrySchema),
  status: snapshotStatusSchema
});
export type Snapshot = z.output<typeof snapshotSchema>;
