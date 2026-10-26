import { readdir, readFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

/**
 * Plan 3.12.1 rule 1 over every source file under `src/` except unit tests, as one pure function of the
 * files' paths and texts: imports go `index.ts` → `http/` → `devices/`, `buckets/` → the files at the top of
 * `src/` and never back; only `index.ts` and `http/` import `hono` or `@hono/*`; the two domain folders do not
 * import each other; and a `store.ts` is imported only by its own folder's use-case file (and by tests, which
 * this check does not read). All three import forms count — `from "…"`, side-effect `import "…"` and dynamic
 * `import("…")`. Relative specifiers are resolved against the importing file's directory, a specifier naming
 * `src/` or one of its folders stands for that folder's `index.ts`, and the package's own name resolves through
 * its `exports`.
 */

type Part = "entry" | "http" | "domain" | "base";

/** Lowest first: a file may import its own part or any part after it. */
const RANK: Readonly<Record<Part, number>> = { entry: 0, http: 1, domain: 2, base: 3 };

const DOMAINS: ReadonlySet<string> = new Set(["devices", "buckets"]);

type Rule = "layout" | "framework-import" | "upward-import" | "cross-domain" | "foreign-store";

interface Violation {
  readonly rule: Rule;
  /** The offending file from `src/`. */
  readonly file: string;
  /** The specifier as written, for the import rules. */
  readonly import?: string;
}

interface SourceFile {
  /** From `src/`, `/`-separated. */
  readonly path: string;
  readonly text: string;
}

/** Every module specifier in the file, whichever import form carries it. */
const importSpecs = (text: string): string[] =>
  [...text.matchAll(/(?:\bfrom\s+|\bimport\s+|\bimport\()\s*["']([^"']+)["']/g)].map((match) => match[1] ?? "");

/** The part of the layout a path lies in; undefined outside it, including paths that leave `src/`. */
const partOf = (path: string): Part | undefined => {
  const segments = path.split("/");
  if (path === "index.ts") {
    return "entry";
  }
  if (segments.length === 1) {
    return "base";
  }
  if (segments.length === 2 && segments[0] === "http") {
    return "http";
  }
  return segments.length === 2 && DOMAINS.has(segments[0] ?? "") ? "domain" : undefined;
};

const isFrameworkSpec = (spec: string): boolean => /^(?:hono(?:\/|$)|@hono\/)/.test(spec);

/** The package's `exports` (package.json), from `src/`. */
const SELF_EXPORTS: ReadonlyMap<string, string> = new Map([
  ["@rivus/snorlax-worker", "http/app.ts"],
  ["@rivus/snorlax-worker/sqlite-d1", "sqlite-d1.ts"]
]);

/** The folders of the layout, each of which a directory import names by its `index.ts`. */
const FOLDERS: ReadonlySet<string> = new Set(["http", ...DOMAINS]);

/** The path from `src/` a specifier names; undefined for another package. */
const resolveSpec = (folder: string, spec: string): string | undefined => {
  if (!spec.startsWith(".")) {
    return SELF_EXPORTS.get(spec);
  }
  const target = posix.join(folder, spec).replace(/\/$/, "");
  if (target === ".") {
    return "index.ts";
  }
  return FOLDERS.has(target) ? `${target}/index.ts` : target;
};

function structureViolations(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const { path, text } of files) {
    const part = partOf(path);
    if (part === undefined) {
      violations.push({ rule: "layout", file: path });
      continue;
    }
    const folder = posix.dirname(path);
    for (const spec of importSpecs(text)) {
      const report = (rule: Rule): void => {
        violations.push({ rule, file: path, import: spec });
      };
      if (isFrameworkSpec(spec) && part !== "entry" && part !== "http") {
        report("framework-import");
      }
      const target = resolveSpec(folder, spec);
      const targetPart = target === undefined ? undefined : partOf(target);
      // Another package, or a target outside the layout (package.json, a folder the layout rule reports), is
      // no layer import.
      if (target === undefined || targetPart === undefined) {
        continue;
      }
      const targetFolder = posix.dirname(target);
      if (RANK[targetPart] < RANK[part]) {
        report("upward-import");
      }
      if (part === "domain" && targetPart === "domain" && targetFolder !== folder) {
        report("cross-domain");
      }
      if (
        targetPart === "domain" &&
        posix.basename(target) === "store.ts" &&
        path !== `${targetFolder}/${targetFolder}.ts`
      ) {
        report("foreign-store");
      }
    }
  }
  return violations;
}

const srcRoot = fileURLToPath(new URL("../src", import.meta.url));

const readSources = async (dir: string): Promise<SourceFile[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: SourceFile[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await readSources(path)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push({ path: relative(srcRoot, path).split(sep).join("/"), text: await readFile(path, "utf8") });
    }
  }
  return files;
};

const check = (files: Record<string, string>): Violation[] =>
  structureViolations(Object.entries(files).map(([path, text]) => ({ path, text })));

