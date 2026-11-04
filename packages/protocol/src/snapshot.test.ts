import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as z from "zod/mini";
import { describe, expect, it } from "vite-plus/test";

import { snapshotSchema } from "./snapshot.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const readJson = (dir: string, name: string): unknown =>
  JSON.parse(readFileSync(join(packageRoot, dir, `${name}.json`), "utf8"));

describe("snapshotSchema", () => {
  const valid = z.parse(snapshotSchema, readJson("fixtures", "snapshot"));

  it("rejects a newer schemaVersion and an empty time zone", () => {
    expect(z.safeParse(snapshotSchema, { ...valid, schemaVersion: 2 }).success).toBe(false);
    expect(z.safeParse(snapshotSchema, { ...valid, timeZone: "" }).success).toBe(false);
  });

  it("rejects a UTC instant that carries a numeric offset", () => {
    expect(z.safeParse(snapshotSchema, { ...valid, generatedAt: "2026-10-22T12:35:12+08:00" }).success).toBe(false);
  });

  it("keeps local-hour offsets and local calendar days in their series", () => {
    expect(
      z.safeParse(snapshotSchema, {
        ...valid,
        hourlyToday: [{ hour: "2026-10-23T09:00:00+08:00", tokens: 1 }]
      }).success
    ).toBe(true);
    expect(
      z.safeParse(snapshotSchema, {
        ...valid,
        daily: [{ date: "2026-10-23T00:00:00Z", tokens: 1, costUsd: 0 }]
      }).success
    ).toBe(false);
  });
});
