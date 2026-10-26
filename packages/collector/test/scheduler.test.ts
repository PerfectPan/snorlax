import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { createNodePlatform } from "@rivus/agent-kit/node";
import type { Platform } from "@rivus/agent-kit/platform";
import { createMemoryPlatform } from "@rivus/agent-kit/testing";
import { failureSchema } from "@rivus/snorlax-protocol";
import { Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import * as z from "zod/mini";
import { describe, expect, it } from "vite-plus/test";

import { renderLaunchAgentPlist } from "../src/capabilities/scheduler/plist.ts";
import { renderRefreshService } from "../src/capabilities/scheduler/units.ts";
import { Scheduler, type JobInspection } from "../src/capabilities/scheduler/scheduler.ts";
import { CliEnv } from "../src/cli/env.ts";
import { runCli } from "../src/cli/run.ts";
import { NodeFiles, SnorlaxPlatform, type NodeFileOps } from "../src/modules/platform/platform.ts";
import { runBundle } from "./fixtures/bundle.ts";
import { memoryKitPlatform } from "./fixtures/platform.ts";
import { readLedger } from "./fixtures/flows.ts";
import { fakeScheduler, type SchedulerCall } from "./fixtures/scheduler.ts";

/**
 * The scheduler capability in process, on the agent-kit memory platform: `install` and `uninstall` over the
 * fake scheduler (what the commands hand the scheduler and print) and the launchd implementation's cleanup
 * when a run is interrupted. The system's scheduler is picked in `cli/bin.ts`, so that test runs the built
 * bundle (`pnpm run build` first). The bundle tests in `install-uninstall.test.ts` cover launchd itself
 * through a `launchctl` stub.
 */

const HOME = "/testroot/tester";
const DATA_DIR = `${HOME}/snorlax-data`;
const JOB_FILE = `${HOME}/Library/LaunchAgents/fake.plist`;
const LAUNCHCTL = "/stub/launchctl";
const PLIST = `${HOME}/Library/LaunchAgents/io.github.perfectpan.snorlax.refresh.plist`;

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
    )
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

    const human = await runCommand(["install"], platform, fakeScheduler([], { jobFile: JOB_FILE }));
    expect(human.stdout).toBe("LaunchAgent installed at ~/Library/LaunchAgents/fake.plist\n");
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
      const kept = await runOn(["uninstall", "--data"], platform, fakeScheduler(calls, { jobFile: JOB_FILE }));
      expect(kept).toEqual({
        exitCode: 0,
        stdout:
          "LaunchAgent removed\nthe data directory ~/snorlax-data is kept; entries snorlax did not write remain: notes.txt\n",
        stderr: ""
      });
      expect(calls).toEqual([{ operation: "uninstall", dataDir }]);
      expect(await platform.fs.stat(join(dataDir, "config.json"))).toBeUndefined();
      expect(await platform.fs.stat(join(dataDir, "logs"))).toBeUndefined();

      // The ledger went with the first run; the directory left empty passes without it.
      await platform.fs.remove(join(dataDir, "notes.txt"));
      const deleted = await runOn(["uninstall", "--data"], platform, fakeScheduler([], { jobFile: JOB_FILE }));
      expect(deleted.stdout).toBe("LaunchAgent removed and data directory deleted\n");
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

  it("an interrupted install stops launchctl and removes the plist it wrote (plan 3.13 rule 6)", async () => {
    const bootstrap: { signal?: AbortSignal; plistWritten?: boolean; started: () => void } = { started: () => {} };
    const started = new Promise<void>((resolve) => {
      bootstrap.started = resolve;
    });
    const box: { platform?: MemoryPlatform } = {};
    // `print` reports no loaded service; `bootstrap` hangs until the run's signal stops it.
    const platform = createMemoryPlatform({
      home: HOME,
      env: { SNORLAX_HOME: DATA_DIR, SNORLAX_LAUNCHCTL: LAUNCHCTL },
      os: "darwin",
      commands: {
        [LAUNCHCTL]: async (args, options) => {
          if (args[0] !== "bootstrap") {
            return { code: 1 };
          }
          bootstrap.signal = options.signal;
          bootstrap.plistWritten = (await box.platform?.fs.stat(PLIST))?.kind === "file";
          bootstrap.started();
          return new Promise((resolve) => {
            options.signal?.addEventListener("abort", () => resolve({ code: null, signal: "SIGTERM" }));
          });
        }
      }
    });
    box.platform = platform;
    const install = Effect.gen(function* () {
      return yield* (yield* Scheduler).install({ dataDir: DATA_DIR }, Effect.void);
    }).pipe(
      Effect.provide(Layer.provide(Scheduler.launchd, Layer.succeed(SnorlaxPlatform, memoryKitPlatform(platform))))
    );

    const fiber = Effect.runFork(install);
    await started;
    expect(bootstrap.plistWritten).toBe(true);
    expect(bootstrap.signal?.aborted).toBe(false);

    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(bootstrap.signal?.aborted).toBe(true);
    expect(await platform.fs.stat(PLIST)).toBeUndefined();
  });
});

