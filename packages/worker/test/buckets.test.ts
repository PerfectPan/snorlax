import { describe, expect, it } from "vite-plus/test";

import { httpErrorSchema, httpPullResponseSchema, httpPushResponseSchema, type Bucket } from "@rivus/snorlax-protocol";
import * as z from "zod/mini";

import {
  bucketFixture,
  call,
  createTestBackend,
  deviceAId,
  deviceBId,
  jsonRequest,
  registerDevice
} from "./fixtures/backend.ts";

/**
 * The bucket endpoints of plan 3.2.4: absolute-value upserts, server-assigned sequence numbers that
 * grow and re-expose a replaced row, cursor pagination, the 1–200 row bound, strict bodies and the
 * 1 MB request-body limit.
 */

const HOUR = Date.UTC(2026, 9, 26, 11) / 1000;

const push = async (
  handler: ReturnType<typeof createTestBackend>["handler"],
  token: string,
  buckets: Bucket[],
  pathDeviceId: string = deviceAId
) => call(handler, jsonRequest("PUT", `/v1/devices/${pathDeviceId}/buckets`, { body: { buckets }, token }));

const pull = async (handler: ReturnType<typeof createTestBackend>["handler"], token: string, query = "") =>
  call(handler, jsonRequest("GET", `/v1/buckets${query}`, { token }));

