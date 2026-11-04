import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNodePlatform } from "@rivus/agent-kit/node";
import type { Platform } from "@rivus/agent-kit/platform";
import { createMemoryPlatform } from "@rivus/agent-kit/testing";
import { failureSchema } from "@rivus/snorlax-protocol";
import { Effect, Layer } from "effect";
import * as z from "zod/mini";
import { describe, expect, it } from "vite-plus/test";

import type { Scheduler } from "../src/capabilities/scheduler/scheduler.ts";
import { CliEnv } from "../src/cli/env.ts";
import { runCli } from "../src/cli/run.ts";
import { NodeFiles, SnorlaxPlatform, type NodeFileOps } from "../src/modules/platform/platform.ts";
import { offlineCapabilities } from "./fixtures/capabilities.ts";
import { runBundle } from "./fixtures/bundle.ts";
import { readLedger } from "./fixtures/flows.ts";
import { memoryKitPlatform } from "./fixtures/platform.ts";
import { fakeScheduler, type SchedulerCall } from "./fixtures/scheduler.ts";

/**
 * The install and uninstall commands in process, on the agent-kit memory platform over a fake scheduler
 * (what the commands hand the scheduler and print), and the `SNORLAX_OS` override of the system's
 * scheduler: `cli/bin.ts` picks it, so that test runs the built bundle (`pnpm run build` first). The
 * launchd and systemd implementations' interrupted installs and `inspect` are unit-tested beside
 * `src/capabilities/scheduler/scheduler.ts`; the bundle tests in `install-uninstall.test.ts` cover
 * launchd itself through a `launchctl` stub.
 */

const HOME = "/testroot/tester";
const DATA_DIR = `${HOME}/snorlax-data`;
const JOB_FILE = `${HOME}/Library/LaunchAgents/fake.plist`;

const jobName = (kind: "launchd" | "systemd"): string => (kind === "systemd" ? "systemd user timer" : "LaunchAgent");

type MemoryPlatform = ReturnType<typeof createMemoryPlatform>;

/** The data directory's mode and the log lines are not what these tests are about. */
const quietNodeFiles: NodeFileOps = {
  append: async () => {},
  chmod: async () => {},
  mode: async () => 0o700
};

const memoryPlatform = (env: Record<string, string>, files: Record<string, string> = {}): MemoryPlatform =>
  createMemoryPlatform({ home: HOME, env: { SNORLAX_HOME: DATA_DIR, ...env }, os: "darwin", files });

const runOn = async (
  args: readonly string[],
  platform: Platform,
  scheduler: Layer.Layer<Scheduler, never, SnorlaxPlatform>
) => {
  const out: string[] = [];
  const err: string[] = [];
  const platformLayer = Layer.succeed(SnorlaxPlatform, platform);
  const base = Layer.mergeAll(
    Layer.provideMerge(scheduler, platformLayer),
    Layer.succeed(NodeFiles, quietNodeFiles),
    Layer.succeed(
      CliEnv,
      CliEnv.of({
        stdout: { write: (text) => void out.push(text) },
        stderr: { write: (text) => void err.push(text) },
        colors: false
      })
    ),
    offlineCapabilities
  );
  const exit = await Effect.runPromise(Effect.flip(runCli(args, base)));
  return { exitCode: exit.exitCode, stdout: out.join(""), stderr: err.join("") };
};

const runCommand = (
  args: readonly string[],
  platform: MemoryPlatform,
  scheduler: Layer.Layer<Scheduler, never, SnorlaxPlatform>
) => runOn(args, memoryKitPlatform(platform), scheduler);

const failureOf = (stdout: string) => z.parse(failureSchema, JSON.parse(stdout)).error;

