import * as z from "zod/mini";

import {
  bucketSchema,
  httpDeviceRegisterRequestSchema,
  type HttpDevice,
  type HttpErrorCode,
  nonNegativeIntSchema,
  httpPushRequestSchema
} from "@rivus/snorlax-protocol";

import type { D1Database } from "./db.ts";
import { generateDeviceToken, hashToken, secretsEqual } from "./tokens.ts";

/**
 * The sync HTTP API of plan 3.2.4, as a plain `fetch` handler with `URLPattern` routes and no framework.
 * The handler takes `{ db, adminToken, now }`: `db` is the D1 subset of `db.ts` and `now` an injected
 * clock, so tests and a self-hosting server run it without the Workers runtime; `src/index.ts` is the
 * only Workers-specific piece. Unknown data — bodies, query strings, D1 rows — is parsed with zod at the
 * boundary; a failure inside the database surfaces as a 5xx error body (plan 3.6).
 */

/** Request bodies above 1 MB are rejected before parsing (plan 3.12). */
const MAX_BODY_BYTES = 1_000_000;
const MAX_PULL_LIMIT = 1_000;

/** HTTP status per error-body code; a code missing here fails to compile. */
const STATUS_BY_CODE: Record<HttpErrorCode, number> = {
  "invalid-body": 400,
  unauthorized: 401,
  forbidden: 403,
  "not-found": 404,
  conflict: 409,
  "payload-too-large": 413,
  internal: 500
};

/** An error carrying its error-body code; raised by this handler's own checks, answered by `createHandler`. */
class RequestFailure extends Error {
  readonly status: number;
  readonly code: HttpErrorCode;

  constructor(code: HttpErrorCode, message: string) {
    super(message);
    this.status = STATUS_BY_CODE[code];
    this.code = code;
  }
}

export type Handler = (request: Request) => Promise<Response>;

export interface HandlerEnv {
  readonly db: D1Database;
  readonly adminToken: string;
  /** Epoch milliseconds; `Date.now` in production, fixed or scripted in tests. */
  readonly now: () => number;
}

const routes = {
  health: new URLPattern({ pathname: "/v1/health" }),
  registerDevice: new URLPattern({ pathname: "/v1/devices" }),
  pushBuckets: new URLPattern({ pathname: "/v1/devices/:id/buckets" }),
  pullBuckets: new URLPattern({ pathname: "/v1/buckets" }),
  listDevices: new URLPattern({ pathname: "/v1/devices" }),
  revokeDevice: new URLPattern({ pathname: "/v1/devices/:id" })
} as const;

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const errorResponse = (status: number, code: HttpErrorCode, message: string): Response =>
  jsonResponse(status, { error: { code, message } });

const parseWith = <S extends z.core.$ZodType>(schema: S, data: unknown, what: string): z.output<S> => {
  const result = z.safeParse(schema, data);
  if (!result.success) {
    throw new RequestFailure("invalid-body", `${what} does not match the interface definition`);
  }
  return result.data;
};

/**
 * Reads the body as JSON, rejecting an oversized one by its declared length before reading and, while
 * streaming chunks in, by its actual bytes — a body over 1 MB is cut off instead of read to the end.
 */
const readBodyJson = async (request: Request): Promise<unknown> => {
  const tooLarge = (): RequestFailure =>
    new RequestFailure("payload-too-large", `request body exceeds ${MAX_BODY_BYTES} bytes`);
  const declaredLength = request.headers.get("Content-Length");
  if (declaredLength !== null && /^(0|[1-9][0-9]*)$/.test(declaredLength) && Number(declaredLength) > MAX_BODY_BYTES) {
    throw tooLarge();
  }
  const reader = request.body?.getReader();
  if (reader === undefined) {
    throw new RequestFailure("invalid-body", "request body is missing");
  }
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel();
      throw tooLarge();
    }
    body += decoder.decode(value, { stream: true });
  }
  try {
    return JSON.parse(body + decoder.decode()) as unknown;
  } catch {
    throw new RequestFailure("invalid-body", "request body is not valid JSON");
  }
};

const bearerToken = (request: Request): string | null => {
  const header = request.headers.get("Authorization");
  return header !== null && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
};

const requireAdmin = async (request: Request, env: HandlerEnv): Promise<void> => {
  const token = bearerToken(request);
  if (token === null || !(await secretsEqual(token, env.adminToken))) {
    throw new RequestFailure("unauthorized", "a valid admin token is required");
  }
};