describe("an install interrupted inside launchctl bootstrap", () => {
  const domain = `gui/${process.getuid?.()}`;
  const target = `${domain}/io.github.perfectpan.snorlax.refresh`;

  /**
   * A launchctl that behaves like a real child: a stopped `bootstrap` does not end at the abort but exits only once
   * `exitBootstrap` is called, having loaded the service from its plist when `loads` is true. `print` and `bootout`
   * answer from that state, and every argv is recorded in `runs`.
   */
  const launchctlOutlivingAbort = (loads: boolean) => {
    const runs: (readonly string[])[] = [];
    const state: { loadedFrom?: string } = {};
    const signals = { entered: () => {}, aborted: () => {}, exit: () => {} };
    const entered = new Promise<void>((resolve) => {
      signals.entered = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      signals.aborted = resolve;
    });
    const exited = new Promise<void>((resolve) => {
      signals.exit = resolve;
    });
    const answer = (code: number, stdout = "") => ({ code, signal: null, stdout, stderr: "", timedOut: false });
    const run: Platform["process"]["run"] = async (_command, args, options) => {
      runs.push(args);
      if (args[0] === "print") {
        return state.loadedFrom === undefined
          ? answer(113)
          : answer(0, `${target} = {\n\tpath = ${state.loadedFrom}\n}\n`);
      }
      if (args[0] === "bootout") {
        state.loadedFrom = undefined;
        return answer(0);
      }
      signals.entered();
      await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
      signals.aborted();
      await exited;
      if (loads) {
        state.loadedFrom = args[2];
      }
      // The kit rejects an aborted run once the child has closed.
      throw new Error("launchctl was stopped");
    };
    return { run, runs, state, entered, aborted, exitBootstrap: signals.exit };
  };

  const installOn = (run: Platform["process"]["run"], platform: MemoryPlatform) =>
    Effect.gen(function* () {
      return yield* (yield* Scheduler).install({ dataDir: DATA_DIR }, Effect.void);
    }).pipe(
      Effect.provide(Layer.provide(Scheduler.launchd, Layer.succeed(SnorlaxPlatform, memoryKitPlatform(platform, run))))
    );

  it("waits for the stopped bootstrap to exit, then boots out the service it loaded and removes the plist", async () => {
    const launchctl = launchctlOutlivingAbort(true);
    const platform = memoryPlatform({ SNORLAX_LAUNCHCTL: LAUNCHCTL });
    const fiber = Effect.runFork(installOn(launchctl.run, platform));
    await launchctl.entered;
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    await launchctl.aborted;
    // The service loads only as the child exits, so a run that read launchd before the exit would see nothing loaded.
    launchctl.exitBootstrap();
    await interrupted;

    expect(launchctl.runs).toEqual([
      ["print", target],
      ["bootstrap", domain, PLIST],
      ["print", target],
      ["bootout", target]
    ]);
    expect(launchctl.state.loadedFrom).toBeUndefined();
    expect(await platform.fs.stat(PLIST)).toBeUndefined();
  });

  it("stops waiting for a bootstrap that never exits once the Effect clock passes the limit", async () => {
    const launchctl = launchctlOutlivingAbort(false);
    const platform = memoryPlatform({ SNORLAX_LAUNCHCTL: LAUNCHCTL });
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(installOn(launchctl.run, platform));
        yield* Effect.promise(() => launchctl.entered);
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber));
        // The child has been stopped, so the run now waits for it on the test clock.
        yield* Effect.promise(() => launchctl.aborted);
        yield* TestClock.adjust(Duration.seconds(5));
        yield* Fiber.join(interrupting);
      }).pipe(Effect.provide(TestClock.layer()))
    );

    expect(launchctl.runs).toEqual([
      ["print", target],
      ["bootstrap", domain, PLIST],
      ["print", target]
    ]);
    expect(await platform.fs.stat(PLIST)).toBeUndefined();
  });
});

