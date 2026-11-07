import process from "node:process";

import type { Platform } from "@rivus/agent-kit/platform";
import { createMemoryPlatform } from "@rivus/agent-kit/testing";
import { Duration, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";

import { renderLaunchAgentPlist } from "./plist.ts";
import { renderRefreshService } from "./units.ts";
import { Scheduler, type JobInspection } from "./scheduler.ts";
import { SnorlaxPlatform } from "../../modules/platform/platform.ts";
import { memoryKitPlatform } from "../../../test/fixtures/platform.ts";

/**
 * The scheduler capability in process, on the agent-kit memory platform: the launchd and systemd
 * implementations' cleanup when an install is interrupted inside `launchctl bootstrap` or
 * `systemctl enable`, and what `inspect` reads from the job files and from launchctl and systemctl.
 * What the install and uninstall commands hand the scheduler and print, the `SNORLAX_OS` override and
 * launchd itself through a `launchctl` stub are covered in `test/`: `cli/bin.ts` picks the system's
 * scheduler, so those tests run the built bundle.
 */

const HOME = "/testroot/tester";
const DATA_DIR = `${HOME}/snorlax-data`;
const LAUNCHCTL = "/stub/launchctl";
const PLIST = `${HOME}/Library/LaunchAgents/io.github.perfectpan.snorlax.refresh.plist`;

type MemoryPlatform = ReturnType<typeof createMemoryPlatform>;

describe("an install interrupted inside launchctl bootstrap", () => {
  const domain = `gui/${process.getuid?.()}`;
  const target = `${domain}/io.github.perfectpan.snorlax.refresh`;

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
    const platform = createMemoryPlatform({
      home: HOME,
      env: { SNORLAX_HOME: DATA_DIR, SNORLAX_LAUNCHCTL: LAUNCHCTL },
      os: "darwin"
    });
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
    const platform = createMemoryPlatform({
      home: HOME,
      env: { SNORLAX_HOME: DATA_DIR, SNORLAX_LAUNCHCTL: LAUNCHCTL },
      os: "darwin"
    });
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
