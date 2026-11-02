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
  doctor: protocol.doctorSchema,
  "uninstall-result": protocol.uninstallResultSchema
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