describe("launchd inspect", () => {
  const APP_PLIST =
    "/Applications/Snorlax.app/Contents/Library/LaunchAgents/io.github.perfectpan.snorlax.refresh.plist";
  const target = `gui/${process.getuid?.()}/io.github.perfectpan.snorlax.refresh`;
  const printing = (path: string | undefined) => ({
    code: 0,
    stdout: `${target} = {\n${path === undefined ? "" : `\tpath = ${path}\n`}}\n`
  });

  /** Runs `inspect` over the memory platform and returns it with every launchctl argv it ran. */
  const inspectOn = async (
    files: Record<string, string>,
    print: { readonly code: number; readonly stdout?: string } | undefined
  ): Promise<{ inspection: JobInspection; runs: (readonly string[])[] }> => {
    const runs: (readonly string[])[] = [];
    const platform = createMemoryPlatform({
      home: HOME,
      env: { SNORLAX_HOME: DATA_DIR, SNORLAX_LAUNCHCTL: LAUNCHCTL },
      os: "darwin",
      files,
      // Without a script the stub path does not exist, so launchctl fails to start.
      commands:
        print === undefined
          ? {}
          : {
              [LAUNCHCTL]: (args) => {
                runs.push(args);
                return print;
              }
            }
    });
    const inspection = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Scheduler).inspect;
      }).pipe(
        Effect.provide(Layer.provide(Scheduler.launchd, Layer.succeed(SnorlaxPlatform, memoryKitPlatform(platform))))
      )
    );
    return { inspection, runs };
  };

  const plistFor = (nodePath: string) => ({
    [PLIST]: renderLaunchAgentPlist({ nodePath, cliPath: "/opt/snorlax/snorlax.mjs", dataDir: DATA_DIR })
  });

  it("reads the CLI's plist and its Node path, and runs only launchctl print", async () => {
    const { inspection, runs } = await inspectOn(plistFor("/opt/node & co/bin/node"), printing(PLIST));
    expect(inspection).toEqual({
      kind: "inspected",
      scheduler: "launchd",
      cliJob: { file: PLIST, nodePath: "/opt/node & co/bin/node" },
      loaded: { from: "cli", file: PLIST }
    });
    expect(runs).toEqual([["print", target]]);
  });

  it("names the app as the source of a job loaded from another plist", async () => {
    const { inspection } = await inspectOn({}, printing(APP_PLIST));
    expect(inspection).toEqual({
      kind: "inspected",
      scheduler: "launchd",
      cliJob: undefined,
      loaded: { from: "app", file: APP_PLIST }
    });
  });

  it("reports nothing loaded when launchctl print exits non-zero", async () => {
    const { inspection } = await inspectOn({}, { code: 113 });
    expect(inspection).toEqual({
      kind: "inspected",
      scheduler: "launchd",
      cliJob: undefined,
      loaded: { from: "nothing" }
    });
  });

  it("reports an unknown source when print names no plist or launchctl cannot run", async () => {
    const unnamed = await inspectOn({}, printing(undefined));
    expect(unnamed.inspection).toEqual({
      kind: "inspected",
      scheduler: "launchd",
      cliJob: undefined,
      loaded: { from: "unknown", reason: expect.stringContaining("names no plist") }
    });
    const failed = await inspectOn({}, undefined);
    expect(failed.inspection).toEqual({
      kind: "inspected",
      scheduler: "launchd",
      cliJob: undefined,
      loaded: { from: "unknown", reason: expect.stringContaining("cannot run launchctl") }
    });
  });

  it("reads no Node path from a plist in another layout", async () => {
    const { inspection } = await inspectOn({ [PLIST]: "<plist><dict/></plist>" }, { code: 113 });
    expect(inspection).toEqual({
      kind: "inspected",
      scheduler: "launchd",
      cliJob: { file: PLIST, nodePath: undefined },
      loaded: { from: "nothing" }
    });
  });
});

describe("the system's scheduler inspect", () => {
  it("reports a system without a scheduler instead of failing", async () => {
    const inspect = (layer: Layer.Layer<Scheduler>) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* Scheduler).inspect;
        }).pipe(Effect.provide(layer))
      );
    expect(await inspect(Scheduler.unsupported("win32"))).toEqual({
      kind: "unsupported",
      reason: expect.stringContaining("win32 has none")
    });
    expect(await inspect(Scheduler.osOverrideInvalid)).toEqual({
      kind: "unsupported",
      reason: expect.stringContaining("SNORLAX_OS must be darwin, linux, or win32")
    });
  });
});

