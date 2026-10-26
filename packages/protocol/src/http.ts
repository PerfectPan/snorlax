import * as z from "zod/mini";

import { bucketSchema, strictBucketSchema } from "./bucket.ts";
import { deviceIdSchema, nonNegativeIntSchema, utcTimestampSchema } from "./shared.ts";

/**
 * The HTTP API bodies and the pull query (plan 3.2.4). Request bodies are strict objects that reject unknown
 * keys, so nothing beyond the bucket fields can leave a machine (Spec R10, S15); response bodies stay lenient,
 * so a field a newer Worker adds still lets an older collector parse the rest, and the pull query ignores
 * parameters it does not define. The app has no HTTP client (plan 2.1) and consumes none of these shapes;
 * they serve the collector's sync client and the Worker's own validation.
 */

/** A device as `GET /v1/devices` lists it; `lastPushAt` is null before the device's first push. */
export const httpDeviceSchema = z.object({
  id: deviceIdSchema,
  name: z.string().check(z.minLength(1)),
  lastPushAt: z.nullable(utcTimestampSchema),
  revoked: z.boolean()
});
export type HttpDevice = z.output<typeof httpDeviceSchema>;

/** Response body of `GET /v1/devices` (any device token). */
export const httpDevicesResponseSchema = z.object({
  devices: z.array(httpDeviceSchema)
});
export type HttpDevicesResponse = z.output<typeof httpDevicesResponseSchema>;

/** Request body of `POST /v1/devices` (admin token). */
export const httpDeviceRegisterRequestSchema = z.strictObject({
  deviceId: deviceIdSchema,
  name: z.string().check(z.minLength(1))
});
export type HttpDeviceRegisterRequest = z.output<typeof httpDeviceRegisterRequestSchema>;

/**
 * RFC 6750 `b64token` (plan 3.2.4). The hyphen sits at the end of the class so it is not a range, and `=` is
 * only a suffix. A space or a newline cannot pass and later be spliced into a `security -i` command.
 */
const b64TokenSchema = z.string().check(z.regex(/^[A-Za-z0-9._~+/-]+=*$/));

/** Response body of `POST /v1/devices`; the token is shown once and stored only as its SHA-256 (plan 3.8). */
export const httpDeviceRegisterResponseSchema = z.object({
  deviceToken: b64TokenSchema
});
export type HttpDeviceRegisterResponse = z.output<typeof httpDeviceRegisterResponseSchema>;

/** Request body of `PUT /v1/devices/:id/buckets`: 1–200 rows, every row's `deviceId` equal to `:id`. */
export const httpPushRequestSchema = z.strictObject({
  buckets: z.array(strictBucketSchema).check(z.minLength(1), z.maxLength(200))
});
export type HttpPushRequest = z.output<typeof httpPushRequestSchema>;

/** Response body of `PUT /v1/devices/:id/buckets`: the highest sequence number the push wrote. */
export const httpPushResponseSchema = z.object({
  seq: nonNegativeIntSchema
});
export type HttpPushResponse = z.output<typeof httpPushResponseSchema>;

/** Query values are plain decimal integer strings (`0`, `123`); `0x10`, `1e1`, `-1`, `1.5`, `` all fail. */
const decimalIntegerSchema = z.pipe(z.string().check(z.regex(/^(0|[1-9][0-9]*)$/)), z.transform(Number));

/**
 * Query of `GET /v1/buckets?after=<seq>&limit=<n>` (any device token): `after` ≥ 0, default 0;
 * 1 ≤ `limit` ≤ 1000, default 1000.
 */
export const httpPullQuerySchema = z.object({
  after: z._default(decimalIntegerSchema, 0),
  limit: z._default(z.pipe(decimalIntegerSchema, z.number().check(z.minimum(1), z.maximum(1000))), 1000)
});

/**
 * Response body of `GET /v1/buckets`. `next` is the last returned row's seq whenever the page has rows, and
 * null only for an empty page. The client pulls until `next` is null.
 */
export const httpPullResponseSchema = z.object({
  buckets: z.array(bucketSchema),
  next: z.nullable(nonNegativeIntSchema)
});
export type HttpPullResponse = z.output<typeof httpPullResponseSchema>;

/** Response body of `GET /v1/health`. */
export const httpHealthResponseSchema = z.object({
  ok: z.literal(true)
});
export type HttpHealthResponse = z.output<typeof httpHealthResponseSchema>;

/**
 * Error body codes (plan 3.2.4): `invalid-body` 400, `unauthorized` 401, `forbidden` 403, `not-found` 404,
 * `conflict` 409, `payload-too-large` 413, `internal` 5xx. Unlike the CLI failure codes, the Worker owns the
 * whole API surface, so the schema enumerates them; a new status needs a new member here.
 */
export const httpErrorCodeSchema = z.enum([
  "invalid-body",
  "unauthorized",
  "forbidden",
  "not-found",
  "conflict",
  "payload-too-large",
  "internal"
]);
export type HttpErrorCode = z.output<typeof httpErrorCodeSchema>;

/** Error body of every non-2xx response (plan 3.2.4). */
export const httpErrorSchema = z.object({
  error: z.object({
    code: httpErrorCodeSchema,
    message: z.string()
  })
});
export type HttpError = z.output<typeof httpErrorSchema>;
