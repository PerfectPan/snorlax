import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { failureSchema, okSchema, refreshResultSchema } from "@rivus/snorlax-protocol";
import * as plist from "plist";
import * as z from "zod/mini";
import { describe, expect, it } from "vite-plus/test";

import { CliError } from "../src/cli/errors.ts";
import { resolvedDeletableDataDir } from "../src/schedule/launchd.ts";
import { renderLaunchAgentPlist } from "../src/schedule/plist.ts";
import { quietMtime, writeClaudeSession, writeCodexRollout } from "./fixtures/agents.ts";

/**
 * `install` / `uninstall` against the built bundle under a temporary HOME. `SNORLAX_LAUNCHCTL`
 * points at a stub that records argv, so the real launchctl never runs. `SNORLAX_OS=darwin` runs
 * the LaunchAgent path on the Linux CI job as well as on a Mac.
 */
const bundle = fileURLToPath(new URL("../dist/snorlax.mjs", import.meta.url));
const LABEL = "io.github.perfectpan.snorlax.refresh";

const plistFields = {
  Label: z.literal(LABEL),
  ProgramArguments: z.tuple([z.string(), z.string(), z.literal("refresh")]),
  StartInterval: z.literal(300),
  RunAtLoad: z.literal(true),
  StandardOutPath: z.string(),
  StandardErrorPath: z.string()
};

const installedPlistSchema = z.strictObject({
  ...plistFields,
  EnvironmentVariables: z.strictObject({ SNORLAX_HOME: z.string() })
});

const plistWithoutHomeSchema = z.strictObject(plistFields);
const invocationSchema = z.array(z.string());

const dataDirOf = (home: string): string => join(home, "data");
const plistPathOf = (home: string): string => join(home, "Library", "LaunchAgents", `${LABEL}.plist`);

const uid = (): number => {
  const id = process.getuid?.();
  if (id === undefined) {
    throw new Error("install tests need a numeric user id");
  }
  return id;
};

const json = (stdout: string): unknown => JSON.parse(stdout);

interface InstallEnv {
  readonly home: string;
  readonly launchctl: string;
  readonly os: "darwin" | "linux";
  readonly record: string;
}

const run = (env: InstallEnv, args: readonly string[]) =>
  spawnSync(process.execPath, [bundle, ...args], {
    encoding: "utf8",
    env: {
      HOME: env.home,
      SNORLAX_HOME: dataDirOf(env.home),
      SNORLAX_LAUNCHCTL: env.launchctl,
      SNORLAX_OS: env.os,
      PATH: "/usr/bin:/bin"
    }
  });

const writeStub = async (dir: string): Promise<string> => {
  const script = join(dir, "launchctl.mjs");
  const source = [
    `#!${process.execPath}`,
    `import { appendFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";`,
    `import { dirname, join } from "node:path";`,
    `import { fileURLToPath } from "node:url";`,
    `const dir = dirname(fileURLToPath(import.meta.url));`,
    `appendFileSync(join(dir, "argv.jsonl"), JSON.stringify(process.argv.slice(2)) + "\\n");`,
    `const marker = join(dir, "loaded");`,
    `const [command] = process.argv.slice(2);`,
    `if (command === "print") process.exit(existsSync(marker) ? 0 : 1);`,
    `if (command === "bootstrap") { writeFileSync(marker, "loaded\\n"); process.exit(0); }`,
    `if (command === "bootout") {`,
    `  if (!existsSync(marker)) process.exit(1);`,
    `  unlinkSync(marker);`,
    `  process.exit(0);`,
    `}`,
    `process.exit(2);`,
    ``
  ].join("\n");
  await writeFile(script, source, "utf8");
  await chmod(script, 0o755);
  return script;
};

const withInstallHome = async (os: "darwin" | "linux", body: (env: InstallEnv) => Promise<void>): Promise<void> => {
  if (!existsSync(bundle)) {
    throw new Error(`${bundle} is missing; run "pnpm --filter @rivus/snorlax run build" first`);
  }
  const home = await mkdtemp(join(tmpdir(), "snorlax-install-"));
  const stubDir = await mkdtemp(join(tmpdir(), "snorlax-launchctl-"));
  try {
    const launchctl = await writeStub(stubDir);
    await body({ home, launchctl, os, record: join(stubDir, "argv.jsonl") });
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(stubDir, { recursive: true, force: true });
  }
};