describe("an install interrupted inside systemctl enable", () => {
  const SYSTEMCTL = "/stub/systemctl";
  const UNIT_DIR = `${HOME}/.config/systemd/user`;
  const SERVICE = `${UNIT_DIR}/snorlax-refresh.service`;
  const TIMER = `${UNIT_DIR}/snorlax-refresh.timer`;
  const SHOW_UNIT_PATH = ["--user", "show", "--property=UnitPath", "--no-pager"];
  const SHOW = [
    "--user",
    "show",
    "snorlax-refresh.timer",
    "--property=LoadState",
    "--property=UnitFileState",
    "--property=ActiveState",
    "--property=FragmentPath",
    "--no-pager"
  ];
  const RELOAD = ["--user", "daemon-reload"];
  const ENABLE = ["--user", "enable", "--now", "snorlax-refresh.timer"];
  const DISABLE = ["--user", "disable", "--now", "snorlax-refresh.timer"];
  const UNIT_PATH_STDOUT = `UnitPath=${HOME}/.config/systemd/user.control ${HOME}/.config/systemd/user /etc/systemd/user ${HOME}/.local/share/systemd/user /usr/lib/systemd/user\n`;

  const showOf = (fragment: string): string =>
    fragment === ""
      ? "LoadState=not-found\nUnitFileState=\nActiveState=inactive\nFragmentPath=\n"
      : `LoadState=loaded\nUnitFileState=enabled\nActiveState=active\nFragmentPath=${fragment}\n`;

  /**
   * A systemctl that behaves like a real child: a stopped `enable` does not end at the abort but exits only once
   * `exitEnable` is called, having enabled the timer when `loads` is true. `show` and `disable` answer from that
   * state, and every argv is recorded in `runs`.
   */
  const systemctlOutlivingAbort = (loads: boolean) => {
    const runs: (readonly string[])[] = [];
    const state: { fragment: string } = { fragment: "" };
    const signals = { entered: () => {}, aborted: () => {}, exit: () => {} };
    const entered = new Promise<void>((resolve) => {
      signals.entered = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      signals.aborted = resolve;
    });
    const exited = new Promise<void>((resolve) => {
      signals.exit = resolve;
    });
    const answer = (stdout: string) => ({ code: 0, signal: null, stdout, stderr: "", timedOut: false });
    const run: Platform["process"]["run"] = async (_command, args, options) => {
      runs.push(args);
      if (args[1] === "show" && args[2] === "--property=UnitPath") {
        return answer(UNIT_PATH_STDOUT);
      }
      if (args[1] === "show") {
        return answer(showOf(state.fragment));
      }
      if (args[1] === "daemon-reload" || args[1] === "disable") {
        if (args[1] === "disable") {
          state.fragment = "";
        }
        return answer("");
      }
      if (args[1] !== "enable") {
        return answer("");
      }
      signals.entered();
      await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
      signals.aborted();
      await exited;
      if (loads) {
        state.fragment = TIMER;
      }
      // The kit rejects an aborted run once the child has closed.
      throw new Error("systemctl was stopped");
    };
    return { run, runs, entered, aborted, exitEnable: signals.exit };
  };

  const installOn = (run: Platform["process"]["run"], platform: MemoryPlatform) =>
    Effect.gen(function* () {
      return yield* (yield* Scheduler).install({ dataDir: DATA_DIR }, Effect.void);
    }).pipe(
      Effect.provide(Layer.provide(Scheduler.systemd, Layer.succeed(SnorlaxPlatform, memoryKitPlatform(platform, run))))
    );

  const platformFor = (): MemoryPlatform =>
    createMemoryPlatform({
      home: HOME,
      env: { SNORLAX_HOME: DATA_DIR, SNORLAX_SYSTEMCTL: SYSTEMCTL },
      os: "linux"
    });

  it("waits for the stopped enable to exit, then disables the timer it loaded and removes the units", async () => {
    const systemctl = systemctlOutlivingAbort(true);
    const platform = platformFor();
    const fiber = Effect.runFork(installOn(systemctl.run, platform));
    await systemctl.entered;
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    await systemctl.aborted;
    // The timer loads only as the child exits, so a run that read systemd before the exit would see nothing loaded.
    systemctl.exitEnable();
    await interrupted;

    expect(systemctl.runs).toEqual([SHOW_UNIT_PATH, SHOW, RELOAD, ENABLE, SHOW, DISABLE, RELOAD]);
    expect(await platform.fs.stat(SERVICE)).toBeUndefined();
    expect(await platform.fs.stat(TIMER)).toBeUndefined();
  });

  it("stops waiting for an enable that never exits once the Effect clock passes the limit", async () => {
    const systemctl = systemctlOutlivingAbort(false);
    const platform = platformFor();
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(installOn(systemctl.run, platform));
        yield* Effect.promise(() => systemctl.entered);
        const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber));
        // The child has been stopped, so the run now waits for it on the test clock.
        yield* Effect.promise(() => systemctl.aborted);
        yield* TestClock.adjust(Duration.seconds(5));
        yield* Fiber.join(interrupting);
      }).pipe(Effect.provide(TestClock.layer()))
    );

    expect(systemctl.runs).toEqual([SHOW_UNIT_PATH, SHOW, RELOAD, ENABLE, SHOW, RELOAD]);
    expect(await platform.fs.stat(SERVICE)).toBeUndefined();
    expect(await platform.fs.stat(TIMER)).toBeUndefined();
  });

  it("disables the timer when enable fails and the cleanup show fails", async () => {
    const runs: (readonly string[])[] = [];
    let enabled = false;
    const platform = platformFor();
    const run: Platform["process"]["run"] = async (_command, args) => {
      runs.push(args);
      const refused = (stderr: string) => ({ code: 1, signal: null, stdout: "", stderr, timedOut: false });
      const ok = (stdout: string) => ({ code: 0, signal: null, stdout, stderr: "", timedOut: false });
      if (args[1] === "show" && args[2] === "--property=UnitPath") {
        return ok(UNIT_PATH_STDOUT);
      }
      if (args[1] === "show") {
        return enabled ? refused("show refused") : ok(showOf(""));
      }
      if (args[1] === "daemon-reload") {
        return ok("");
      }
      if (args[1] === "enable") {
        enabled = true;
        return refused("enable refused");
      }
      if (args[1] === "disable") {
        enabled = false;
        return ok("");
      }
      return refused("unexpected");
    };
    await expect(Effect.runPromise(installOn(run, platform))).rejects.toThrow(/enable --now/);
    expect(runs).toEqual([SHOW_UNIT_PATH, SHOW, RELOAD, ENABLE, SHOW, DISABLE, RELOAD]);
    expect(await platform.fs.stat(SERVICE)).toBeUndefined();
    expect(await platform.fs.stat(TIMER)).toBeUndefined();
  });
});