interface AuthenticatedDevice {
  readonly id: string;
}

const authenticatedDeviceSchema = z.object({ id: z.uuid(), revoked_at: z.nullable(z.int()) });

/**
 * Authenticates a device token: D1 stores only the token's SHA-256 hex (plan 3.8), so the lookup is by
 * hash. A missing, unknown or revoked token is 401 (plan 3.2.4).
 */
const requireDevice = async (request: Request, env: HandlerEnv): Promise<AuthenticatedDevice> => {
  const token = bearerToken(request);
  if (token === null) {
    throw new RequestFailure("unauthorized", "a device token is required");
  }
  const row = await env.db
    .prepare("SELECT id, revoked_at FROM devices WHERE token_sha256 = ?1")
    .bind(await hashToken(token))
    .first();
  const parsed = row === null ? null : z.safeParse(authenticatedDeviceSchema, row);
  if (parsed === null || !parsed.success || parsed.data.revoked_at !== null) {
    throw new RequestFailure("unauthorized", "unknown or revoked token");
  }
  return { id: parsed.data.id };
};

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

const registerDevice = async (request: Request, env: HandlerEnv): Promise<Response> => {
  await requireAdmin(request, env);
  const body = parseWith(httpDeviceRegisterRequestSchema, await readBodyJson(request), "request body");
  // One atomic statement decides: a fresh id inserts and an already revoked id takes the guarded
  // overwrite — both report changes 1 — while an active device fails the guard and reports 0, the 409.
  // There is no read before the write for two concurrent registrations to race through. The overwrite
  // keeps created_at and last_push_at, so the usage history survives (Spec R11).
  const deviceToken = generateDeviceToken();
  const { meta } = await env.db
    .prepare(
      `INSERT INTO devices (id, name, token_sha256, created_at, last_push_at, revoked_at)
       VALUES (?1, ?2, ?3, ?4, NULL, NULL)
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name, token_sha256 = excluded.token_sha256, revoked_at = NULL
         WHERE devices.revoked_at IS NOT NULL`
    )
    .bind(body.deviceId, body.name, await hashToken(deviceToken), env.now())
    .run();
  if (meta.changes === 0) {
    throw new RequestFailure("conflict", `device ${body.deviceId} is already registered`);
  }
  return jsonResponse(201, { deviceToken });
};

const pushBuckets = async (request: Request, env: HandlerEnv, pathDeviceId: string): Promise<Response> => {
  const device = await requireDevice(request, env);
  if (device.id !== pathDeviceId) {
    throw new RequestFailure("forbidden", "a device token may only write its own device's path");
  }
  const body = parseWith(httpPushRequestSchema, await readBodyJson(request), "request body");
  for (const bucket of body.buckets) {
    if (bucket.deviceId !== pathDeviceId) {
      throw new RequestFailure("forbidden", "every bucket's deviceId must equal the path's device id");
    }
  }
  // One batch per push (plan 3.3.3): the first statement reads the current top seq, each row's upsert
  // then assigns the next one in order, and the batch ends with the device's last_push_at. The highest
  // seq written is therefore `base + row count`, computed from inside the same transaction.
  const statements = [
    env.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM buckets"),
    ...body.buckets.map((bucket) =>
      env.db
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
    env.db.prepare("UPDATE devices SET last_push_at = ?1 WHERE id = ?2").bind(env.now(), pathDeviceId)
  ];
  const results = await env.db.batch(statements);
  const baseRow = results[0]?.results[0];
  const base = z.parse(z.object({ seq: nonNegativeIntSchema }), baseRow ?? null).seq;
  return jsonResponse(200, { seq: base + body.buckets.length });
};

/** Query values are plain decimal integer strings (`0`, `123`); `0x10`, `1e1`, `-1`, `1.5`, `` all fail. */
const decimalInteger = z.pipe(z.string().check(z.regex(/^(0|[1-9][0-9]*)$/)), z.transform(Number));

const pullQuerySchema = z.object({
  after: z.optional(decimalInteger),
  limit: z.optional(z.pipe(decimalInteger, z.number().check(z.minimum(1), z.maximum(MAX_PULL_LIMIT))))
});

const pullRowSchema = z.intersection(bucketSchema, z.object({ seq: nonNegativeIntSchema }));

const BUCKET_COLUMNS =
  "device_id AS deviceId, hour, agent, model, input_tokens AS inputTokens, " +
  "cache_read_tokens AS cacheReadTokens, cache_write_tokens AS cacheWriteTokens, " +
  "output_tokens AS outputTokens, reasoning_tokens AS reasoningTokens, requests, " +
  "sessions_started AS sessionsStarted, cost_usd AS costUsd, unpriced_requests AS unpricedRequests";

const pullBuckets = async (request: Request, env: HandlerEnv): Promise<Response> => {
  await requireDevice(request, env);
  const query = parseWith(pullQuerySchema, Object.fromEntries(new URL(request.url).searchParams), "query string");
  const after = query.after ?? 0;
  const limit = query.limit ?? MAX_PULL_LIMIT;
  const result = await env.db
    .prepare(`SELECT ${BUCKET_COLUMNS}, seq FROM buckets WHERE seq > ?1 ORDER BY seq LIMIT ?2`)
    .bind(after, limit)
    .all();
  const rows = result.results.map((row) => z.parse(pullRowSchema, row));
  const last = rows.at(-1);
  const buckets = rows.map(({ seq, ...bucket }) => {
    void seq;
    return bucket;
  });
  return jsonResponse(200, {
    buckets,
    // `next` is the last returned seq, or null when fewer than `limit` rows remain (plan 3.2.4).
    next: rows.length < limit || last === undefined ? null : last.seq
  });
};

const listedDeviceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  last_push_at: z.nullable(z.int()),
  revoked_at: z.nullable(z.int())
});