const readInvocations = async (record: string): Promise<string[][]> => {
  if (!existsSync(record)) {
    return [];
  }
  const text = await readFile(record, "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const parsed: unknown = JSON.parse(line);
      return z.parse(invocationSchema, parsed);
    });
};

/** `plist.parse` returns the library's own value; zod is the boundary that checks the LaunchAgent shape. */
const parsePlistDocument = (xml: string): unknown => plist.parse(xml);

const decodePlist = async (path: string): Promise<z.output<typeof installedPlistSchema>> => {
  const parsed = z.safeParse(installedPlistSchema, parsePlistDocument(await readFile(path, "utf8")));
  expect(parsed.success ? "valid" : z.prettifyError(parsed.error)).toBe("valid");
  if (!parsed.success) {
    throw new Error("plist did not match the LaunchAgent schema");
  }
  return parsed.data;
};

/**
 * Claude Code and Codex logs the kit can decode. `quietMtime` pins each file an hour before now, past
 * the kit's 30-minute quiet window, so `refresh` reports the requests on this run.
 */
const writeUsageFixtures = async (home: string): Promise<void> => {
  const mtimeMs = quietMtime(Date.now());
  const timestampMs = mtimeMs - 60_000;
  await writeClaudeSession(home, {
    sessionId: "s14-claude",
    mtimeMs,
    requests: [
      {
        requestId: "s14-req-1",
        model: "claude-haiku-4-5",
        timestampMs,
        usage: { inputTokens: 100, outputTokens: 20 }
      }
    ]
  });
  await writeCodexRollout(home, {
    sessionId: "s14-codex",
    model: "gpt-6.2",
    mtimeMs,
    requests: [{ responseId: "s14-resp-1", timestampMs, usage: { inputTokens: 50, outputTokens: 10 } }]
  });
};

const writeFixtures = async (home: string): Promise<void> => {
  const claude = join(home, ".claude", "projects", "fixture-project", "session.jsonl");
  const codex = join(home, ".codex", "sessions", "fixture-session.jsonl");
  await mkdir(dirname(claude), { recursive: true });
  await mkdir(dirname(codex), { recursive: true });
  await writeFile(claude, "fixture claude line 1\nfixture claude line 2\nfixture claude line 3\n");
  await writeFile(codex, "fixture codex line 1\nfixture codex line 2\n");
};

const hashTree = async (root: string): Promise<string> => {
  const hash = createHash("sha256");
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const rel = relative(root, path).split(sep).join("/");
      if (entry.isSymbolicLink()) {
        hash.update(`symlink ${rel}\n`);
        continue;
      }
      if (entry.isDirectory()) {
        hash.update(`dir ${rel}\n`);
        await walk(path);
        continue;
      }
      hash.update(`file ${rel}\n`);
      hash.update(await readFile(path));
      hash.update("\n");
    }
  };
  await walk(root);
  return hash.digest("hex");
};

const hashAgentDirs = async (home: string): Promise<string> => {
  const hash = createHash("sha256");
  for (const name of [".claude", ".codex"]) {
    hash.update(`${name}\n`);
    hash.update(await hashTree(join(home, name)));
  }
  return hash.digest("hex");
};

const listFiles = async (root: string): Promise<string[]> => {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(path);
        continue;
      }
      files.push(relative(root, path).split(sep).join("/"));
    }
  };
  await walk(root);
  return files.sort();
};

