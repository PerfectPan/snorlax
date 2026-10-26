import { describe, expect, it, vi } from "vite-plus/test";

import {
  httpDeviceRegisterResponseSchema,
  httpDevicesResponseSchema,
  httpErrorSchema,
  httpHealthResponseSchema,
  httpPullResponseSchema
} from "@rivus/snorlax-protocol";

import * as z from "zod/mini";

import { createHandler } from "../src/handler.ts";
import { createSqliteD1 } from "../src/sqlite-d1.ts";
import {
  ADMIN_TOKEN,
  NOW_MS,
  bucketFixture,
  call,
  createTestBackend,
  deviceAId,
  deviceBId,
  jsonRequest,
  registerDevice
} from "./fixtures/backend.ts";

/**
 * Device ownership (Spec R11, S9): only the owning device's token writes, a revoked device's later
 * writes are rejected while its earlier buckets remain, and registration follows plan 3.2.4's token
 * rules (plan 3.8).
 */

describe("GET /v1/health", () => {
  it("answers without a token", async () => {
    const { handler } = createTestBackend();
    const { status, body } = await call(handler, jsonRequest("GET", "/v1/health"));
    expect(status).toBe(200);
    expect(z.parse(httpHealthResponseSchema, body)).toEqual({ ok: true });
  });
});