describe("worker structure (plan 3.12.1 rule 1)", () => {
  it("the worker's sources break none of the rules", async () => {
    const files = await readSources(srcRoot);
    expect(files.map((file) => file.path)).toEqual(
      expect.arrayContaining(["index.ts", "http/app.ts", "devices/store.ts", "buckets/buckets.ts"])
    );
    expect(structureViolations(files)).toEqual([]);
  });

  it("allows the one-way imports of the layout", () => {
    expect(
      check({
        "index.ts": ['import type { D1Database } from "./db.ts";', 'import { createApp } from "./http/app.ts";'].join(
          "\n"
        ),
        "http/app.ts": [
          'import { Hono } from "hono";',
          'import { bearerAuth } from "hono/bearer-auth";',
          'import { sValidator } from "@hono/standard-validator";',
          'import { pushBuckets } from "../buckets/buckets.ts";',
          'import { registerDevice } from "../devices/devices.ts";',
          'import type { D1Database } from "../db.ts";',
          'import { errorResponse } from "./failures.ts";'
        ].join("\n"),
        "http/failures.ts": 'import { HTTPException } from "hono/http-exception";',
        "devices/devices.ts": [
          'import { hashToken } from "../tokens.ts";',
          'import { insertUnlessActive } from "./store.ts";'
        ].join("\n"),
        "devices/store.ts": 'import * as z from "zod/mini";\nimport type { D1Database } from "../db.ts";',
        "buckets/buckets.ts":
          'import type { Bucket } from "@rivus/snorlax-protocol";\nimport { writePush } from "./store.ts";',
        "buckets/store.ts": 'import type { D1Database } from "../db.ts";',
        "sqlite-d1.ts": 'import type { D1Database } from "./db.ts";',
        "db.ts": "",
        "tokens.ts": ""
      })
    ).toEqual([]);
  });

  it.each([
    ["a use case", "devices/devices.ts", "hono"],
    ["a store", "buckets/store.ts", "@hono/standard-validator"],
    ["a file at the top of src/", "tokens.ts", "hono/http-exception"]
  ])("catches a framework import in %s", (_, file, spec) => {
    expect(check({ [file]: `import { x } from "${spec}";` })).toEqual([
      { rule: "framework-import", file, import: spec }
    ]);
  });

  it.each([
    ["a use case to http/", "buckets/buckets.ts", "../http/failures.ts"],
    ["a store to http/", "devices/store.ts", "../http/app.ts"],
    ["a top file to a domain folder", "tokens.ts", "./devices/devices.ts"],
    ["http/ to index.ts", "http/app.ts", "../index.ts"],
    ["a use case to the http/ directory", "devices/devices.ts", "../http"],
    ["a store to the src/ directory, which is index.ts", "devices/store.ts", ".."],
    ["a use case to the package's own name, which is http/app.ts", "buckets/buckets.ts", "@rivus/snorlax-worker"]
  ])("catches an upward import from %s", (_, file, spec) => {
    expect(check({ [file]: `import { above } from "${spec}";` })).toEqual([
      { rule: "upward-import", file, import: spec }
    ]);
  });

  it("catches a domain folder importing the other", () => {
    expect(
      check({
        "buckets/buckets.ts": 'import type { AuthenticatedDevice } from "../devices/devices.ts";',
        "devices/devices.ts": 'import { pullBuckets } from "../buckets/buckets.ts";'
      })
    ).toEqual([
      { rule: "cross-domain", file: "buckets/buckets.ts", import: "../devices/devices.ts" },
      { rule: "cross-domain", file: "devices/devices.ts", import: "../buckets/buckets.ts" }
    ]);
  });

  it("catches a domain folder importing the other by its directory", () => {
    const file = "buckets/buckets.ts";
    expect(check({ [file]: 'import type { AuthenticatedDevice } from "../devices";' })).toEqual([
      { rule: "cross-domain", file, import: "../devices" }
    ]);
  });

  it.each([
    ["http/", "http/app.ts", "../devices/store.ts"],
    ["the entry", "index.ts", "./buckets/store.ts"],
    ["another file of its own folder", "devices/rules.ts", "./store.ts"]
  ])("catches a store imported from %s", (_, file, spec) => {
    expect(check({ [file]: `import { readDevices } from "${spec}";` })).toEqual([
      { rule: "foreign-store", file, import: spec }
    ]);
  });

  it("reports both rules for a use case importing the other domain's store", () => {
    const file = "buckets/buckets.ts";
    expect(check({ [file]: 'import { markRevoked } from "../devices/store.ts";' })).toEqual([
      { rule: "cross-domain", file, import: "../devices/store.ts" },
      { rule: "foreign-store", file, import: "../devices/store.ts" }
    ]);
  });

  it("reads all three import forms", () => {
    const file = "devices/devices.ts";
    expect(
      check({
        [file]: [
          'import type { Context } from "hono";',
          'import "../http/app.ts";',
          'const failures = () => import("../http/failures.ts");'
        ].join("\n")
      })
    ).toEqual([
      { rule: "framework-import", file, import: "hono" },
      { rule: "upward-import", file, import: "../http/app.ts" },
      { rule: "upward-import", file, import: "../http/failures.ts" }
    ]);
  });

  it.each([
    ["a folder outside the layout", "util/encoding.ts"],
    ["a nested domain folder", "devices/tokens/hash.ts"],
    ["a nested http/ folder", "http/middleware/auth.ts"]
  ])("catches %s", (_, file) => {
    expect(check({ [file]: "" })).toEqual([{ rule: "layout", file }]);
  });
});
