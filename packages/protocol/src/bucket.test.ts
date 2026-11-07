import * as z from "zod/mini";
import { describe, expect, it } from "vite-plus/test";

import { bucketSchema, type Bucket } from "./bucket.ts";

describe("bucketSchema", () => {
  const valid: Bucket = {
    deviceId: "6f1c8d2e-4a3b-4c5d-9e6f-7a8b9c0d1e2f",
    hour: 1_792_658_000,
    agent: "claude-code",
    model: "",
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

  it("accepts a bucket with an empty model and zero counts", () => {
    expect(z.safeParse(bucketSchema, valid).success).toBe(true);
  });

  it("rejects a negative token count, a non-uuid device id and a missing field", () => {
    expect(z.safeParse(bucketSchema, { ...valid, outputTokens: -1 }).success).toBe(false);
    expect(z.safeParse(bucketSchema, { ...valid, deviceId: "macbook-pro" }).success).toBe(false);
    expect(z.safeParse(bucketSchema, { ...valid, requests: undefined }).success).toBe(false);
  });

  it("drops unknown keys instead of failing, so rows from a newer collector still parse", () => {
    const parsed = z.parse(bucketSchema, { ...valid, newMetric: 7 });
    expect(parsed).toEqual(valid);
  });
});
