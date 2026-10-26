import { sValidator } from "@hono/standard-validator";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";

import {
  httpDeviceRegisterRequestSchema,
  httpPullQuerySchema,
  httpPushRequestSchema,
  type HttpDeviceRegisterResponse,
  type HttpDevicesResponse,
  type HttpHealthResponse,
  type HttpPullResponse,
  type HttpPushResponse
} from "@rivus/snorlax-protocol";

import { pullBuckets, pushBuckets } from "../buckets/buckets.ts";
import type { D1Database } from "../db.ts";
import {
  authenticateDevice,
  listDevices,
  registerDevice,
  revokeDevice,
  type AuthenticatedDevice
} from "../devices/devices.ts";
import { errorResponse, failureResponse } from "./failures.ts";

/**
 * The sync HTTP API of plan 3.2.4 as a Hono app (plan 2.4 D14, 3.12.1). Everything HTTP stays here: the
 * `Authorization` header, the body limit, validation of bodies and the pull query with the protocol schemas,
 * status codes and the error funnel. The use cases below take parsed values. The app needs only fetch and
 * WebCrypto, so it runs on Node too; `src/index.ts` is the only Workers-specific file.
 */

export interface AppDeps {
  readonly db: D1Database;
  readonly adminToken: string;
  /** Epoch milliseconds; `Date.now` in production, fixed or scripted in tests. */
  readonly now: () => number;
}

/** Request bodies above 1 MB are refused (plan 3.12). */
const MAX_BODY_BYTES = 1_000_000;

interface AppEnv {
  Variables: { device: AuthenticatedDevice };
}

/**
 * A `bearerAuth` failure option answering 401 with the JSON error body. Every failure takes one, because Hono
 * answers a malformed `Authorization` header with a plain-text 400 by default and plan 3.2.4 says 401.
 */
const unauthenticated = (message: string) => ({ message: () => failureResponse("Unauthenticated", message) });

export const createApp = ({ db, adminToken, now }: AppDeps): Hono<AppEnv> => {
  const adminOnly = bearerAuth<AppEnv>({
    token: adminToken,
    noAuthenticationHeader: unauthenticated("a valid admin token is required"),
    invalidAuthenticationHeader: unauthenticated("a valid admin token is required"),
    invalidToken: unauthenticated("a valid admin token is required")
  });
  // An unknown or revoked token throws the use case's own error, which the funnel answers.
  const anyDevice = bearerAuth<AppEnv>({
    verifyToken: async (token, c) => {
      c.set("device", await authenticateDevice(db, token));
      return true;
    },
    noAuthenticationHeader: unauthenticated("a device token is required"),
    invalidAuthenticationHeader: unauthenticated("a device token is required"),
    invalidToken: unauthenticated("unknown or revoked token")
  });
  const limitBody = bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => failureResponse("PayloadTooLarge", `request body exceeds ${MAX_BODY_BYTES} bytes`)
  });
  const rejectInvalid = (result: { readonly success: boolean; readonly target: string }): Response | undefined =>
    result.success
      ? undefined
      : failureResponse(
          "InvalidBody",
          `${result.target === "query" ? "query string" : "request body"} does not match the interface definition`
        );

  const app = new Hono<AppEnv>();

  app.get("/v1/health", (c) => c.json({ ok: true } satisfies HttpHealthResponse));

  app.post(
    "/v1/devices",
    adminOnly,
    limitBody,
    sValidator("json", httpDeviceRegisterRequestSchema, rejectInvalid),
    async (c) => {
      const deviceToken = await registerDevice({ db, now }, c.req.valid("json"));
      return c.json({ deviceToken } satisfies HttpDeviceRegisterResponse, 201);
    }
  );

  app.put(
    "/v1/devices/:id/buckets",
    anyDevice,
    limitBody,
    sValidator("json", httpPushRequestSchema, rejectInvalid),
    async (c) => {
      const seq = await pushBuckets(
        { db, now },
        { deviceId: c.get("device").id, pathDeviceId: c.req.param("id"), buckets: c.req.valid("json").buckets }
      );
      return c.json({ seq } satisfies HttpPushResponse);
    }
  );

  app.get("/v1/buckets", anyDevice, sValidator("query", httpPullQuerySchema, rejectInvalid), async (c) =>
    c.json((await pullBuckets(db, c.req.valid("query"))) satisfies HttpPullResponse)
  );

  app.get("/v1/devices", anyDevice, async (c) => {
    const devices = (await listDevices(db)).map((device) => ({
      ...device,
      lastPushAt: device.lastPushAt === null ? null : new Date(device.lastPushAt).toISOString()
    }));
    return c.json({ devices } satisfies HttpDevicesResponse);
  });

  app.delete("/v1/devices/:id", adminOnly, async (c) => {
    await revokeDevice({ db, now }, c.req.param("id"));
    return c.body(null, 204);
  });

  app.notFound((c) => failureResponse("NoRoute", `no route for ${c.req.method} ${c.req.path}`));
  app.onError((error) => errorResponse(error));

  return app;
};
