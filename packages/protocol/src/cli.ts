import * as z from "zod/mini";

import {
  agentIdSchema,
  deviceIdSchema,
  nonNegativeIntSchema,
  schemaVersionSchema,
  syncStateSchema,
  utcTimestampSchema
} from "./shared.ts";

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

/** Success body of commands that have nothing to report (`unpair`, `install`, `uninstall`). */
export const okSchema = z.object({
  schemaVersion: schemaVersionSchema,
  ok: z.literal(true)
});
export type Ok = z.output<typeof okSchema>;

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

/** Success body of `status` (plan 3.1). */
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