describe("install and uninstall on a fake scheduler", () => {
  it("install hands the scheduler the data directory, which it prepares only through the scheduler", async () => {
    const calls: SchedulerCall[] = [];
    const platform = memoryPlatform({});
    const json = await runCommand(["install", "--json"], platform, fakeScheduler(calls, { jobFile: JOB_FILE }));
    expect(json).toEqual({ exitCode: 0, stdout: '{"schemaVersion":1,"ok":true}\n', stderr: "" });
    expect(calls).toEqual([{ operation: "install", dataDir: DATA_DIR }]);
    expect((await platform.fs.stat(`${DATA_DIR}/logs`))?.kind).toBe("dir");

    const kind = "launchd" as const;
    const human = await runCommand(["install"], platform, fakeScheduler([], { jobFile: JOB_FILE, kind }));
    expect(human.stdout).toBe(`${jobName(kind)} installed at ~/Library/LaunchAgents/fake.plist\n`);
  });

  it("a refused install fails as internal and builds nothing", async () => {
    const calls: SchedulerCall[] = [];
    const platform = memoryPlatform({});
    const refused = await runCommand(
      ["install", "--json"],
      platform,
      fakeScheduler(calls, { jobFile: JOB_FILE, ownedElsewhere: true })
    );
    expect(refused.exitCode).toBe(1);
    expect(failureOf(refused.stdout)).toEqual({
      code: "internal",
      message: "refusing to change the LaunchAgent: owned by the app"
    });
    expect(calls).toEqual([]);
    expect(await platform.fs.stat(DATA_DIR)).toBeUndefined();
  });

  it("uninstall --data removes the job, then deletes what snorlax wrote and names what it kept", async () => {
    // --data needs the ledger SQLite reads as the snorlax marker, so this run is on the Node platform over a
    // temporary home rather than the memory platform.
    const home = await mkdtemp(join(tmpdir(), "snorlax-uninstall-"));
    try {
      const dataDir = join(home, "snorlax-data");
      const platform = createNodePlatform({ home, env: { SNORLAX_HOME: dataDir, PATH: "/usr/bin:/bin" } });
      const { sqlite } = platform;
      if (sqlite === undefined) {
        throw new Error("the agent-kit Node platform must provide SQLite");
      }
      await mkdir(join(dataDir, "logs"), { recursive: true });
      await writeFile(join(dataDir, "config.json"), "{}");
      await writeFile(join(dataDir, "logs", "snorlax.log"), "");
      await writeFile(join(dataDir, "notes.txt"), "mine");
      await readLedger({ fs: platform.fs, sqlite }, dataDir, Effect.succeed);

      const calls: SchedulerCall[] = [];
      const kind = "launchd" as const;
      const kept = await runOn(["uninstall", "--data"], platform, fakeScheduler(calls, { jobFile: JOB_FILE, kind }));
      expect(kept).toEqual({
        exitCode: 0,
        stdout:
          `${jobName(kind)} removed\n` +
          "the data directory ~/snorlax-data is kept; entries snorlax did not write remain: notes.txt\n",
        stderr: ""
      });
      expect(calls).toEqual([{ operation: "uninstall", dataDir }]);
      expect(await platform.fs.stat(join(dataDir, "config.json"))).toBeUndefined();
      expect(await platform.fs.stat(join(dataDir, "logs"))).toBeUndefined();

      // The ledger went with the first run; the directory left empty passes without it.
      await platform.fs.remove(join(dataDir, "notes.txt"));
      const deleted = await runOn(["uninstall", "--data"], platform, fakeScheduler([], { jobFile: JOB_FILE, kind }));
      expect(deleted.stdout).toBe(`${jobName(kind)} removed and data directory deleted\n`);
      expect(await platform.fs.stat(dataDir)).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("uninstall --data refuses the home directory before the scheduler changes anything", async () => {
    const calls: SchedulerCall[] = [];
    const platform = memoryPlatform({ SNORLAX_HOME: HOME }, { [`${HOME}/config.json`]: "{}" });
    const refused = await runCommand(
      ["uninstall", "--data", "--json"],
      platform,
      fakeScheduler(calls, { jobFile: JOB_FILE })
    );
    expect(refused.exitCode).toBe(1);
    expect(failureOf(refused.stdout).code).toBe("data-dir");
    expect(calls).toEqual([]);
    expect((await platform.fs.stat(`${HOME}/config.json`))?.kind).toBe("file");
  });

  it("names a LaunchAgent or a systemd user timer from the kind the same fake scheduler declares", async () => {
    // The platform says linux while this process is whatever host runs the test. The sentences follow `kind`.
    const jobFile = `${HOME}/refresh-job`;
    for (const kind of ["launchd", "systemd"] as const) {
      const platform = createMemoryPlatform({
        home: HOME,
        env: { SNORLAX_HOME: DATA_DIR },
        os: "linux"
      });
      const name = jobName(kind);
      const scheduler = fakeScheduler([], { jobFile, kind });
      const installed = await runCommand(["install"], platform, scheduler);
      expect(installed).toEqual({
        exitCode: 0,
        stdout: `${name} installed at ~/refresh-job\n`,
        stderr: ""
      });
      const removed = await runCommand(["uninstall"], platform, scheduler);
      expect(removed).toEqual({ exitCode: 0, stdout: `${name} removed\n`, stderr: "" });
    }
  });
});

describe("the system's scheduler", () => {
  it("SNORLAX_OS reaches only install and uninstall: status runs with an unknown value", async () => {
    const home = await mkdtemp(join(tmpdir(), "snorlax-os-"));
    try {
      const dataDir = join(home, "snorlax-data");
      // A failing stub, so even a wrong pick never reaches the real launchctl.
      const launchctl = join(home, "launchctl");
      await writeFile(launchctl, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const runBogus = (args: readonly string[]) => {
        const result = runBundle(args, { home, dataDir, launchctl, os: "bogus" });
        return { exitCode: result.status, stdout: result.stdout };
      };
      expect(runBogus(["status", "--json"]).exitCode).toBe(0);
      for (const command of ["install", "uninstall"]) {
        const failed = runBogus([command, "--json"]);
        expect(failed.exitCode).toBe(1);
        expect(failureOf(failed.stdout)).toEqual({
          code: "internal",
          message: "SNORLAX_OS must be darwin, linux, or win32"
        });
      }
      expect(existsSync(dataDir)).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