describe("systemd inspect", () => {
  const SYSTEMCTL = "/stub/systemctl";
  const SERVICE = `${HOME}/.config/systemd/user/snorlax-refresh.service`;
  const TIMER = `${HOME}/.config/systemd/user/snorlax-refresh.timer`;
  const SHOW_UNIT_PATH = ["--user", "show", "--property=UnitPath", "--no-pager"];
  const UNIT_PATH_STDOUT = `UnitPath=${HOME}/.config/systemd/user.control ${HOME}/.config/systemd/user /etc/systemd/user ${HOME}/.local/share/systemd/user /usr/lib/systemd/user\n`;
  const SHOW = [
    "--user",
    "show",
    "snorlax-refresh.timer",
    "--property=LoadState",
    "--property=UnitFileState",
    "--property=ActiveState",
    "--property=FragmentPath",
    "--no-pager"
  ];
  const serviceFor = (nodePath: string): string =>
    renderRefreshService({ nodePath, cliPath: "/opt/snorlax/snorlax.mjs", snorlaxHome: DATA_DIR });
  const active = (fragment: string): string =>
    `LoadState=loaded\nUnitFileState=enabled\nActiveState=active\nFragmentPath=${fragment}\n`;

  /** Runs `inspect` over the memory platform and returns it with every systemctl argv it ran. */
  const inspectOn = async (
    files: Record<string, string>,
    stdout: string | undefined,
    unitPath?: { readonly code: number; readonly stdout: string }
  ): Promise<{ inspection: JobInspection; runs: (readonly string[])[] }> => {
    const runs: (readonly string[])[] = [];
    const platform = createMemoryPlatform({
      home: HOME,
      env: { SNORLAX_HOME: DATA_DIR, SNORLAX_SYSTEMCTL: SYSTEMCTL },
      os: "linux",
      files,
      // Without a script the stub path does not exist, so systemctl fails to start.
      commands:
        stdout === undefined && unitPath === undefined
          ? {}
          : {
              [SYSTEMCTL]: (args) => {
                runs.push(args);
                if (args[1] === "show" && args[2] === "--property=UnitPath") {
                  return { code: unitPath?.code ?? 0, stdout: unitPath?.stdout ?? UNIT_PATH_STDOUT };
                }
                return { code: 0, stdout: stdout ?? "" };
              }
            }
    });
    const inspection = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* Scheduler).inspect;
      }).pipe(
        Effect.provide(Layer.provide(Scheduler.systemd, Layer.succeed(SnorlaxPlatform, memoryKitPlatform(platform))))
      )
    );
    return { inspection, runs };
  };

  it("reads the service Node path and reports the timer as the CLI's when it is enabled and active", async () => {
    const { inspection, runs } = await inspectOn({ [SERVICE]: serviceFor("/opt/node home/bin/node") }, active(TIMER));
    expect(inspection).toEqual({
      kind: "inspected",
      scheduler: "systemd",
      cliJob: { file: SERVICE, nodePath: "/opt/node home/bin/node" },
      loaded: { from: "cli", file: TIMER }
    });
    expect(runs).toEqual([SHOW_UNIT_PATH, SHOW]);
  });

  it("reports nothing when the unit is missing, and unknown for a fragment this install did not write", async () => {
    const missing = await inspectOn({}, "LoadState=not-found\nUnitFileState=\nActiveState=inactive\nFragmentPath=\n");
    expect(missing.inspection).toEqual({
      kind: "inspected",
      scheduler: "systemd",
      cliJob: undefined,
      loaded: { from: "nothing" }
    });
    const foreign = await inspectOn({}, active("/etc/systemd/user/snorlax-refresh.timer"));
    expect(foreign.inspection).toEqual({
      kind: "inspected",
      scheduler: "systemd",
      cliJob: undefined,
      loaded: { from: "unknown", reason: expect.stringContaining("/etc/systemd/user/snorlax-refresh.timer") }
    });
  });

  it("reports nothing when our timer is not both enabled and active", async () => {
    const { inspection } = await inspectOn(
      { [SERVICE]: serviceFor("/usr/bin/node") },
      `LoadState=loaded\nUnitFileState=disabled\nActiveState=inactive\nFragmentPath=${TIMER}\n`
    );
    expect(inspection).toEqual({
      kind: "inspected",
      scheduler: "systemd",
      cliJob: { file: SERVICE, nodePath: "/usr/bin/node" },
      loaded: { from: "nothing" }
    });
  });

  it("returns no cli job when the UnitPath query exits non-zero or does not parse", async () => {
    const planted = { [SERVICE]: serviceFor("/usr/bin/node") };
    const failed = await inspectOn(planted, undefined, { code: 1, stdout: "" });
    expect(failed.inspection).toEqual({
      kind: "inspected",
      scheduler: "systemd",
      cliJob: undefined,
      loaded: { from: "unknown", reason: expect.stringContaining("UnitPath") }
    });
    expect(failed.runs).toEqual([SHOW_UNIT_PATH]);
    const garbled = await inspectOn(planted, undefined, { code: 0, stdout: "not a property\n" });
    expect(garbled.inspection).toEqual({
      kind: "inspected",
      scheduler: "systemd",
      cliJob: undefined,
      loaded: { from: "unknown", reason: expect.stringContaining("did not report a path list") }
    });
    expect(garbled.runs).toEqual([SHOW_UNIT_PATH]);
  });

  it("reports an unknown source when systemctl cannot run or its report does not parse", async () => {
    const failed = await inspectOn({}, undefined);
    expect(failed.inspection).toEqual({
      kind: "inspected",
      scheduler: "systemd",
      cliJob: undefined,
      loaded: { from: "unknown", reason: expect.stringContaining("cannot run systemctl") }
    });
    const garbled = await inspectOn({}, "LoadState=loaded\n");
    expect(garbled.inspection).toEqual({
      kind: "inspected",
      scheduler: "systemd",
      cliJob: undefined,
      loaded: { from: "unknown", reason: expect.stringContaining("did not report") }
    });
  });
});
