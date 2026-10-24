import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

/**
 * The import direction of plan 3.13, enforced over every source file (not a directory whitelist):
 * files outside `cli/` never import `cli/`, and files outside `cli/` and `commands/` never import
 * `commands/` — so `cli/` may import `commands/`, `commands/` may import feature modules, and
 * errors.ts, the shared services and the pure rules stay below both. All three import forms count:
 * `from "…"`, side-effect `import "…"`, and dynamic `import("…")`; relative specs are resolved
 * against the importing file's directory before the top-level segment is read.
 */

const srcRoot = fileURLToPath(new URL("../src", import.meta.url));

const listFiles = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
};

/** Every module specifier in the file, whichever import form carries it. */
const importSpecs = (text: string): string[] =>
  [...text.matchAll(/(?:\bfrom\s+|\bimport\s+|\bimport\()\s*["']([^"']+)["']/g)].map((match) => match[1] ?? "");

/** The imported file's path from `srcRoot` down, or undefined for non-relative specifiers. */
const resolvedFromSrc = (spec: string, importerDir: string): string | undefined => {
  if (!spec.startsWith(".")) {
    return undefined;
  }
  return relative(srcRoot, resolve(importerDir, spec)).split(sep).join("/");
};

const importedTopLevel = (fromSrc: string): string | undefined => fromSrc.split("/")[0];

describe("collector module direction (plan 3.13)", () => {
  it("files outside cli/ never import cli/, and files outside cli/ and commands/ never import commands/", async () => {
    const offenders: string[] = [];
    for (const file of await listFiles(srcRoot)) {
      const fromSrc = relative(srcRoot, file).split(sep).join("/");
      const inCli = fromSrc === "cli" || fromSrc.startsWith("cli/");
      const inCommands = fromSrc === "commands" || fromSrc.startsWith("commands/");
      const importerDir = dirname(file);
      for (const spec of importSpecs(await readFile(file, "utf8"))) {
        const imported = resolvedFromSrc(spec, importerDir);
        if (imported === undefined) {
          continue;
        }
        const topLevel = importedTopLevel(imported);
        if (topLevel === "cli" && !inCli) {
          offenders.push(`${fromSrc} -> ${spec}`);
        }
        if (topLevel === "commands" && !inCli && !inCommands) {
          offenders.push(`${fromSrc} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every command module imports no sibling command module", async () => {
    const offenders: string[] = [];
    // commands/ also holds the shared render slot and the global --json flag; commands never import
    // each other.
    const shared = new Set(["commands/output.ts", "commands/flags.ts"]);
    for (const file of await listFiles(join(srcRoot, "commands"))) {
      const importerDir = dirname(file);
      for (const spec of importSpecs(await readFile(file, "utf8"))) {
        const imported = resolvedFromSrc(spec, importerDir);
        if (imported !== undefined && imported.startsWith("commands/") && !shared.has(imported)) {
          offenders.push(`${relative(srcRoot, file).split(sep).join("/")} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
