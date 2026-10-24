import { createMemoryPlatform } from "@rivus/agent-kit/testing";
import { failureSchema } from "@rivus/snorlax-protocol";
import { Effect, Fiber, Layer } from "effect";
import * as z from "zod/mini";
import { describe, expect, it } from "vite-plus/test";

import { Scheduler } from "../src/capabilities/scheduler/scheduler.ts";
import { CliEnv } from "../src/cli/env.ts";
import { runCli } from "../src/cli/run.ts";
import { NodeFiles, SnorlaxPlatform, type NodeFileOps } from "../src/modules/platform/platform.ts";
import { memoryKitPlatform } from "./fixtures/platform.ts";
import { fakeScheduler, type SchedulerCall } from "./fixtures/scheduler.ts";

/**
 * The scheduler capability in process, on the agent-kit memory platform: `install` and `uninstall` over the
 * fake scheduler (what the commands hand the scheduler and print), the system's scheduler selection, and the
 * launchd implementation's cleanup when a run is interrupted. The bundle tests in `install-uninstall.test.ts`
 * cover launchd itself through a `launchctl` stub.
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

const runCommand = async (
  args: readonly string[],
  platform: MemoryPlatform,
  scheduler: Layer.Layer<Scheduler, never, SnorlaxPlatform>
) => {
  const out: string[] = [];
  const err: string[] = [];
  const platformLayer = Layer.succeed(SnorlaxPlatform, memoryKitPlatform(platform));
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
    const calls: SchedulerCall[] = [];
    const platform = memoryPlatform(
      {},
      { [`${DATA_DIR}/config.json`]: "{}", [`${DATA_DIR}/logs/snorlax.log`]: "", [`${DATA_DIR}/notes.txt`]: "mine" }
    );
    const kept = await runCommand(["uninstall", "--data"], platform, fakeScheduler(calls, { jobFile: JOB_FILE }));
    expect(kept).toEqual({
      exitCode: 0,
      stdout:
        "LaunchAgent removed\nthe data directory ~/snorlax-data is kept; entries snorlax did not write remain: notes.txt\n",
      stderr: ""
    });
    expect(calls).toEqual([{ operation: "uninstall", dataDir: DATA_DIR }]);
    expect(await platform.fs.stat(`${DATA_DIR}/config.json`)).toBeUndefined();
    expect(await platform.fs.stat(`${DATA_DIR}/logs`)).toBeUndefined();

    await platform.fs.remove(`${DATA_DIR}/notes.txt`);
    const deleted = await runCommand(["uninstall", "--data"], platform, fakeScheduler([], { jobFile: JOB_FILE }));
    expect(deleted.stdout).toBe("LaunchAgent removed and data directory deleted\n");
    expect(await platform.fs.stat(DATA_DIR)).toBeUndefined();
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
    const platform = memoryPlatform({ SNORLAX_OS: "bogus" });
    expect((await runCommand(["status", "--json"], platform, Scheduler.live)).exitCode).toBe(0);
    for (const command of ["install", "uninstall"]) {
      const failed = await runCommand([command, "--json"], platform, Scheduler.live);
      expect(failed.exitCode).toBe(1);
      expect(failureOf(failed.stdout)).toEqual({
        code: "internal",
        message: "SNORLAX_OS must be darwin, linux, or win32"
      });
    }
    expect(await platform.fs.stat(DATA_DIR)).toBeUndefined();
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
      env: { SNORLAX_HOME: DATA_DIR, SNORLAX_OS: "darwin", SNORLAX_LAUNCHCTL: LAUNCHCTL },
      os: "linux",
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
    }).pipe(Effect.provide(Layer.provide(Scheduler.live, Layer.succeed(SnorlaxPlatform, memoryKitPlatform(platform)))));

    const fiber = Effect.runFork(install);
    await started;
    expect(bootstrap.plistWritten).toBe(true);
    expect(bootstrap.signal?.aborted).toBe(false);

    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(bootstrap.signal?.aborted).toBe(true);
    expect(await platform.fs.stat(PLIST)).toBeUndefined();
  });
});