describe("POST /v1/devices", () => {
  it("registers a device and returns a base64url token shown once", async () => {
    const { handler } = createTestBackend();
    const { status, body } = await call(
      handler,
      jsonRequest("POST", "/v1/devices", { body: { deviceId: deviceAId, name: "MacBook Pro" }, token: ADMIN_TOKEN })
    );
    expect(status).toBe(201);
    const parsed = z.parse(httpDeviceRegisterResponseSchema, body);
    expect(parsed.deviceToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects a missing, wrong or device token with 401", async () => {
    const { handler } = createTestBackend();
    const withoutToken = await call(
      handler,
      jsonRequest("POST", "/v1/devices", { body: { deviceId: deviceAId, name: "x" } })
    );
    expect(withoutToken.status).toBe(401);
    const wrongToken = await call(
      handler,
      jsonRequest("POST", "/v1/devices", { body: { deviceId: deviceAId, name: "x" }, token: "not-the-admin-token" })
    );
    expect(wrongToken.status).toBe(401);
    expect(z.parse(httpErrorSchema, wrongToken.body).error.code).toBe("unauthorized");

    const { token } = await registerDevice(handler, deviceAId, "MacBook Pro");
    const deviceToken = await call(
      handler,
      jsonRequest("POST", "/v1/devices", { body: { deviceId: deviceBId, name: "x" }, token })
    );
    expect(deviceToken.status).toBe(401);
  });

  it("answers 409 while the id exists and is not revoked", async () => {
    const { handler } = createTestBackend();
    await registerDevice(handler, deviceAId, "MacBook Pro");
    const again = await call(
      handler,
      jsonRequest("POST", "/v1/devices", { body: { deviceId: deviceAId, name: "MacBook Pro" }, token: ADMIN_TOKEN })
    );
    expect(again.status).toBe(409);
    expect(z.parse(httpErrorSchema, again.body).error.code).toBe("conflict");
  });

  it("decides two concurrent registrations of one id atomically: one 201 with a usable token, one 409", async () => {
    const { handler } = createTestBackend();
    const body = { deviceId: deviceAId, name: "MacBook Pro" };
    const [first, second] = await Promise.all([
      call(handler, jsonRequest("POST", "/v1/devices", { body, token: ADMIN_TOKEN })),
      call(handler, jsonRequest("POST", "/v1/devices", { body, token: ADMIN_TOKEN }))
    ]);
    expect([first.status, second.status].sort((x, y) => x - y)).toEqual([201, 409]);
    const winner = first.status === 201 ? first : second;
    const { deviceToken } = z.parse(httpDeviceRegisterResponseSchema, winner.body);
    // The winning registration's token is the live one: it pushes.
    const push = await call(
      handler,
      jsonRequest("PUT", `/v1/devices/${deviceAId}/buckets`, {
        body: { buckets: [bucketFixture(deviceAId)] },
        token: deviceToken
      })
    );
    expect(push.status).toBe(200);
  });

  it("re-registers a revoked id under a fresh token and keeps its history", async () => {
    const { handler, database } = createTestBackend();
    const first = await registerDevice(handler, deviceAId, "MacBook Pro");
    await call(
      handler,
      jsonRequest("PUT", `/v1/devices/${deviceAId}/buckets`, {
        body: { buckets: [bucketFixture(deviceAId)] },
        token: first.token
      })
    );
    expect(
      (await call(handler, jsonRequest("DELETE", `/v1/devices/${deviceAId}`, { token: ADMIN_TOKEN }))).status
    ).toBe(204);

    const before = z.parse(
      z.object({ created_at: z.int(), last_push_at: z.nullable(z.int()) }),
      database.prepare("SELECT created_at, last_push_at FROM devices WHERE id = ?").get(deviceAId)
    );
    const second = await call(
      handler,
      jsonRequest("POST", "/v1/devices", { body: { deviceId: deviceAId, name: "MacBook Pro" }, token: ADMIN_TOKEN })
    );
    expect(second.status).toBe(201);
    const { deviceToken } = z.parse(httpDeviceRegisterResponseSchema, second.body);

    // The row's history is untouched by the re-registration, checked before the next push can move
    // last_push_at again.
    const after = z.parse(
      z.object({ created_at: z.int(), last_push_at: z.nullable(z.int()) }),
      database.prepare("SELECT created_at, last_push_at FROM devices WHERE id = ?").get(deviceAId)
    );
    expect(after).toEqual(before);

    // The old token is gone, the uploaded usage survived, and the new one works.
    expect(
      (
        await call(
          handler,
          jsonRequest("PUT", `/v1/devices/${deviceAId}/buckets`, {
            body: { buckets: [bucketFixture(deviceAId, { hour: 1 })] },
            token: first.token
          })
        )
      ).status
    ).toBe(401);
    const pull = await call(handler, jsonRequest("GET", "/v1/buckets", { token: deviceToken }));
    expect(z.parse(httpPullResponseSchema, pull.body).buckets).toEqual([bucketFixture(deviceAId)]);
    expect(
      (
        await call(
          handler,
          jsonRequest("PUT", `/v1/devices/${deviceAId}/buckets`, {
            body: { buckets: [bucketFixture(deviceAId, { hour: 1 })] },
            token: deviceToken
          })
        )
      ).status
    ).toBe(200);
    const devices = await call(handler, jsonRequest("GET", "/v1/devices", { token: deviceToken }));
    const listed = z.parse(httpDevicesResponseSchema, devices.body).devices;
    expect(listed).toEqual([{ id: deviceAId, name: "MacBook Pro", lastPushAt: expect.any(String), revoked: false }]);
  });

  it("answers a database failure with a fixed internal message and logs the original", async () => {
    const { database } = createTestBackend();
    const handler = createHandler({
      db: createSqliteD1(database),
      adminToken: ADMIN_TOKEN,
      now: () => NOW_MS
    });
    database.close();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { status, body } = await call(handler, jsonRequest("GET", "/v1/devices", { token: "any-token" }));
    expect(status).toBe(500);
    expect(body).toEqual({ error: { code: "internal", message: "internal error" } });
    // No SQL, no table names, no original message in the body.
    expect(JSON.stringify(body)).not.toMatch(/devices|SELECT|sqlite/i);
    expect(consoleError).toHaveBeenCalledWith("snorlax-worker: internal error", expect.anything());
    consoleError.mockRestore();
  });

  it("rejects a body with an unknown key, a bad UUID or a missing name", async () => {
    const { handler } = createTestBackend();
    for (const body of [
      { deviceId: deviceAId, name: "x", adminHint: "no" },
      { deviceId: "not-a-uuid", name: "x" },
      { deviceId: deviceAId }
    ]) {
      const { status } = await call(handler, jsonRequest("POST", "/v1/devices", { body, token: ADMIN_TOKEN }));
      expect(status).toBe(400);
    }
  });
});

describe("DELETE /v1/devices/:id", () => {
  it("revokes a device: its later writes are 401 and its buckets remain (Spec S9)", async () => {
    const { handler } = createTestBackend();
    const a = await registerDevice(handler, deviceAId, "Device A");
    const b = await registerDevice(handler, deviceBId, "Device B");
    await call(
      handler,
      jsonRequest("PUT", `/v1/devices/${deviceAId}/buckets`, {
        body: { buckets: [bucketFixture(deviceAId)] },
        token: a.token
      })
    );

    const revoked = await call(handler, jsonRequest("DELETE", `/v1/devices/${deviceAId}`, { token: ADMIN_TOKEN }));
    expect(revoked.status).toBe(204);
    expect(revoked.body).toBeNull();

    const after = await call(
      handler,
      jsonRequest("PUT", `/v1/devices/${deviceAId}/buckets`, {
        body: { buckets: [bucketFixture(deviceAId, { hour: 2 })] },
        token: a.token
      })
    );
    expect(after.status).toBe(401);
    expect(z.parse(httpErrorSchema, after.body).error.code).toBe("unauthorized");

    // Revoking A is also a revoked token for reads, and B still sees the usage A uploaded.
    expect((await call(handler, jsonRequest("GET", "/v1/devices", { token: a.token }))).status).toBe(401);
    const pull = await call(handler, jsonRequest("GET", "/v1/buckets", { token: b.token }));
    expect(pull.status).toBe(200);
    expect(pull.body).toMatchObject({ buckets: [bucketFixture(deviceAId)], next: null });
  });

  it("answers 404 for an unknown id, keeping the owner's secret check distinguishable", async () => {
    const { handler } = createTestBackend();
    const { status, body } = await call(
      handler,
      jsonRequest("DELETE", `/v1/devices/${deviceAId}`, { token: ADMIN_TOKEN })
    );
    expect(status).toBe(404);
    expect(z.parse(httpErrorSchema, body).error.code).toBe("not-found");
  });

  it("requires the admin token", async () => {
    const { handler } = createTestBackend();
    const a = await registerDevice(handler, deviceAId, "Device A");
    const { status } = await call(handler, jsonRequest("DELETE", `/v1/devices/${deviceBId}`, { token: a.token }));
    expect(status).toBe(401);
  });

  it("revoking an already revoked device stays 204", async () => {
    const { handler } = createTestBackend();
    await registerDevice(handler, deviceAId, "Device A");
    expect(
      (await call(handler, jsonRequest("DELETE", `/v1/devices/${deviceAId}`, { token: ADMIN_TOKEN }))).status
    ).toBe(204);
    expect(
      (await call(handler, jsonRequest("DELETE", `/v1/devices/${deviceAId}`, { token: ADMIN_TOKEN }))).status
    ).toBe(204);
  });
});

describe("GET /v1/devices", () => {
  it("lists every device with its push time and revoked flag", async () => {
    const { handler } = createTestBackend();
    const a = await registerDevice(handler, deviceAId, "Device A");
    await registerDevice(handler, deviceBId, "Device B");
    await call(
      handler,
      jsonRequest("PUT", `/v1/devices/${deviceAId}/buckets`, {
        body: { buckets: [bucketFixture(deviceAId)] },
        token: a.token
      })
    );
    const { status, body } = await call(handler, jsonRequest("GET", "/v1/devices", { token: a.token }));
    expect(status).toBe(200);
    // Both registered at the same injected instant, so the id tie-break orders B first.
    expect(z.parse(httpDevicesResponseSchema, body).devices).toEqual([
      { id: deviceBId, name: "Device B", lastPushAt: null, revoked: false },
      { id: deviceAId, name: "Device A", lastPushAt: "2026-10-26T12:00:00.000Z", revoked: false }
    ]);
  });

  it("requires any device token", async () => {
    const { handler } = createTestBackend();
    expect((await call(handler, jsonRequest("GET", "/v1/devices"))).status).toBe(401);
    expect((await call(handler, jsonRequest("GET", "/v1/devices", { token: ADMIN_TOKEN }))).status).toBe(401);
  });
});

describe("routing", () => {
  it("answers 404 with an error body for an unknown route", async () => {
    const { handler } = createTestBackend();
    const { status, body } = await call(handler, jsonRequest("GET", "/v1/nothing"));
    expect(status).toBe(404);
    expect(z.parse(httpErrorSchema, body).error.code).toBe("not-found");

    const wrongMethod = await call(handler, jsonRequest("GET", `/v1/devices/${deviceAId}/buckets`));
    expect(wrongMethod.status).toBe(404);
  });
});
