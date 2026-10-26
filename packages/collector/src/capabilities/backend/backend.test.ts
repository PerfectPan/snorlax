import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";

import { Backend, type BackendCallFailure, type BackendFetch } from "./backend.ts";

/**
 * The HTTP client against an injected fetch. The 15s limit runs on the Effect clock: 14s leaves the request
 * unfinished, and one more second fails it as unreachable. No test waits on a real clock.
 */

const BASE = "https://snorlax.test/sync/";
const TOKEN = "device-token-do-not-leak";

const hanging: BackendFetch = (request) =>
  new Promise((_resolve, reject) => {
    const abort = (): void => {
      reject(new Error("aborted"));
    };
    if (request.signal.aborted) {
      abort();
      return;
    }
    request.signal.addEventListener("abort", abort, { once: true });
  });

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const run = <A>(
  fetchImpl: BackendFetch,
  effect: (backend: Backend["Service"]) => Effect.Effect<A, BackendCallFailure>
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* effect(yield* Backend);
    }).pipe(Effect.provide(Backend.layer(fetchImpl)))
  );

describe("request timeout", () => {
  it("is still running at 14s and fails as unreachable when the clock reaches 15s", async () => {
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const backend = yield* Backend;
        const fiber = yield* Effect.forkChild(backend.health(BASE));
        yield* TestClock.adjust(Duration.seconds(14));
        const pending = yield* Effect.sync(() => fiber.pollUnsafe());
        expect(pending).toBeUndefined();
        yield* TestClock.adjust(Duration.seconds(1));
        return yield* Effect.flip(Fiber.join(fiber));
      }).pipe(Effect.provide(Backend.layer(hanging)), Effect.provide(TestClock.layer()))
    );
    expect(error._tag).toBe("BackendUnreachable");
    expect(error.message).toContain("15s");
  });

  it("returns an immediate response without waiting out the timeout", async () => {
    const health = await run(
      async () => jsonResponse(200, { ok: true }),
      (backend) => backend.health(BASE)
    );
    expect(health).toEqual({ ok: true });
  });
});