describe("install and uninstall", () => {
  it("writes a LaunchAgent plist, bootstraps it, and boots out on a repeat install", async () => {
    await withInstallHome("darwin", async (env) => {
      const domain = `gui/${uid()}`;
      const plistPath = plistPathOf(env.home);
      const dataDir = dataDirOf(env.home);

      const installed = run(env, ["install", "--json"]);
      expect(installed.stderr).toBe("");
      expect(installed.status).toBe(0);
      expect(installed.stdout).toBe('{"schemaVersion":1,"ok":true}\n');
      expect(z.parse(okSchema, json(installed.stdout)).ok).toBe(true);

      const plist = await decodePlist(plistPath);
      expect(plist.ProgramArguments).toEqual([process.execPath, resolve(bundle), "refresh"]);
      expect(isAbsolute(plist.ProgramArguments[0])).toBe(true);
      expect(isAbsolute(plist.ProgramArguments[1])).toBe(true);
      expect(plist.StandardOutPath).toBe(join(dataDir, "logs", "refresh.stdout.log"));
      expect(plist.StandardErrorPath).toBe(join(dataDir, "logs", "refresh.stderr.log"));
      expect(plist.EnvironmentVariables.SNORLAX_HOME).toBe(dataDir);

      const again = run(env, ["install"]);
      expect(again.status).toBe(0);
      expect(again.stderr).toBe("");
      expect(again.stdout).toBe(`LaunchAgent installed at ${plistPath}\n`);
      await decodePlist(plistPath);

      expect(await readInvocations(env.record)).toEqual([
        ["print", `${domain}/${LABEL}`],
        ["bootstrap", domain, plistPath],
        ["print", `${domain}/${LABEL}`],
        ["bootout", domain, plistPath],
        ["bootstrap", domain, plistPath]
      ]);
    });
  });

  it("rejects an unknown install option before calling launchctl", async () => {
    await withInstallHome("darwin", async (env) => {
      const result = run(env, ["install", "--nope", "--json"]);
      expect(result.status).toBe(2);
      expect(z.parse(failureSchema, json(result.stdout)).error.code).toBe("invalid-arguments");
      expect(existsSync(plistPathOf(env.home))).toBe(false);
      expect(await readInvocations(env.record)).toEqual([]);
    });
  });

  it("boots out and removes the plist, and a second uninstall is a no-op", async () => {
    await withInstallHome("darwin", async (env) => {
      const domain = `gui/${uid()}`;
      const plistPath = plistPathOf(env.home);
      expect(run(env, ["install", "--json"]).status).toBe(0);

      const removed = run(env, ["uninstall", "--json"]);
      expect(removed.stderr).toBe("");
      expect(removed.status).toBe(0);
      expect(removed.stdout).toBe('{"schemaVersion":1,"ok":true}\n');
      expect(existsSync(plistPath)).toBe(false);

      const again = run(env, ["uninstall"]);
      expect(again.status).toBe(0);
      expect(again.stdout).toBe("LaunchAgent removed\n");
      expect(existsSync(dataDirOf(env.home))).toBe(true);

      expect(await readInvocations(env.record)).toEqual([
        ["print", `${domain}/${LABEL}`],
        ["bootstrap", domain, plistPath],
        ["print", `${domain}/${LABEL}`],
        ["bootout", domain, plistPath],
        ["print", `${domain}/${LABEL}`]
      ]);
    });
  });

  it("uninstall --data deletes the data directory and leaves the fixture agent files", async () => {
    await withInstallHome("darwin", async (env) => {
      await writeFixtures(env.home);
      const before = await hashAgentDirs(env.home);
      expect(run(env, ["install", "--json"]).status).toBe(0);

      const removed = run(env, ["uninstall", "--data", "--json"]);
      expect(removed.status).toBe(0);
      expect(removed.stdout).toBe('{"schemaVersion":1,"ok":true}\n');
      expect(existsSync(plistPathOf(env.home))).toBe(false);
      expect(existsSync(dataDirOf(env.home))).toBe(false);
      expect(await hashAgentDirs(env.home)).toBe(before);

      const files = await listFiles(env.home);
      expect(files).toEqual([
        ".claude/projects/fixture-project/session.jsonl",
        ".codex/sessions/fixture-session.jsonl"
      ]);
      expect(files.some((file) => file.includes("snorlax"))).toBe(false);

      expect(run(env, ["uninstall", "--data", "--json"]).status).toBe(0);
      expect(existsSync(dataDirOf(env.home))).toBe(false);
      expect(await hashAgentDirs(env.home)).toBe(before);
    });
  });

  it("keeps fixture agent directories unchanged across install, refresh, and uninstall", async () => {
    await withInstallHome("darwin", async (env) => {
      await writeUsageFixtures(env.home);
      const before = await hashAgentDirs(env.home);
      expect(run(env, ["install", "--json"]).status).toBe(0);

      const refreshed = run(env, ["refresh", "--json"]);
      expect(refreshed.status).toBe(0);
      const result = z.parse(refreshResultSchema, json(refreshed.stdout));
      expect(result.ok).toBe(true);
      expect(result.records).toBeGreaterThan(0);

      expect(run(env, ["uninstall", "--json"]).status).toBe(0);
      expect(await hashAgentDirs(env.home)).toBe(before);
    });
  });

  it("fails on linux without writing a plist, calling launchctl, or deleting the data directory", async () => {
    await withInstallHome("linux", async (env) => {
      const installed = run(env, ["install", "--json"]);
      expect(installed.status).toBe(1);
      const installFailure = z.parse(failureSchema, json(installed.stdout));
      expect(installFailure.error.code).toBe("internal");
      expect(installFailure.error.message).toContain("Batch 8");
      expect(existsSync(plistPathOf(env.home))).toBe(false);
      expect(existsSync(dataDirOf(env.home))).toBe(true);

      const removed = run(env, ["uninstall", "--data", "--json"]);
      expect(removed.status).toBe(1);
      expect(z.parse(failureSchema, json(removed.stdout)).error.message).toContain("Batch 8");
      expect(existsSync(dataDirOf(env.home))).toBe(true);
      expect(await readInvocations(env.record)).toEqual([]);
    });
  });
});