describe("PUT /v1/devices/:id/buckets", () => {
  it("stores rows and answers with the highest seq written", async () => {
    const { handler } = createTestBackend();
    const a = await registerDevice(handler, deviceAId, "Device A");
    const { status, body } = await push(handler, a.token, [
      bucketFixture(deviceAId, { hour: HOUR }),
      bucketFixture(deviceAId, { hour: HOUR + 3600, agent: "codex" })
    ]);
    expect(status).toBe(200);
    expect(z.parse(httpPushResponseSchema, body)).toEqual({ seq: 2 });
  });

  it("replaces a pushed bucket instead of adding one (absolute totals, Spec S8)", async () => {
    const { handler } = createTestBackend();
    const a = await registerDevice(handler, deviceAId, "Device A");
    await push(handler, a.token, [bucketFixture(deviceAId)]);
    const second = await push(handler, a.token, [bucketFixture(deviceAId, { requests: 9, costUsd: 1.25 })]);
    expect(second.status).toBe(200);
    expect(z.parse(httpPushResponseSchema, second.body)).toEqual({ seq: 2 });

    const { body } = await pull(handler, a.token);
    expect(z.parse(httpPullResponseSchema, body).buckets).toEqual([
      bucketFixture(deviceAId, { requests: 9, costUsd: 1.25 })
    ]);
  });

  it("gives a replaced row a new seq, so other devices pull it again", async () => {
    const { handler } = createTestBackend();
    const a = await registerDevice(handler, deviceAId, "Device A");
    const b = await registerDevice(handler, deviceBId, "Device B");
    await push(handler, a.token, [bucketFixture(deviceAId, { hour: HOUR })]);
    await push(handler, a.token, [bucketFixture(deviceAId, { hour: HOUR + 3600 })]);
    await push(handler, a.token, [bucketFixture(deviceAId, { hour: HOUR, requests: 100 })]);

    // A cursor past the first two seqs returns only the replacement, with its new values.
    const after = await pull(handler, b.token, "?after=2");
    expect(z.parse(httpPullResponseSchema, after.body)).toEqual({
      buckets: [bucketFixture(deviceAId, { hour: HOUR, requests: 100 })],
      next: null
    });
  });

  it("keeps one sequence across devices", async () => {
    const { handler } = createTestBackend();
    const a = await registerDevice(handler, deviceAId, "Device A");
    const b = await registerDevice(handler, deviceBId, "Device B");
    expect(z.parse(httpPushResponseSchema, (await push(handler, a.token, [bucketFixture(deviceAId)])).body).seq).toBe(
      1
    );
    expect(
      z.parse(httpPushResponseSchema, (await push(handler, b.token, [bucketFixture(deviceBId)], deviceBId)).body).seq
    ).toBe(2);
    expect(
      z.parse(httpPushResponseSchema, (await push(handler, a.token, [bucketFixture(deviceAId, { hour: 1 })])).body).seq
    ).toBe(3);
  });

  it("rejects a bucket whose deviceId differs from the path id with 403 and writes nothing (Spec S9)", async () => {
    const { handler } = createTestBackend();
    const a = await registerDevice(handler, deviceAId, "Device A");
    const b = await registerDevice(handler, deviceBId, "Device B");

    // A's token on B's path.
    const foreignPath = await push(handler, a.token, [bucketFixture(deviceBId)], deviceBId);
    expect(foreignPath.status).toBe(403);
    expect(z.parse(httpErrorSchema, foreignPath.body).error.code).toBe("forbidden");

    // A's path, but a row naming B.
    const foreignRow = await push(handler, a.token, [bucketFixture(deviceAId), bucketFixture(deviceBId, { hour: 2 })]);
    expect(foreignRow.status).toBe(403);
    expect(z.parse(httpErrorSchema, foreignRow.body).error.code).toBe("forbidden");

    const { body } = await pull(handler, b.token);
    expect(z.parse(httpPullResponseSchema, body).buckets).toEqual([]);
  });

  it("rejects an empty push, more than 200 rows, and unknown keys in the body or a row", async () => {
    const { handler } = createTestBackend();
    const a = await registerDevice(handler, deviceAId, "Device A");
    for (const buckets of [[], Array.from({ length: 201 }, (_, i) => bucketFixture(deviceAId, { hour: i }))]) {
      expect((await push(handler, a.token, buckets)).status).toBe(400);
    }
    const unknownTopKey = await call(
      handler,
      jsonRequest("PUT", `/v1/devices/${deviceAId}/buckets`, {
        body: { buckets: [bucketFixture(deviceAId)], prompt: "summarize this diff" },
        token: a.token
      })
    );
    expect(unknownTopKey.status).toBe(400);
    const unknownRowKey = await call(
      handler,
      jsonRequest("PUT", `/v1/devices/${deviceAId}/buckets`, {
        body: { buckets: [{ ...bucketFixture(deviceAId), projectPath: "/tmp/repo" }] },
        token: a.token
      })
    );
    expect(unknownRowKey.status).toBe(400);
  });

  it("answers 413 for a body over 1 MB, by declared length and while streaming", async () => {
    const { handler } = createTestBackend();
    const a = await registerDevice(handler, deviceAId, "Device A");
    const url = `https://snorlax.test/v1/devices/${deviceAId}/buckets`;

    // Both bodies are ten 600 kB chunks, six times the limit. They end, so a missing limit fails these
    // assertions: draining an endless stream that a pull refills synchronously never yields to the timers,
    // and the test would hang instead of timing out.
    const CHUNKS = 10;

    // Node adds no Content-Length for a string body, so the header goes on explicitly to lock the
    // declared-length branch: the request is refused before one byte is read from the body.
    let declaredReads = 0;
    const declaredBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        declaredReads += 1;
        controller.enqueue(new Uint8Array(600_000).fill(0x20));
        if (declaredReads === CHUNKS) {
          controller.close();
        }
      }
    });
    const declared = await call(
      handler,
      new Request(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${a.token}`,
          "Content-Type": "application/json",
          "Content-Length": "1000001"
        },
        body: declaredBody,
        duplex: "half"
      } as RequestInit)
    );
    expect(declared.status).toBe(413);
    expect(z.parse(httpErrorSchema, declared.body).error.code).toBe("payload-too-large");
    // The stream itself fills its queue to highWaterMark 1 before the handler runs; any further pull
    // would mean the handler started consuming, which the declared-length refusal must not do.
    expect(declaredReads).toBeLessThanOrEqual(1);

    // No declared length: reading stops as soon as the limit is crossed. The stream holds far more than
    // 1 MB, so few pulls prove the body was cut off, not drained.
    let produced = 0;
    const chunk = new Uint8Array(600_000).fill(0x20);
    const oversized = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1;
        controller.enqueue(chunk);
        if (produced === CHUNKS) {
          controller.close();
        }
      }
    });
    const streamed = await call(
      handler,
      new Request(url, {
        method: "PUT",
        headers: { Authorization: `Bearer ${a.token}`, "Content-Type": "application/json" },
        body: oversized,
        duplex: "half"
      } as RequestInit)
    );
    expect(streamed.status).toBe(413);
    expect(z.parse(httpErrorSchema, streamed.body).error.code).toBe("payload-too-large");
    // One pull fills the stream's queue and two more cross the limit: a drained body would be pulled all
    // ten times instead of stopping at three.
    expect(produced).toBeLessThanOrEqual(3);
  });

  it("rejects invalid JSON and a non-integer token count with 400", async () => {
    const { handler } = createTestBackend();
    const a = await registerDevice(handler, deviceAId, "Device A");
    const url = `https://snorlax.test/v1/devices/${deviceAId}/buckets`;
    const malformed = await call(
      handler,
      new Request(url, { method: "PUT", headers: { Authorization: `Bearer ${a.token}` }, body: "{not json" })
    );
    expect(malformed.status).toBe(400);
    expect(z.parse(httpErrorSchema, malformed.body).error.code).toBe("invalid-body");

    const badCounts = await push(handler, a.token, [bucketFixture(deviceAId, { requests: 1.5 })]);
    expect(badCounts.status).toBe(400);
  });

  it.each([
    ["no", undefined],
    ["a text", "text/plain;charset=UTF-8"]
  ])("answers a valid body sent with %s Content-Type with 400 naming the header", async (_, contentType) => {
    const { handler } = createTestBackend();
    const a = await registerDevice(handler, deviceAId, "Device A");
    const request = new Request(`https://snorlax.test/v1/devices/${deviceAId}/buckets`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${a.token}` },
      body: JSON.stringify({ buckets: [bucketFixture(deviceAId)] })
    });
    // A string body gets `text/plain;charset=UTF-8` from the Request constructor unless the header is removed.
    if (contentType === undefined) {
      request.headers.delete("Content-Type");
    }
    expect(request.headers.get("Content-Type")).toBe(contentType ?? null);
    const { status, body } = await call(handler, request);
    expect(status).toBe(400);
    expect(z.parse(httpErrorSchema, body).error).toEqual({
      code: "invalid-body",
      message: "request body must be sent with Content-Type: application/json"
    });
  });

  it("answers a body sent as JSON that does not parse with 400 invalid-body, not 500", async () => {
    const { handler } = createTestBackend();
    const a = await registerDevice(handler, deviceAId, "Device A");
    const { status, body } = await call(
      handler,
      new Request(`https://snorlax.test/v1/devices/${deviceAId}/buckets`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${a.token}`, "Content-Type": "application/json" },
        body: "{not json"
      })
    );
    expect(status).toBe(400);
    expect(z.parse(httpErrorSchema, body).error.code).toBe("invalid-body");
  });

  it("requires the device's own token (401 for none, unknown or revoked)", async () => {
    const { handler } = createTestBackend();
    const a = await registerDevice(handler, deviceAId, "Device A");
    await registerDevice(handler, deviceBId, "Device B");
    expect((await push(handler, "unknown-token", [bucketFixture(deviceAId)])).status).toBe(401);
    expect((await push(handler, a.token, [bucketFixture(deviceAId, { hour: 5 })], deviceBId)).status).toBe(403);
  });
});

