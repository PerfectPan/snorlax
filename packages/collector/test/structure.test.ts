import { readdir, readFile } from "node:fs/promises";
import { join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

/**
 * Plan 3.13 rules 1, 2 and 4 over every source file, as one pure function of the files' paths and texts:
 * `src/` holds only the five layers; core, module and capability units are folders entered through a file
 * named after them; commands/ holds only command folders; imports go cli → commands → capabilities → modules →
 * core and never up; a command folder never imports another; code outside a unit imports only its entry file;
 * and core/ does not use Effect.
 * All three import forms count — `from "…"`, side-effect `import "…"` and dynamic `import("…")` — and
 * relative specifiers are resolved against the importing file's directory before they are judged.
 */

/** Lowest first: a file may import its own layer or any layer before it. */
const LAYERS = ["core", "modules", "capabilities", "commands", "cli"] as const;
type LayerName = (typeof LAYERS)[number];

/** Layers made of units (`modules/ledger/`), each entered through `<unit>/<name>.ts`. */
const UNIT_LAYERS: ReadonlySet<LayerName> = new Set(["core", "modules", "capabilities"]);

type Rule = "layout" | "entry-file" | "upward-import" | "cross-command" | "deep-import" | "core-effect";

interface Violation {
  readonly rule: Rule;
  /** The offending file from `src/`, or the unit folder for `entry-file`. */
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

const layerOf = (path: string): LayerName | undefined => LAYERS.find((layer) => path.startsWith(`${layer}/`));

/** The unit folder a path lies in (`modules/ledger`), for paths inside a unit layer's folders. */
const unitOf = (path: string): string | undefined => {
  const layer = layerOf(path);
  const segments = path.split("/");
  return layer !== undefined && UNIT_LAYERS.has(layer) && segments.length > 2
    ? segments.slice(0, 2).join("/")
    : undefined;
};

const entryOf = (unit: string): string => `${unit}/${posix.basename(unit)}.ts`;

/** The command folder a path lies in; undefined for the files directly in `commands/`. */
const commandFolderOf = (path: string): string | undefined => {
  const segments = path.split("/");
  return segments[0] === "commands" && segments.length > 2 ? segments[1] : undefined;
};

const isEffectSpec = (spec: string): boolean => /^(?:effect(?:\/|$)|@effect\/)/.test(spec);

function structureViolations(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  const units = new Set<string>();
  for (const { path, text } of files) {
    const layer = layerOf(path);
    const unit = unitOf(path);
    if (unit !== undefined) {
      units.add(unit);
    }
    const directlyInLayer = path.split("/").length === 2;
    if (layer === undefined || (directlyInLayer && (UNIT_LAYERS.has(layer) || layer === "commands"))) {
      violations.push({ rule: "layout", file: path });
    }
    for (const spec of importSpecs(text)) {
      const report = (rule: Rule): void => {
        violations.push({ rule, file: path, import: spec });
      };
      if (layer === "core" && isEffectSpec(spec)) {
        report("core-effect");
      }
      if (!spec.startsWith(".")) {
        continue;
      }
      const target = posix.join(posix.dirname(path), spec);
      const targetLayer = layerOf(target);
      // A target outside src/ (package.json) is no layer import; a file outside the layers is reported by
      // the layout rule.
      if (layer === undefined || targetLayer === undefined) {
        continue;
      }
      if (LAYERS.indexOf(targetLayer) > LAYERS.indexOf(layer)) {
        report("upward-import");
      }
      const fromCommand = commandFolderOf(path);
      const toCommand = commandFolderOf(target);
      if (fromCommand !== undefined && toCommand !== undefined && fromCommand !== toCommand) {
        report("cross-command");
      }
      const targetUnit = unitOf(target);
      if (targetUnit !== undefined && targetUnit !== unit && target !== entryOf(targetUnit)) {
        report("deep-import");
      }
    }
  }
  const paths = new Set(files.map((file) => file.path));
  for (const unit of units) {
    if (!paths.has(entryOf(unit))) {
      violations.push({ rule: "entry-file", file: `${unit}/` });
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
    } else if (entry.name.endsWith(".ts")) {
      files.push({ path: relative(srcRoot, path).split(sep).join("/"), text: await readFile(path, "utf8") });
    }
  }
  return files;
};

const check = (files: Record<string, string>): Violation[] =>
  structureViolations(Object.entries(files).map(([path, text]) => ({ path, text })));

describe("collector structure (plan 3.13 rules 1, 2 and 4)", () => {
  it("the collector's sources break none of the rules", async () => {
    const files = await readSources(srcRoot);
    expect(files.map((file) => file.path)).toContain("cli/bin.ts");
    expect(structureViolations(files)).toEqual([]);
  });

  it("allows entry imports, imports inside one unit and downward imports", () => {
    expect(
      check({
        "cli/root.ts": 'import { refreshCommand } from "../commands/refresh/command.ts";',
        "commands/refresh/command.ts": 'import { refresh } from "./flow.ts";',
        "commands/refresh/flow.ts": [
          'import { openLedger } from "../../modules/ledger/ledger.ts";',
          'import { Scheduler } from "../../capabilities/scheduler/scheduler.ts";'
        ].join("\n"),
        "capabilities/scheduler/scheduler.ts": [
          'import { renderPlist } from "./plist.ts";',
          'import { DataDir } from "../../modules/data-dir/data-dir.ts";'
        ].join("\n"),
        "capabilities/scheduler/plist.ts": "",
        "modules/data-dir/data-dir.ts": 'import { Effect } from "effect";',
        "modules/ledger/ledger.ts": [
          'import { MIGRATIONS } from "./migrations.ts";',
          'import { DataDir } from "../data-dir/data-dir.ts";',
          'import type { BucketRow } from "../../core/buckets/buckets.ts";'
        ].join("\n"),
        "modules/ledger/migrations.ts": 'import { errorMessage } from "../../core/error-message/error-message.ts";',
        "modules/version/version.ts": 'import packageJson from "../../../package.json" with { type: "json" };',
        "core/buckets/buckets.ts": [
          'import type { UsageRecord } from "@rivus/agent-kit/transcript/usage";',
          'import { splitByModel } from "./split.ts";'
        ].join("\n"),
        "core/buckets/split.ts": "",
        "core/error-message/error-message.ts": ""
      })
    ).toEqual([]);
  });

  it("catches a command folder importing another command folder", () => {
    expect(check({ "commands/refresh/flow.ts": 'import { rebuildCommand } from "../rebuild/command.ts";' })).toEqual([
      { rule: "cross-command", file: "commands/refresh/flow.ts", import: "../rebuild/command.ts" }
    ]);
  });

  it.each([
    ["a module from a command", "commands/refresh/command.ts", "../../modules/ledger/migrations.ts"],
    ["a capability from a command", "commands/install/command.ts", "../../capabilities/scheduler/launchd.ts"],
    ["a module from another module", "modules/log/log.ts", "../data-dir/node-fs.ts"],
    ["a core unit from a module", "modules/ledger/ledger.ts", "../../core/buckets/split.ts"]
  ])("catches a deep import into %s", (_, file, spec) => {
    expect(check({ [file]: `import { internal } from "${spec}";` })).toEqual([
      { rule: "deep-import", file, import: spec }
    ]);
  });

  it.each([
    ["core/ to modules/", "core/buckets/buckets.ts", "../../modules/ledger/ledger.ts"],
    ["modules/ to capabilities/", "modules/ledger/ledger.ts", "../../capabilities/scheduler/scheduler.ts"],
    ["modules/ to commands/", "modules/ledger/ledger.ts", "../../commands/refresh/command.ts"],
    ["modules/ to cli/", "modules/log/log.ts", "../../cli/root.ts"],
    ["capabilities/ to commands/", "capabilities/scheduler/scheduler.ts", "../../commands/install/command.ts"],
    ["commands/ to cli/", "commands/refresh/command.ts", "../../cli/run.ts"]
  ])("catches an upward import from %s", (_, file, spec) => {
    expect(check({ [file]: `import { above } from "${spec}";` })).toEqual([
      { rule: "upward-import", file, import: spec }
    ]);
  });

  it("reads all three import forms", () => {
    const file = "core/snapshot/snapshot.ts";
    expect(
      check({
        [file]: [
          'import type { Ledger } from "../../modules/ledger/ledger.ts";',
          'import "../../modules/log/log.ts";',
          'const scan = () => import("../../modules/scan/scan.ts");'
        ].join("\n")
      })
    ).toEqual([
      { rule: "upward-import", file, import: "../../modules/ledger/ledger.ts" },
      { rule: "upward-import", file, import: "../../modules/log/log.ts" },
      { rule: "upward-import", file, import: "../../modules/scan/scan.ts" }
    ]);
  });

  it.each([
    ["a file at the top of src/", "errors.ts"],
    ["a directory that is not a layer", "util/error-message.ts"],
    ["a file directly in commands/", "commands/shared.ts"],
    ["framework code directly in commands/", "commands/output.ts"],
    ["a file directly in modules/", "modules/time-zone.ts"]
  ])("catches %s", (_, file) => {
    expect(check({ [file]: "" })).toEqual([{ rule: "layout", file }]);
  });

  it.each(["modules/ledger/migrations.ts", "capabilities/scheduler/launchd.ts", "core/buckets/split.ts"])(
    "catches a unit without its entry file: %s",
    (file) => {
      expect(check({ [file]: "" })).toEqual([{ rule: "entry-file", file: `${posix.dirname(file)}/` }]);
    }
  );

  it("catches core/ importing effect", () => {
    const file = "core/buckets/buckets.ts";
    expect(check({ [file]: 'import { Effect } from "effect";\nimport { Command } from "effect/cli";' })).toEqual([
      { rule: "core-effect", file, import: "effect" },
      { rule: "core-effect", file, import: "effect/cli" }
    ]);
  });
});
