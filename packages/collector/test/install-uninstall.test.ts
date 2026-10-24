import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import { doctorSchema, failureSchema, okSchema, refreshResultSchema } from "@rivus/snorlax-protocol";
import * as plist from "plist";
import * as z from "zod/mini";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { launchAgentNodePath, renderLaunchAgentPlist } from "../src/capabilities/scheduler/plist.ts";
import { DataDirNotDeletable, resolvedDeletableDataDir } from "../src/commands/uninstall/delete-data.ts";
import { quietMtime, writeClaudeSession, writeCodexRollout } from "./fixtures/agents.ts";
import { bundle, runBundle, spawnBundle } from "./fixtures/bundle.ts";

/**
 * `install` / `uninstall` against the built bundle under a temporary HOME. `SNORLAX_LAUNCHCTL`
 * points at a stub that records argv, so the real launchctl never runs. `SNORLAX_OS=darwin` runs
 * the LaunchAgent path on the Linux CI job as well as on a Mac. The stub mirrors launchctl's own
 * behavior where the tests depend on it: `bootstrap` fails (exit 5) while a service is loaded, so
 * a repeat install has to boot out first, and `print` reports the loaded service's plist path.
 */
const LABEL = "io.github.perfectpan.snorlax.refresh";

const plistFields = {
  Label: z.literal(LABEL),
  ProgramArguments: z.tuple([z.string(), z.string(), z.literal("refresh")]),
  StartInterval: z.literal(300),
  RunAtLoad: z.literal(true),
  // launchd's redirect files are never written: the collector logs to the rotating snorlax.log.
  StandardOutPath: z.literal("/dev/null"),
  StandardErrorPath: z.literal("/dev/null")
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
  /** The stub's loaded-service marker; its content is the plist path `print` reports. */
  readonly loaded: string;
  /** When this file exists, the stub's `bootstrap` fails like launchd refusing a service. */
  readonly failBootstrap: string;
  /** When this file exists, `print` emits a nested block whose `path =` line names this plist first. */
  readonly nested: string;
  /**
   * When this FIFO exists, `bootstrap` is held: it writes its pid to `bootstrapPid`, announces itself on this FIFO,
   * and loads the service only once a line arrives on `releaseBootstrap`. A SIGTERM ends it before that, unless
   * `outlivesStop` exists: then it reports the signal on `bootstrapStopped` and keeps waiting, like a launchctl
   * whose load has already reached launchd.
   */
  readonly bootstrapEntered: string;
  readonly releaseBootstrap: string;
  readonly outlivesStop: string;
  readonly bootstrapStopped: string;
  readonly bootstrapPid: string;
}

const run = (env: InstallEnv, args: readonly string[], overrides?: { readonly snorlaxHome?: string }) =>
  runBundle(args, {
    home: env.home,
    dataDir: overrides?.snorlaxHome ?? dataDirOf(env.home),
    launchctl: env.launchctl,
    os: env.os
  });

