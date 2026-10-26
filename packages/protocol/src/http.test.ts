import * as z from "zod/mini";
import { describe, expect, it } from "vite-plus/test";

import { bucketSchema, type StrictBucket } from "./bucket.ts";
import { httpErrorSchema, httpPullResponseSchema, httpPushRequestSchema, type HttpPushRequest } from "./http.ts";

describe("httpPushRequestSchema (Spec R10, S15)", () => {
  const validBucket: StrictBucket = {
    deviceId: "6f1c8d2e-4a3b-4c5d-9e6f-7a8b9c0d1e2f",
    hour: 1_792_658_000,
    agent: "claude-code",
    model: "claude-opus-5-5",
    inputTokens: 10,
    cacheReadTokens: 4,
    cacheWriteTokens: 2,
    outputTokens: 5,
    reasoningTokens: 1,
    requests: 1,
    sessionsStarted: 0,
    costUsd: 0,
    unpricedRequests: 0
  };
  const validBody: HttpPushRequest = { buckets: [validBucket] };

  it("accepts a 1-row and a 200-row push, and rejects 0 or 201 rows", () => {
    expect(z.safeParse(httpPushRequestSchema, validBody).success).toBe(true);
    expect(z.safeParse(httpPushRequestSchema, { buckets: Array(200).fill(validBucket) }).success).toBe(true);
    expect(z.safeParse(httpPushRequestSchema, { buckets: [] }).success).toBe(false);
    expect(z.safeParse(httpPushRequestSchema, { buckets: Array(201).fill(validBucket) }).success).toBe(false);
  });

  it("rejects a push body with an unknown key, so prompts and paths cannot ride along", () => {
    expect(z.safeParse(httpPushRequestSchema, { ...validBody, prompt: "summarize this diff" }).success).toBe(false);
    expect(z.safeParse(httpPushRequestSchema, { ...validBody, projectPath: "repo" }).success).toBe(false);
  });

  it("rejects a row carrying a session id or any other field beyond the bucket fields", () => {
    expect(z.safeParse(httpPushRequestSchema, { buckets: [{ ...validBucket, sessionId: "s-1" }] }).success).toBe(false);
    expect(z.safeParse(httpPushRequestSchema, { buckets: [{ ...validBucket, cwd: "/tmp/repo" }] }).success).toBe(false);
  });

  it("keeps the lenient bucket schema dropping unknown keys for pull results", () => {
    const parsed = z.parse(bucketSchema, { ...validBucket, newMetric: 7 });
    expect(parsed).toEqual(validBucket);
    expect(z.parse(httpPullResponseSchema, { buckets: [{ ...validBucket, newMetric: 7 }], next: null })).toEqual({
      buckets: [validBucket],
      next: null
    });
  });
});

describe("httpErrorSchema", () => {
  it("accepts every enumerated code and rejects an unknown one", () => {
    for (const code of [
      "invalid-body",
      "unauthorized",
      "forbidden",
      "not-found",
      "conflict",
      "payload-too-large",
      "internal"
    ]) {
      expect(z.safeParse(httpErrorSchema, { error: { code, message: "x" } }).success).toBe(true);
    }
    expect(z.safeParse(httpErrorSchema, { error: { code: "teapot", message: "x" } }).success).toBe(false);
  });
});