describe("GET /v1/buckets", () => {
  it("pulls every bucket in seq order with next null when fewer than the limit remain", async () => {
    const { handler } = createTestBackend();
    const a = await registerDevice(handler, deviceAId, "Device A");
    const b = await registerDevice(handler, deviceBId, "Device B");
    await push(handler, a.token, [
      bucketFixture(deviceAId, { hour: HOUR }),
      bucketFixture(deviceAId, { hour: HOUR + 3600, agent: "codex", requests: 2 })
    ]);
    await push(handler, b.token, [bucketFixture(deviceBId, { hour: HOUR, agent: "grok", requests: 3 })], deviceBId);

    const { body } = await pull(handler, b.token);
    expect(z.parse(httpPullResponseSchema, body)).toEqual({
      buckets: [
        bucketFixture(deviceAId, { hour: HOUR }),
        bucketFixture(deviceAId, { hour: HOUR + 3600, agent: "codex", requests: 2 }),
        bucketFixture(deviceBId, { hour: HOUR, agent: "grok", requests: 3 })
      ],
      next: null
    });
  });

  it("paginates by cursor: limit 2 returns the third row afterwards and then nothing", async () => {
    const { handler } = createTestBackend();
    const a = await registerDevice(handler, deviceAId, "Device A");
    for (let hour = 0; hour < 3; hour += 1) {
      await push(handler, a.token, [bucketFixture(deviceAId, { hour: hour * 3600 })]);
    }
    const first = z.parse(httpPullResponseSchema, (await pull(handler, a.token, "?limit=2")).body);
    expect(first.buckets.map((bucket) => bucket.hour)).toEqual([0, 3600]);
    expect(first.next).toBe(2);

    const second = z.parse(httpPullResponseSchema, (await pull(handler, a.token, "?after=2&limit=2")).body);
    expect(second.buckets.map((bucket) => bucket.hour)).toEqual([7200]);
    expect(second.next).toBeNull();
  });

  it("defaults to 1000 rows and rejects out-of-range or non-integer query values", async () => {
    const { handler } = createTestBackend();
    const a = await registerDevice(handler, deviceAId, "Device A");
    for (let hour = 0; hour < 3; hour += 1) {
      await push(handler, a.token, [bucketFixture(deviceAId, { hour: hour * 3600 })]);
    }
    expect((await pull(handler, a.token)).body).toMatchObject({ next: null });

    for (const query of [
      "?limit=0",
      "?limit=1001",
      "?limit=abc",
      "?after=-1",
      "?after=1.5",
      "?after=x",
      "?after=",
      "?after=0x10",
      "?after=1e1"
    ]) {
      expect((await pull(handler, a.token, query)).status).toBe(400);
    }
  });

  it("requires a device token", async () => {
    const { handler } = createTestBackend();
    expect((await call(handler, jsonRequest("GET", "/v1/buckets"))).status).toBe(401);
  });
});