const writeStub = async (dir: string): Promise<string> => {
  const script = join(dir, "launchctl.mjs");
  const source = [
    `#!${process.execPath}`,
    `import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";`,
    `import { readFile } from "node:fs/promises";`,
    `import { dirname, join } from "node:path";`,
    `import { fileURLToPath } from "node:url";`,
    `const dir = dirname(fileURLToPath(import.meta.url));`,
    `appendFileSync(join(dir, "argv.jsonl"), JSON.stringify(process.argv.slice(2)) + "\\n");`,
    `// The marker holds the plist path of the loaded service, like launchd's own state. An empty`,
    `// marker is a loaded service whose plist "print" cannot name.`,
    `const marker = join(dir, "loaded");`,
    `const failBootstrap = join(dir, "fail-bootstrap");`,
    `const nested = join(dir, "nested");`,
    `const [command, target, plistPath] = process.argv.slice(2);`,
    `if (command === "print") {`,
    `  if (!existsSync(marker)) process.exit(1);`,
    `  console.log(target + " = {");`,
    `  if (existsSync(nested)) {`,
    `    console.log("\\tenvironment = {");`,
    `    console.log("\\t\\tpath = " + readFileSync(nested, "utf8").trim());`,
    `    console.log("\\t}");`,
    `  }`,
    `  const path = readFileSync(marker, "utf8").trim();`,
    `  if (path !== "") console.log("\\tpath = " + path);`,
    `  console.log("}");`,
    `  process.exit(0);`,
    `}`,
    `if (command === "bootstrap" && existsSync(join(dir, "bootstrap-entered"))) {`,
    `  writeFileSync(join(dir, "bootstrap-pid"), String(process.pid));`,
    `  if (existsSync(join(dir, "outlives-stop"))) {`,
    `    process.on("SIGTERM", () => writeFileSync(join(dir, "bootstrap-stopped"), "SIGTERM\\n"));`,
    `  }`,
    `  writeFileSync(join(dir, "bootstrap-entered"), "bootstrap\\n");`,
    `  // The read opens in the thread pool, so the event loop stays free for the SIGTERM handler.`,
    `  await readFile(join(dir, "release-bootstrap"));`,
    `  writeFileSync(marker, plistPath);`,
    `  process.exit(0);`,
    `}`,
    `if (command === "bootstrap") {`,
    `  if (existsSync(failBootstrap)) process.exit(9);`,
    `  if (existsSync(marker)) process.exit(5);`,
    `  writeFileSync(marker, plistPath);`,
    `  process.exit(0);`,
    `}`,
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
  const home = await mkdtemp(join(tmpdir(), "snorlax-install-"));
  const stubDir = await mkdtemp(join(tmpdir(), "snorlax-launchctl-"));
  try {
    const launchctl = await writeStub(stubDir);
    await body({
      home,
      launchctl,
      os,
      record: join(stubDir, "argv.jsonl"),
      loaded: join(stubDir, "loaded"),
      failBootstrap: join(stubDir, "fail-bootstrap"),
      nested: join(stubDir, "nested"),
      bootstrapEntered: join(stubDir, "bootstrap-entered"),
      releaseBootstrap: join(stubDir, "release-bootstrap"),
      outlivesStop: join(stubDir, "outlives-stop"),
      bootstrapStopped: join(stubDir, "bootstrap-stopped"),
      bootstrapPid: join(stubDir, "bootstrap-pid")
    });
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

/** Every agent home the collector knows (plan 3.5); the S14 hash covers them all. */
const AGENT_DIRS = [".claude", ".codex", ".gemini", ".grok", ".local/share/opencode", ".pi"] as const;

const ensureAgentDirs = async (home: string): Promise<void> => {
  for (const name of AGENT_DIRS) {
    await mkdir(join(home, name), { recursive: true });
  }
};

const hashAgentDirs = async (home: string): Promise<string> => {
  const hash = createHash("sha256");
  for (const name of AGENT_DIRS) {
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
      expect(plist.StandardOutPath).toBe("/dev/null");
      expect(plist.StandardErrorPath).toBe("/dev/null");
      expect(plist.EnvironmentVariables.SNORLAX_HOME).toBe(dataDir);

      const again = run(env, ["install"]);
      expect(again.status).toBe(0);
      expect(again.stderr).toBe("");
      // Human output is redacted in cli/, so the plist path is spelled relative to the home.
      expect(again.stdout).toBe(
        `LaunchAgent installed at ${relative(env.home, plistPath)
          .split(sep)
          .join("/")
          .replace(/^Library/, "~/Library")}\n`
      );
      await decodePlist(plistPath);

      expect(await readInvocations(env.record)).toEqual([
        ["print", `${domain}/${LABEL}`],
        ["bootstrap", domain, plistPath],
        ["print", `${domain}/${LABEL}`],
        ["bootout", `${domain}/${LABEL}`],
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

  it("removes the plist it just wrote when bootstrap fails", async () => {
    await withInstallHome("darwin", async (env) => {
      const domain = `gui/${uid()}`;
      const plistPath = plistPathOf(env.home);
      await writeFile(env.failBootstrap, "1", "utf8");

      const installed = run(env, ["install", "--json"]);
      expect(installed.status).toBe(1);
      const failure = z.parse(failureSchema, json(installed.stdout));
      expect(failure.error.code).toBe("internal");
      expect(failure.error.message).toContain("launchctl bootstrap failed");
      // A failed command leaves no installed-looking state for the next login.
      expect(existsSync(plistPath)).toBe(false);
      expect(await readInvocations(env.record)).toEqual([
        ["print", `${domain}/${LABEL}`],
        ["bootstrap", domain, plistPath]
      ]);
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
        ["bootout", `${domain}/${LABEL}`],
        ["print", `${domain}/${LABEL}`]
      ]);
    });
  });

  it("uninstall on an empty home builds nothing: no data directory appears", async () => {
    await withInstallHome("darwin", async (env) => {
      const removed = run(env, ["uninstall", "--json"]);
      expect(removed.status).toBe(0);
      expect(removed.stdout).toBe('{"schemaVersion":1,"ok":true}\n');
      expect(existsSync(dataDirOf(env.home))).toBe(false);
    });
  });

  it("a refused install prepares nothing: the data directory is only built after the ownership check", async () => {
    await withInstallHome("darwin", async (env) => {
      const appPlist =
        "/Applications/Snorlax.app/Contents/Library/LaunchAgents/io.github.perfectpan.snorlax.refresh.plist";
      await writeFile(env.loaded, appPlist, "utf8");

      const installed = run(env, ["install", "--json"]);
      expect(installed.status).toBe(1);
      expect(existsSync(plistPathOf(env.home))).toBe(false);
      expect(existsSync(dataDirOf(env.home))).toBe(false);
    });
  });

  it("keeps the kernel's signal semantics: SIGTERM and SIGINT end the process by signal", async () => {
    await withInstallHome("darwin", async (env) => {
      // A launchctl stub whose `print` reports no loaded service and whose `bootstrap` sleeps until
      // orphaned, so `install` hangs inside launchctl and can be interrupted deterministically.
      const stub = join(env.home, "launchctl-hang.mjs");
      await writeFile(
        stub,
        [
          `#!${process.execPath}`,
          "const [command] = process.argv.slice(2);",
          'if (command === "print") process.exit(1);',
          'if (command === "bootstrap") {',
          "  const orphan = setInterval(() => {",
          "    if (process.ppid === 1) process.exit(9);",
          "  }, 100);",
          "  setTimeout(() => {",
          "    clearInterval(orphan);",
          "    process.exit(0);",
          "  }, 30_000);",
          "} else {",
          "  process.exit(2);",
          "}",
          ""
        ].join("\n"),
        "utf8"
      );
      await chmod(stub, 0o755);

      const runInterrupted = (signal: NodeJS.Signals): Promise<{ readonly name: string; readonly stdout: string }> =>
        new Promise((resolve) => {
          const child = spawnBundle(["install", "--json"], { home: env.home, launchctl: stub, os: "darwin" });
          let stdout = "";
          child.stdout.on("data", (chunk: Buffer) => {
            stdout += String(chunk);
          });
          // No timing assertion: the signal lands whenever the child is up, and the exit event waits.
          const timer = setTimeout(() => child.kill(signal), 500);
          child.on("exit", (code, name) => {
            clearTimeout(timer);
            void code;
            resolve({ name: name ?? "", stdout });
          });
        });

      const term = await runInterrupted("SIGTERM");
      expect(term.name).toBe("SIGTERM");
      expect(term.stdout).toBe("");
      const interrupt = await runInterrupted("SIGINT");
      expect(interrupt.name).toBe("SIGINT");
      expect(interrupt.stdout).toBe("");
    });
  });

  describe("a SIGTERM while launchctl bootstrap runs", () => {
    /**
     * Runs `install` until the stub's held bootstrap announces itself, signals snorlax with SIGTERM, then lets
     * `afterSignal` finish the stub. Every step waits on a FIFO or a process event, never on time.
     */
    const installSignaledInBootstrap = async (env: InstallEnv, afterSignal: () => Promise<void>) => {
      for (const fifo of [env.bootstrapEntered, env.releaseBootstrap, env.bootstrapStopped]) {
        execFileSync("/usr/bin/mkfifo", [fifo]);
      }
      const entered = readFile(env.bootstrapEntered, "utf8");
      const child = spawnBundle(["install", "--json"], { home: env.home, launchctl: env.launchctl, os: "darwin" });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += String(chunk);
      });
      const exited = new Promise<NodeJS.Signals | null>((resolve) => {
        child.on("exit", (_code, signal) => resolve(signal));
      });
      expect(await entered).toBe("bootstrap\n");
      child.kill("SIGTERM");
      await afterSignal();
      const signal = await exited;
      const pid = Number(await readFile(env.bootstrapPid, "utf8"));
      const stubAlive = (() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })();
      return { signal, stdout, stubAlive };
    };

    it("boots out a service the bootstrap loaded before it stopped, and removes the plist", async () => {
      await withInstallHome("darwin", async (env) => {
        await writeFile(env.outlivesStop, "", "utf8");
        const outcome = await installSignaledInBootstrap(env, async () => {
          // The stub reports the SIGTERM snorlax relayed to it, so snorlax is now waiting for it to exit; the
          // bootstrap then completes, as one already in launchd does.
          expect(await readFile(env.bootstrapStopped, "utf8")).toBe("SIGTERM\n");
          await writeFile(env.releaseBootstrap, "release\n", "utf8");
        });

        expect(outcome).toEqual({ signal: "SIGTERM", stdout: "", stubAlive: false });
        const target = `gui/${uid()}/${LABEL}`;
        expect(await readInvocations(env.record)).toEqual([
          ["print", target],
          ["bootstrap", `gui/${uid()}`, plistPathOf(env.home)],
          ["print", target],
          ["bootout", target]
        ]);
        expect(existsSync(env.loaded)).toBe(false);
        expect(existsSync(plistPathOf(env.home))).toBe(false);
      });
    });

    it("boots out nothing when the bootstrap stops before it loads, and removes the plist", async () => {
      await withInstallHome("darwin", async (env) => {
        // Without outlives-stop the held bootstrap ends at the SIGTERM, before it loads anything.
        const outcome = await installSignaledInBootstrap(env, async () => {});

        expect(outcome).toEqual({ signal: "SIGTERM", stdout: "", stubAlive: false });
        const target = `gui/${uid()}/${LABEL}`;
        expect(await readInvocations(env.record)).toEqual([
          ["print", target],
          ["bootstrap", `gui/${uid()}`, plistPathOf(env.home)],
          ["print", target]
        ]);
        expect(existsSync(env.loaded)).toBe(false);
        expect(existsSync(plistPathOf(env.home))).toBe(false);
      });
    });
  });

  it("refuses to install or uninstall while Snorlax.app's Launch at login owns the loaded service", async () => {
    await withInstallHome("darwin", async (env) => {
      const appPlist =
        "/Applications/Snorlax.app/Contents/Library/LaunchAgents/io.github.perfectpan.snorlax.refresh.plist";
      await writeFile(env.loaded, appPlist, "utf8");

      const installed = run(env, ["install", "--json"]);
      expect(installed.status).toBe(1);
      const installFailure = z.parse(failureSchema, json(installed.stdout));
      expect(installFailure.error.code).toBe("internal");
      expect(installFailure.error.message).toContain("Launch at login");
      expect(existsSync(plistPathOf(env.home))).toBe(false);

      const removed = run(env, ["uninstall", "--data", "--json"]);
      expect(removed.status).toBe(1);
      expect(z.parse(failureSchema, json(removed.stdout)).error.code).toBe("internal");
      // Nothing was touched: no plist, no data deletion, no launchctl call beyond the two prints.
      // Neither command prepares the data directory (install only after the ownership check, uninstall
      // never), so the empty home stays empty.
      expect(existsSync(dataDirOf(env.home))).toBe(false);
      expect(await readInvocations(env.record)).toEqual([
        ["print", `gui/${uid()}/${LABEL}`],
        ["print", `gui/${uid()}/${LABEL}`]
      ]);
    });
  });

  it("refuses when launchctl print does not name the loaded service's plist", async () => {
    await withInstallHome("darwin", async (env) => {
      await writeFile(env.loaded, "", "utf8");

      const installed = run(env, ["install", "--json"]);
      expect(installed.status).toBe(1);
      const failure = z.parse(failureSchema, json(installed.stdout));
      expect(failure.error.message).toContain("cannot be confirmed");
      // The refusal names the next steps: the app's Settings toggle, and the print command to inspect.
      expect(failure.error.message).toContain("Settings");
      expect(failure.error.message).toContain("launchctl print gui/");
      expect(existsSync(plistPathOf(env.home))).toBe(false);

      expect(run(env, ["uninstall", "--json"]).status).toBe(1);
      expect(existsSync(plistPathOf(env.home))).toBe(false);
    });
  });

  it("reads the service path only from the top level of the print output", async () => {
    await withInstallHome("darwin", async (env) => {
      const appPlist =
        "/Applications/Snorlax.app/Contents/Library/LaunchAgents/io.github.perfectpan.snorlax.refresh.plist";
      const target = `gui/${uid()}/${LABEL}`;
      // A nested block prints the app's plist before the service's own path; ownership still reads
      // as the CLI's, so the repeat install proceeds.
      await writeFile(env.loaded, plistPathOf(env.home), "utf8");
      await writeFile(env.nested, appPlist, "utf8");
      expect(run(env, ["install", "--json"]).status).toBe(0);
      expect(await readInvocations(env.record)).toEqual([
        ["print", target],
        ["bootout", target],
        ["bootstrap", `gui/${uid()}`, plistPathOf(env.home)]
      ]);

      // The reverse must not grant ownership: a nested CLI path under an app-owned service stays refused.
      await writeFile(env.loaded, appPlist, "utf8");
      await writeFile(env.nested, plistPathOf(env.home), "utf8");
      expect(run(env, ["install", "--json"]).status).toBe(1);
    });
  });

  it("boots out by service target when the CLI's own service is loaded but its plist was deleted", async () => {
    await withInstallHome("darwin", async (env) => {
      const target = `gui/${uid()}/${LABEL}`;
      // launchd still has the service; the plist on disk is gone.
      await writeFile(env.loaded, plistPathOf(env.home), "utf8");

      const removed = run(env, ["uninstall", "--json"]);
      expect(removed.status).toBe(0);
      expect(removed.stdout).toBe('{"schemaVersion":1,"ok":true}\n');
      expect(await readInvocations(env.record)).toEqual([
        ["print", target],
        ["bootout", target]
      ]);
    });
  });

  it("keeps a user file inside the data directory's logs/ and lists it", async () => {
    await withInstallHome("darwin", async (env) => {
      const dataDir = dataDirOf(env.home);
      await mkdir(join(dataDir, "logs"), { recursive: true });
      await writeFile(join(dataDir, "logs", "keep.txt"), "unrelated\n");
      // The ledger a refresh creates marks the directory as snorlax's, which --data requires.
      expect(run(env, ["refresh", "--json"]).status).toBe(0);

      const removed = run(env, ["uninstall", "--data"]);
      expect(removed.status).toBe(0);
      expect(existsSync(join(dataDir, "logs", "keep.txt"))).toBe(true);
      expect(removed.stdout).toContain("logs/keep.txt");
    });
  });

  it("keeps ~/Library/Logs intact when SNORLAX_HOME points at ~/Library", async () => {
    await withInstallHome("darwin", async (env) => {
      const reports = join(env.home, "Library", "Logs", "DiagnosticReports");
      await mkdir(reports, { recursive: true });
      await writeFile(join(reports, "x.ips"), "crash report\n");
      expect(run(env, ["refresh", "--json"], { snorlaxHome: join(env.home, "Library") }).status).toBe(0);

      // `logs` matches the user's `Logs` on a case-insensitive volume; only known log files may go.
      const removed = run(env, ["uninstall", "--data", "--json"], { snorlaxHome: join(env.home, "Library") });
      expect(removed.status).toBe(0);
      expect(existsSync(join(reports, "x.ips"))).toBe(true);
      expect(existsSync(join(env.home, "Library"))).toBe(true);
    });
  });

  it("refuses --data before touching the LaunchAgent when the data directory is not deletable", async () => {
    await withInstallHome("darwin", async (env) => {
      const domain = `gui/${uid()}`;
      const plistPath = plistPathOf(env.home);
      expect(run(env, ["install", "--json"]).status).toBe(0);

      const removed = run(env, ["uninstall", "--data", "--json"], { snorlaxHome: env.home });
      expect(removed.status).toBe(1);
      expect(z.parse(failureSchema, json(removed.stdout)).error.code).toBe("data-dir");
      // Nothing changed before the refusal: the service is still loaded and the plist still in place.
      expect(existsSync(plistPath)).toBe(true);
      expect(await readInvocations(env.record)).toEqual([
        ["print", `${domain}/${LABEL}`],
        ["bootstrap", domain, plistPath]
      ]);
    });
  });

  it("refuses --data in a directory without a snorlax ledger and changes nothing in it", async () => {
    await withInstallHome("darwin", async (env) => {
      const domain = `gui/${uid()}`;
      const plistPath = plistPathOf(env.home);
      expect(run(env, ["install", "--json"]).status).toBe(0);
      // Entries under the names snorlax writes, none of them snorlax's.
      const other = join(env.home, "other");
      await mkdir(join(other, "logs"), { recursive: true });
      await writeFile(join(other, "config.json"), '{"theirs":true}\n');
      await writeFile(join(other, "snapshot.json"), "{}\n");
      await writeFile(join(other, "node-path"), "/usr/bin/node\n");
      await writeFile(join(other, "logs", "snorlax.log"), "theirs\n");

      const expectRefused = async (reason: string): Promise<void> => {
        const before = await hashTree(other);
        const removed = run(env, ["uninstall", "--data", "--json"], { snorlaxHome: other });
        expect(removed.status).toBe(1);
        expect(await hashTree(other)).toBe(before);
        const failure = z.parse(failureSchema, json(removed.stdout)).error;
        expect(failure.code).toBe("data-dir");
        expect(failure.message).toContain("not a snorlax data directory: ~/other");
        expect(failure.message).toContain(reason);
      };
      await expectRefused("no ledger.db");

      // Another program's ledger.db in WAL mode: opening it, even read-only, would add -wal and -shm files.
      const wal = new DatabaseSync(join(other, "ledger.db"));
      wal.exec("PRAGMA journal_mode = WAL; CREATE TABLE entries (amount INTEGER)");
      wal.close();
      await expectRefused("not a SQLite database in rollback-journal mode");

      await rm(join(other, "ledger.db"));
      const rollback = new DatabaseSync(join(other, "ledger.db"));
      rollback.exec("CREATE TABLE entries (amount INTEGER)");
      rollback.close();
      await expectRefused("cannot read the ledger");

      // The refusals came before launchctl was asked anything: the installed service is untouched.
      expect(existsSync(plistPath)).toBe(true);
      expect(await readInvocations(env.record)).toEqual([
        ["print", `${domain}/${LABEL}`],
        ["bootstrap", domain, plistPath]
      ]);
    });
  });

  it("doctor reports a LaunchAgent whose Node is gone as an error and changes nothing", async () => {
    await withInstallHome("darwin", async (env) => {
      // A healthy data directory, so the schedule check is the only one that can fail.
      const dataDir = dataDirOf(env.home);
      await mkdir(dataDir);
      await chmod(dataDir, 0o700);
      const plistPath = plistPathOf(env.home);
      const writePlist = (nodePath: string) =>
        writeFile(
          plistPath,
          renderLaunchAgentPlist({ nodePath, cliPath: resolve(bundle), dataDir, snorlaxHome: dataDir })
        );
      await mkdir(dirname(plistPath), { recursive: true });
      // The versioned Node `install` ran on, removed since by a Node upgrade; launchd still has the job loaded.
      await writePlist(join(env.home, ".nvm", "versions", "node", "v22.13.0", "bin", "node"));
      await writeFile(env.loaded, plistPath, "utf8");
      const before = await hashTree(env.home);

      const doctor = run(env, ["doctor", "--json"]);
      expect(doctor.status).toBe(0);
      const payload = z.parse(doctorSchema, json(doctor.stdout));
      expect(payload.healthy).toBe(false);
      expect(payload.checks.filter((check) => check.status === "error").map((check) => check.id)).toEqual(["schedule"]);
      const schedule = payload.checks.find((check) => check.id === "schedule");
      expect(schedule?.detail).toContain("~/.nvm/versions/node/v22.13.0/bin/node, which does not exist");
      expect(schedule?.detail).toContain("`snorlax install`");
      expect(await hashTree(env.home)).toBe(before);
      expect(await readInvocations(env.record)).toEqual([["print", `gui/${uid()}/${LABEL}`]]);

      // The same job on a Node that exists reads as healthy.
      await writePlist(process.execPath);
      const healthy = z.parse(doctorSchema, json(run(env, ["doctor", "--json"]).stdout));
      expect(healthy.checks.find((check) => check.id === "schedule")?.status).toBe("ok");
      expect(healthy.healthy).toBe(true);
    });
  });

  it("reports a data-dir failure when an emptied data directory cannot be removed", async () => {
    await withInstallHome("darwin", async (env) => {
      // install and a refresh create the data directory and its ledger; the read-only HOME then keeps its rmdir
      // from succeeding.
      expect(run(env, ["install", "--json"]).status).toBe(0);
      expect(run(env, ["refresh", "--json"]).status).toBe(0);
      await chmod(env.home, 0o555);
      try {
        const removed = run(env, ["uninstall", "--data", "--json"]);
        expect(removed.status).toBe(1);
        const failure = z.parse(failureSchema, json(removed.stdout));
        expect(failure.error.code).toBe("data-dir");
        expect(failure.error.message).toContain("cannot delete");
      } finally {
        await chmod(env.home, 0o755);
      }
      expect(existsSync(dataDirOf(env.home))).toBe(true);
    });
  });

  it("uninstall --data deletes the data directory and leaves the fixture agent files", async () => {
    await withInstallHome("darwin", async (env) => {
      await ensureAgentDirs(env.home);
      await writeFixtures(env.home);
      const before = await hashAgentDirs(env.home);
      expect(run(env, ["install", "--json"]).status).toBe(0);
      expect(run(env, ["refresh", "--json"]).status).toBe(0);

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

  it("uninstall --data deletes only the entries snorlax wrote and keeps everything else", async () => {
    await withInstallHome("darwin", async (env) => {
      await writeUsageFixtures(env.home);
      const dataDir = dataDirOf(env.home);
      await mkdir(join(dataDir, "Documents"), { recursive: true });
      await writeFile(join(dataDir, "Documents", "thesis.txt"), "unrelated\n");
      await writeFile(join(dataDir, "photo.jpg"), "unrelated\n");

      expect(run(env, ["install", "--json"]).status).toBe(0);
      const refreshed = run(env, ["refresh", "--json"]);
      expect(refreshed.status).toBe(0);
      expect(existsSync(join(dataDir, "ledger.db"))).toBe(true);
      expect(existsSync(join(dataDir, "snapshot.json"))).toBe(true);

      const removed = run(env, ["uninstall", "--data"]);
      expect(removed.status).toBe(0);
      // Human output is redacted in cli/, so the data directory is spelled relative to the home.
      expect(removed.stdout).toBe(
        "LaunchAgent removed\n" +
          "the data directory ~/data is kept; entries snorlax did not write remain: Documents, photo.jpg\n"
      );
      expect(existsSync(join(dataDir, "Documents", "thesis.txt"))).toBe(true);
      expect(existsSync(join(dataDir, "photo.jpg"))).toBe(true);
      expect(existsSync(join(dataDir, "ledger.db"))).toBe(false);
      expect(existsSync(join(dataDir, "snapshot.json"))).toBe(false);
      expect(existsSync(join(dataDir, "logs"))).toBe(false);
    });
  });

  it("never deletes unknown files when SNORLAX_HOME spells HOME in another letter case", async () => {
    await withInstallHome("darwin", async (env) => {
      await mkdir(join(env.home, "Documents"), { recursive: true });
      await writeFile(join(env.home, "Documents", "thesis.txt"), "unrelated\n");
      await writeFile(join(env.home, "keep.txt"), "unrelated\n");
      const variant = env.home
        .split("")
        .map((ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()))
        .join("");

      // The platform realpath canonicalizes letter case on the default APFS, so on a Mac the guard
      // refuses. On a case-sensitive file system the variant is a different path, often one that
      // cannot even be created (the CI home is under /home), so only the kept files are asserted.
      const result = run(env, ["uninstall", "--data", "--json"], { snorlaxHome: variant });
      if (process.platform === "darwin") {
        expect(result.status).toBe(1);
        expect(z.parse(failureSchema, json(result.stdout)).error.code).toBe("data-dir");
      }
      expect(existsSync(join(env.home, "Documents", "thesis.txt"))).toBe(true);
      expect(existsSync(join(env.home, "keep.txt"))).toBe(true);
      expect(existsSync(env.home)).toBe(true);
    });
  });

  it("keeps fixture agent directories unchanged across install, refresh, and uninstall", async () => {
    await withInstallHome("darwin", async (env) => {
      await ensureAgentDirs(env.home);
      await writeUsageFixtures(env.home);
      const before = await hashAgentDirs(env.home);
      const topBefore = (await readdir(env.home)).sort();
      expect(run(env, ["install", "--json"]).status).toBe(0);

      const refreshed = run(env, ["refresh", "--json"]);
      expect(refreshed.status).toBe(0);
      const result = z.parse(refreshResultSchema, json(refreshed.stdout));
      expect(result.ok).toBe(true);
      expect(result.records).toBeGreaterThan(0);

      expect(run(env, ["uninstall", "--json"]).status).toBe(0);
      expect(await hashAgentDirs(env.home)).toBe(before);
      // R1/S14: install, refresh and uninstall add only the agent's own LaunchAgents entry and the
      // data directory to HOME's top level — no agent directory is created, filled, or touched.
      expect((await readdir(env.home)).sort()).toEqual([...topBefore, "Library", "data"].sort());
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
      // The refusal happens in the scheduler before any preparation, so nothing was created either.
      expect(existsSync(dataDirOf(env.home))).toBe(false);

      const removed = run(env, ["uninstall", "--data", "--json"]);
      expect(removed.status).toBe(1);
      expect(z.parse(failureSchema, json(removed.stdout)).error.message).toContain("Batch 8");
      expect(existsSync(dataDirOf(env.home))).toBe(false);
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
    expect(parsed.data.StandardOutPath).toBe("/dev/null");
    expect(parsed.data.StandardErrorPath).toBe("/dev/null");
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

  it("reads the Node path back from the plist it renders, and from no other layout", () => {
    const nodePath = "/opt/node &amp; <co>/bin/node";
    const xml = renderLaunchAgentPlist({ nodePath, cliPath: "/opt/snorlax/snorlax.mjs", dataDir: "/tmp/data" });
    expect(launchAgentNodePath(xml)).toBe(nodePath);
    expect(launchAgentNodePath(plist.build({ Program: "/usr/bin/node" }))).toBeUndefined();
  });
});

describe("uninstall --data path guard", () => {
  /** Stands in for `Platform["fs"]["realpath"]`; resolve checks only need that member. */
  const fakeFs = { realpath: async (path: string): Promise<string | undefined> => path };
  /** `/var` is a symlink to `/private/var` on macOS. */
  const symlinkFs = {
    realpath: async (path: string): Promise<string | undefined> => path.replace(/^\/var/, "/private/var")
  };

  it("refuses to delete /, the home directory, its ancestors, or a relative path", async () => {
    await expect(Effect.runPromise(resolvedDeletableDataDir(fakeFs, "/", "/tmp/home"))).rejects.toThrow(
      /refusing to delete/
    );
    await expect(Effect.runPromise(resolvedDeletableDataDir(fakeFs, "/tmp/home", "/tmp/home"))).rejects.toThrow(
      /refusing to delete/
    );
    await expect(Effect.runPromise(resolvedDeletableDataDir(fakeFs, "/tmp", "/tmp/home"))).rejects.toThrow(
      /refusing to delete/
    );
    await expect(Effect.runPromise(resolvedDeletableDataDir(fakeFs, "relative/data", "/tmp/home"))).rejects.toThrow(
      /must be absolute/
    );
    await expect(Effect.runPromise(resolvedDeletableDataDir(fakeFs, "/tmp/home/snorlax", "/tmp/home"))).resolves.toBe(
      "/tmp/home/snorlax"
    );
    await expect(Effect.runPromise(resolvedDeletableDataDir(fakeFs, "/", "/tmp/home"))).rejects.toThrow(
      DataDirNotDeletable
    );
  });

  it("compares through realpath, so a symlinked spelling of the home directory is refused too", async () => {
    await expect(
      Effect.runPromise(resolvedDeletableDataDir(symlinkFs, "/var/home", "/private/var/home"))
    ).rejects.toThrow(/refusing to delete/);
    await expect(
      Effect.runPromise(resolvedDeletableDataDir(symlinkFs, "/var/home/data", "/private/var/home"))
    ).resolves.toBe("/var/home/data");
  });
});
