import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import * as z from "zod/mini";
import { describe, expect, it } from "vite-plus/test";

import * as protocol from "../src/index.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const schemas: Readonly<Record<string, z.core.$ZodType>> = {
  bucket: protocol.bucketSchema,
  snapshot: protocol.snapshotSchema,
  ok: protocol.okSchema,
  failure: protocol.failureSchema,
  "refresh-result": protocol.refreshResultSchema,
  "pair-result": protocol.pairResultSchema,
  status: protocol.statusSchema,
  doctor: protocol.doctorSchema
};

const readJson = (dir: string, name: string): unknown =>
  JSON.parse(readFileSync(join(packageRoot, dir, `${name}.json`), "utf8"));

describe("committed generated output", () => {
  it("ships a JSON Schema export per shape that matches the zod definitions", () => {
    for (const [name, schema] of Object.entries(schemas)) {
      expect(readJson("schema", name)).toEqual(z.toJSONSchema(schema));
    }
  });

  it("ships a fixture per shape that its schema accepts", () => {
    for (const [name, schema] of Object.entries(schemas)) {
      const parsed = z.safeParse(schema, readJson("fixtures", name));
      expect(parsed.success, `${name} fixture must parse`).toBe(true);
    }
  });
});

describe("bucketSchema", () => {
  const valid: protocol.Bucket = {
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
    expect(z.safeParse(protocol.bucketSchema, valid).success).toBe(true);
  });

  it("rejects a negative token count, a non-uuid device id and a missing field", () => {
    expect(z.safeParse(protocol.bucketSchema, { ...valid, outputTokens: -1 }).success).toBe(false);
    expect(z.safeParse(protocol.bucketSchema, { ...valid, deviceId: "macbook-pro" }).success).toBe(false);
    expect(z.safeParse(protocol.bucketSchema, { ...valid, requests: undefined }).success).toBe(false);
  });

  it("drops unknown keys instead of failing, so rows from a newer collector still parse", () => {
    const parsed = z.parse(protocol.bucketSchema, { ...valid, newMetric: 7 });
    expect(parsed).toEqual(valid);
  });
});

describe("snapshotSchema", () => {
  const valid = z.parse(protocol.snapshotSchema, readJson("fixtures", "snapshot"));

  it("rejects a newer schemaVersion and an empty time zone", () => {
    expect(z.safeParse(protocol.snapshotSchema, { ...valid, schemaVersion: 2 }).success).toBe(false);
    expect(z.safeParse(protocol.snapshotSchema, { ...valid, timeZone: "" }).success).toBe(false);
  });

  it("rejects a UTC instant that carries a numeric offset", () => {
    expect(z.safeParse(protocol.snapshotSchema, { ...valid, generatedAt: "2026-10-22T12:35:12+08:00" }).success).toBe(
      false
    );
  });

  it("keeps local-hour offsets and local calendar days in their series", () => {
    expect(
      z.safeParse(protocol.snapshotSchema, {
        ...valid,
        hourlyToday: [{ hour: "2026-10-23T09:00:00+08:00", tokens: 1 }]
      }).success
    ).toBe(true);
    expect(
      z.safeParse(protocol.snapshotSchema, {
        ...valid,
        daily: [{ date: "2026-10-23T00:00:00Z", tokens: 1, costUsd: 0 }]
      }).success
    ).toBe(false);
  });
});

describe("cli output schemas", () => {
  it("gives the failure shape a non-empty error code and ok: false", () => {
    const failure = z.parse(protocol.failureSchema, readJson("fixtures", "failure"));
    expect(failure.ok).toBe(false);
    expect(failure.error.code.length).toBeGreaterThan(0);
  });

  it("keeps timestamps machine-checkable: the JSON Schema export marks them as date-time", () => {
    const generatedAt = z.toJSONSchema(protocol.snapshotSchema).properties?.generatedAt;
    expect(generatedAt).toMatchObject({ type: "string", format: "date-time" });
  });

  it("accepts any failure code string so new codes from a newer collector still parse", () => {
    expect(
      z.safeParse(protocol.failureSchema, { schemaVersion: 1, ok: false, error: { code: "new-code", message: "x" } })
        .success
    ).toBe(true);
  });
});