const listDevices = async (request: Request, env: HandlerEnv): Promise<Response> => {
  await requireDevice(request, env);
  const result = await env.db
    .prepare("SELECT id, name, last_push_at, revoked_at FROM devices ORDER BY created_at, id")
    .all();
  const devices: HttpDevice[] = result.results.map((row) => {
    const parsed = z.parse(listedDeviceSchema, row);
    return {
      id: parsed.id,
      name: parsed.name,
      lastPushAt: parsed.last_push_at === null ? null : new Date(parsed.last_push_at).toISOString(),
      revoked: parsed.revoked_at !== null
    };
  });
  return jsonResponse(200, { devices });
};

const revokeDevice = async (request: Request, env: HandlerEnv, pathDeviceId: string): Promise<Response> => {
  await requireAdmin(request, env);
  const existing = await env.db.prepare("SELECT id FROM devices WHERE id = ?1").bind(pathDeviceId).first();
  if (existing === null || !z.safeParse(z.object({ id: z.string() }), existing).success) {
    throw new RequestFailure("not-found", `no device ${pathDeviceId}`);
  }
  await env.db.prepare("UPDATE devices SET revoked_at = ?1 WHERE id = ?2").bind(env.now(), pathDeviceId).run();
  return new Response(null, { status: 204 });
};

/** Builds the request handler; the routes and their patterns are built once per environment. */
export const createHandler = (env: HandlerEnv): Handler => {
  return async (request: Request): Promise<Response> => {
    try {
      const pathname = new URL(request.url).pathname;
      const pushMatch = request.method === "PUT" ? routes.pushBuckets.exec({ pathname }) : null;
      const revokeMatch = request.method === "DELETE" ? routes.revokeDevice.exec({ pathname }) : null;
      if (request.method === "GET" && routes.health.test({ pathname })) {
        return jsonResponse(200, { ok: true });
      }
      if (request.method === "POST" && routes.registerDevice.test({ pathname })) {
        return await registerDevice(request, env);
      }
      if (pushMatch !== null) {
        return await pushBuckets(request, env, pushMatch.pathname.groups.id ?? "");
      }
      if (request.method === "GET" && routes.pullBuckets.test({ pathname })) {
        return await pullBuckets(request, env);
      }
      if (request.method === "GET" && routes.listDevices.test({ pathname })) {
        return await listDevices(request, env);
      }
      if (revokeMatch !== null) {
        return await revokeDevice(request, env, revokeMatch.pathname.groups.id ?? "");
      }
      throw new RequestFailure("not-found", `no route for ${request.method} ${pathname}`);
    } catch (error) {
      if (error instanceof RequestFailure) {
        return errorResponse(error.status, error.code, error.message);
      }
      // The original error goes to the logs only; the body carries nothing from the inside.
      console.error("snorlax-worker: internal error", error);
      return errorResponse(500, "internal", "internal error");
    }
  };
};
