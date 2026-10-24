import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

/**
 * The import direction of plan 3.13, enforced over every source file (not a directory whitelist):
 * files outside `cli/` never import `cli/`, and files outside `cli/` and `commands/` never import
 * `commands/` — so `cli/` may import `commands/`, `commands/` may import feature modules, and
 * errors.ts, the shared services and the pure rules stay below both.
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

/** The first real path segment of an import spec, e.g. `../cli/env.ts` or `./cli/env.ts` -> `cli`. */
const importedTopLevel = (spec: string): string | undefined => {
  for (const segment of spec.replace(/\.ts$/, "").split("/")) {
    if (segment === "." || segment === ".." || segment === "") {
      continue;
    }
    return segment;
  }
  return undefined;
};

const importSpecs = (text: string): string[] => [...text.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");

describe("collector module direction (plan 3.13)", () => {
  it("files outside cli/ never import cli/, and files outside cli/ and commands/ never import commands/", async () => {
    const offenders: string[] = [];
    for (const file of await listFiles(srcRoot)) {
      const fromSrc = relative(srcRoot, file).split(sep).join("/");
      const inCli = fromSrc === "cli" || fromSrc.startsWith("cli/");
      const inCommands = fromSrc === "commands" || fromSrc.startsWith("commands/");
      for (const spec of importSpecs(await readFile(file, "utf8"))) {
        const topLevel = importedTopLevel(spec);
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
    for (const file of await listFiles(join(srcRoot, "commands"))) {
      const text = await readFile(file, "utf8");
      // Commands import feature modules and effect/cli, never a sibling command (output.ts apart).
      for (const spec of importSpecs(text)) {
        if (spec.startsWith("./") && spec !== "./output.ts") {
          offenders.push(`${relative(srcRoot, file)} -> ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
