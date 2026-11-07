import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as z from "zod/mini";
import { describe, expect, it } from "vite-plus/test";

import { failureSchema } from "./cli.ts";
import { snapshotSchema } from "./snapshot.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const readJson = (dir: string, name: string): unknown =>
  JSON.parse(readFileSync(join(packageRoot, dir, `${name}.json`), "utf8"));

describe("cli output schemas", () => {
  it("gives the failure shape a non-empty error code and ok: false", () => {
    const failure = z.parse(failureSchema, readJson("fixtures", "failure"));
    expect(failure.ok).toBe(false);
    expect(failure.error.code.length).toBeGreaterThan(0);
  });

  it("keeps timestamps machine-checkable: the JSON Schema export marks them as date-time", () => {
    const generatedAt = z.toJSONSchema(snapshotSchema).properties?.generatedAt;
    expect(generatedAt).toMatchObject({ type: "string", format: "date-time" });
  });

  it("accepts any failure code string so new codes from a newer collector still parse", () => {
    expect(
      z.safeParse(failureSchema, { schemaVersion: 1, ok: false, error: { code: "new-code", message: "x" } }).success
    ).toBe(true);
  });
});