describe("status mapping", () => {
  const device = { deviceId: "6f1c8d2e-4a3b-4c5d-9e6f-7a8b9c0d1e2f", name: "Mac" };
  const bucket = {
    deviceId: device.deviceId,
    hour: 1_700_000_000,
    agent: "claude-code",
    model: "claude-haiku-4-5",
    inputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 1,
    reasoningTokens: 0,
    requests: 1,
    sessionsStarted: 0,
    costUsd: 0,
    unpricedRequests: 0
  };

  const fail = async (
    fetchImpl: BackendFetch,
    effect: (backend: Backend["Service"]) => Effect.Effect<unknown, BackendCallFailure>
  ) => {
    const error = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function* () {
          return yield* effect(yield* Backend);
        }).pipe(Effect.provide(Backend.layer(fetchImpl)))
      )
    );
    expect(error.message).not.toContain(TOKEN);
    return error;
  };

  it("maps 401, 403, 5xx, other 4xx and a body that fails the schema", async () => {
    expect(
      (
        await fail(
          async () => jsonResponse(401, { error: { code: "unauthorized", message: "nope" } }),
          (backend) => backend.pushBuckets(BASE, TOKEN, device.deviceId, [bucket])
        )
      )._tag
    ).toBe("BackendUnauthorized");
    expect(
      (
        await fail(
          async () => jsonResponse(403, { error: { code: "forbidden", message: "nope" } }),
          (backend) => backend.listDevices(BASE, TOKEN)
        )
      )._tag
    ).toBe("BackendForbidden");
    expect(
      (
        await fail(
          async () => jsonResponse(503, { error: { code: "internal", message: "down" } }),
          (backend) => backend.health(BASE)
        )
      )._tag
    ).toBe("BackendUnreachable");
    expect(
      (
        await fail(
          async () => jsonResponse(409, { error: { code: "conflict", message: "exists" } }),
          (backend) => backend.registerDevice(BASE, TOKEN, device)
        )
      )._tag
    ).toBe("BackendConflict");
    expect(
      (
        await fail(
          async () => jsonResponse(400, { error: { code: "invalid-body", message: "bad" } }),
          (backend) => backend.pushBuckets(BASE, TOKEN, device.deviceId, [bucket])
        )
      )._tag
    ).toBe("BackendInvalidResponse");
    expect(
      (
        await fail(
          async () => jsonResponse(404, { error: { code: "not-found", message: "missing" } }),
          (backend) => backend.revokeDevice(BASE, TOKEN, device.deviceId)
        )
      )._tag
    ).toBe("BackendInvalidResponse");
    expect(
      (
        await fail(
          async () => jsonResponse(200, { nope: true }),
          (backend) => backend.health(BASE)
        )
      )._tag
    ).toBe("BackendInvalidResponse");
    expect(
      (
        await fail(
          async () => jsonResponse(201, { deviceToken: "" }),
          (backend) => backend.registerDevice(BASE, TOKEN, device)
        )
      )._tag
    ).toBe("BackendInvalidResponse");
  });

  it("maps a rejected fetch to unreachable and sends the bearer token only as a header", async () => {
    const seen: { authorization: string | null; contentType: string | null; url: string }[] = [];
    const fetchImpl: BackendFetch = async (request) => {
      seen.push({
        authorization: request.headers.get("authorization"),
        contentType: request.headers.get("content-type"),
        url: request.url
      });
      if (request.method === "GET" && request.url.endsWith("/v1/health")) {
        throw new Error("connect ECONNREFUSED");
      }
      if (request.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return jsonResponse(201, { deviceToken: "issued-token" });
    };
    const error = await fail(fetchImpl, (backend) => backend.health(BASE));
    expect(error._tag).toBe("BackendUnreachable");
    const registered = await run(fetchImpl, (backend) => backend.registerDevice(BASE, TOKEN, device));
    expect(registered.deviceToken).toBe("issued-token");
    await run(fetchImpl, (backend) => backend.revokeDevice(BASE, TOKEN, device.deviceId));

    expect(seen[0]?.authorization).toBeNull();
    expect(seen[0]?.contentType).toBeNull();
    expect(seen[1]?.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[1]?.contentType).toBe("application/json");
    expect(seen[1]?.url).toBe("https://snorlax.test/sync/v1/devices");
    expect(seen[2]?.contentType).toBeNull();
    expect(seen.map((call) => call.url).join(" ")).not.toContain(TOKEN);
  });

  it("names the status, a schema mismatch and a network failure differently", async () => {
    const forbidden = await fail(
      async () => jsonResponse(403, { error: { code: "forbidden", message: "nope" } }),
      (backend) => backend.listDevices(BASE, TOKEN)
    );
    expect(forbidden.message).toContain("HTTP 403");
    const missing = await fail(
      async () => jsonResponse(404, { error: { code: "not-found", message: "missing" } }),
      (backend) => backend.health(BASE)
    );
    expect(missing._tag).toBe("BackendInvalidResponse");
    expect(missing.message).toContain("HTTP 404");
    const invalid = await fail(
      async () => jsonResponse(200, { nope: true }),
      (backend) => backend.health(BASE)
    );
    expect(invalid.message).toContain("does not match the interface definition");
    const down = await fail(
      async () => Promise.reject(new Error("backend down")),
      (backend) => backend.health(BASE)
    );
    expect(down._tag).toBe("BackendUnreachable");
    expect(down.message).toContain("cannot reach the backend");
    expect(down.message).toContain("backend down");
  });

  it("turns a backend URL that is not a URL into unreachable", async () => {
    const error = await fail(
      async () => jsonResponse(200, { ok: true }),
      (backend) => backend.health("snorlax.example.com")
    );
    expect(error._tag).toBe("BackendUnreachable");
    expect(error.message).toContain('the backend URL "snorlax.example.com" cannot be used');
  });
});
