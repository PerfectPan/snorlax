import * as z from "zod/mini";

import {
  agentIdSchema,
  deviceIdSchema,
  nonNegativeIntSchema,
  schemaVersionSchema,
  syncStateSchema,
  utcTimestampSchema
} from "./shared.ts";
import { snapshotSchema } from "./snapshot.ts";

/**
 * The `--json` outputs of the `snorlax` CLI (plan 3.2.1). With `--json`, stdout carries exactly one JSON
 * object: one of the success shapes here, or `failureSchema` for any non-zero exit. Unknown keys are dropped
 * on parse, so a newer collector's output still decodes.
 */

/** Failure body printed on stdout (with `--json`) for every non-zero exit. */
export const failureSchema = z.object({
  schemaVersion: schemaVersionSchema,
  ok: z.literal(false),
  error: z.object({
    code: z.string().check(z.minLength(1)),
    message: z.string()
  })
});
export type Failure = z.output<typeof failureSchema>;

/** Known failure codes (plan 3.2.1) plus `invalid-arguments` for exit 2; the schema stays a plain string so new codes parse. */
export type FailureCode =
  | "invalid-arguments"
  | "locked"
  | "node-version"
  | "data-dir"
  | "keychain"
  | "network"
  | "unauthorized"
  | "forbidden"
  | "invalid-response"
  | "pricing"
  | "internal";

/** Success body of commands that have nothing to report (`unpair`, `install`). */
export const okSchema = z.object({
  schemaVersion: schemaVersionSchema,
  ok: z.literal(true)
});
export type Ok = z.output<typeof okSchema>;

/**
 * Success body of `uninstall`. `keptEntries` is present only when `--data` deleted the data directory's
 * snorlax entries: the entries it kept because snorlax did not write them, relative to the data directory and
 * sorted (`logs/<name>` for one inside `logs/`); empty when the directory itself was removed.
 */
export const uninstallResultSchema = z.object({
  schemaVersion: schemaVersionSchema,
  ok: z.literal(true),
  keptEntries: z.optional(z.array(z.string().check(z.minLength(1))))
});
export type UninstallResult = z.output<typeof uninstallResultSchema>;

/**
 * Success body of `snapshot --json` (plan 3.1): the snapshot itself is the file shape of 3.2.2, and
 * the command wraps it in the usual output envelope.
 */
export const snapshotOutputSchema = z.object({
  schemaVersion: schemaVersionSchema,
  ok: z.literal(true),
  snapshot: snapshotSchema
});
export type SnapshotOutput = z.output<typeof snapshotOutputSchema>;

/** Success body of `refresh` and `rebuild`; `sync.ok: false` still exits 0. */
export const refreshResultSchema = z.object({
  schemaVersion: schemaVersionSchema,
  ok: z.literal(true),
  scannedAt: utcTimestampSchema,
  records: nonNegativeIntSchema,
  failures: nonNegativeIntSchema,
  sync: z.object({
    ok: z.boolean(),
    pushed: nonNegativeIntSchema,
    pulled: nonNegativeIntSchema
  })
});
export type RefreshResult = z.output<typeof refreshResultSchema>;

/** Success body of `pair`. */
export const pairResultSchema = z.object({
  schemaVersion: schemaVersionSchema,
  ok: z.literal(true),
  deviceId: deviceIdSchema,
  name: z.string().check(z.minLength(1))
});
export type PairResult = z.output<typeof pairResultSchema>;

/** One detected agent as `status` lists them; stat-only detection, so `runnable` never appears. */
export const detectedAgentSchema = z.object({
  agent: agentIdSchema,
  displayName: z.string().check(z.minLength(1)),
  status: z.enum(["runnable", "found", "missing", "unknown"])
});
export type DetectedAgent = z.output<typeof detectedAgentSchema>;

/**
 * Success body of `status` (plan 3.1). `pricingChanged` is true when the ledger's costs were priced with another
 * pricing table than this collector's (plan 3.7); `snorlax rebuild --days 30` prices them again.
 */
export const statusSchema = z.object({
  schemaVersion: schemaVersionSchema,
  ok: z.literal(true),
  version: z.string().check(z.minLength(1)),
  dataDir: z.string().check(z.minLength(1)),
  device: z.object({
    id: z.nullable(deviceIdSchema),
    name: z.nullable(z.string())
  }),
  lastScanAt: z.nullable(utcTimestampSchema),
  sync: z.object({ state: syncStateSchema, at: z.nullable(utcTimestampSchema) }),
  failuresByAgent: z.record(agentIdSchema, nonNegativeIntSchema),
  pricingChanged: z.boolean(),
  agents: z.array(detectedAgentSchema)
});
export type Status = z.output<typeof statusSchema>;

/** One `doctor` check result. */
export const doctorCheckSchema = z.object({
  id: z.string().check(z.minLength(1)),
  status: z.enum(["ok", "warn", "error"]),
  detail: z.string()
});
export type DoctorCheck = z.output<typeof doctorCheckSchema>;

/**
 * Success body of `doctor`. The command exits 0 whenever it completes; `healthy` is false when any check
 * reported `error`, mirroring how a refresh whose sync failed still exits 0.
 */
export const doctorSchema = z.object({
  schemaVersion: schemaVersionSchema,
  ok: z.literal(true),
  healthy: z.boolean(),
  checks: z.array(doctorCheckSchema)
});
export type Doctor = z.output<typeof doctorSchema>;