describe("LaunchAgent plist", () => {
  it("escapes XML metacharacters in paths", () => {
    const xml = renderLaunchAgentPlist({
      nodePath: "/usr/bin/node",
      cliPath: "/opt/snorlax & co/snorlax.mjs",
      dataDir: "/tmp/data<dir>",
      snorlaxHome: "/tmp/a&b<c>"
    });
    const parsed = z.safeParse(installedPlistSchema, parsePlistDocument(xml));
    expect(parsed.success ? "valid" : z.prettifyError(parsed.error)).toBe("valid");
    if (!parsed.success) {
      return;
    }
    expect(parsed.data.ProgramArguments[1]).toBe("/opt/snorlax & co/snorlax.mjs");
    expect(parsed.data.StandardOutPath).toBe("/tmp/data<dir>/logs/refresh.stdout.log");
    expect(parsed.data.StandardErrorPath).toBe("/tmp/data<dir>/logs/refresh.stderr.log");
    expect(parsed.data.EnvironmentVariables.SNORLAX_HOME).toBe("/tmp/a&b<c>");
  });

  it("omits EnvironmentVariables when SNORLAX_HOME is unset", () => {
    const xml = renderLaunchAgentPlist({
      nodePath: "/usr/bin/node",
      cliPath: "/opt/snorlax/snorlax.mjs",
      dataDir: "/tmp/data"
    });
    const parsed = z.safeParse(plistWithoutHomeSchema, parsePlistDocument(xml));
    expect(parsed.success ? "valid" : z.prettifyError(parsed.error)).toBe("valid");
  });
});

describe("uninstall --data path guard", () => {
  it("refuses to delete /, the home directory, or a relative path", () => {
    expect(() => resolvedDeletableDataDir("/", "/tmp/home")).toThrow(/refusing to delete/);
    expect(() => resolvedDeletableDataDir("/tmp/home", "/tmp/home")).toThrow(/refusing to delete/);
    expect(() => resolvedDeletableDataDir("relative/data", "/tmp/home")).toThrow(/must be absolute/);
    expect(resolvedDeletableDataDir("/tmp/home/snorlax", "/tmp/home")).toBe("/tmp/home/snorlax");
    expect(() => resolvedDeletableDataDir("/", "/tmp/home")).toThrow(CliError);
  });
});
