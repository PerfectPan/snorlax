import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";

import type { Platform } from "@rivus/agent-kit/platform";
import { Data, Duration, Effect, type Context } from "effect";

import { errorMessage } from "../../core/error-message/error-message.ts";
import { requireAbsoluteDataDir } from "../../modules/data-dir/data-dir.ts";
import { readTextFile } from "../../modules/read-text-file/read-text-file.ts";
import type { CliJob, LoadedJob, Scheduler } from "./scheduler.ts";
import {
  parseSystemctlShow,
  parseSystemctlUnitPath,
  renderRefreshService,
  renderRefreshTimer,
  SERVICE_NAME,
  serviceNodePath,
  TIMER_NAME,
  userConfigUnitDir,
  type SystemctlShow,
  type SystemdUnitSpec
} from "./units.ts";

/**
 * The scheduler on Linux: a systemd user timer.
 *
 * Nothing else on Linux registers `snorlax-refresh.timer`, so a loaded unit whose fragment path is not
 * the CLI's own file is refused rather than replaced. The unit directory is the user configuration entry
 * under the home directory in `systemctl --user show --property=UnitPath`, the list the manager actually
 * searches. The process's `XDG_CONFIG_HOME` is not used, and a missing entry is a failure: nothing is
 * written. The service always sets `SNORLAX_HOME` to the data directory install already resolved.
 * `SNORLAX_SYSTEMCTL`, when set, is the `systemctl` binary. Tests point it at a stub so they never start
 * the real one and never enable a timer in the caller's user manager.
 */

/** The Node binary or the `snorlax.mjs` entry this process runs from has no absolute path. */
export class UnitPathsUnresolved extends Data.TaggedError("UnitPathsUnresolved")<{
  readonly message: string;
}> {}

/** `systemctl` could not be started, did not finish, or exited non-zero. */
export class SystemctlFailed extends Data.TaggedError("SystemctlFailed")<{ readonly message: string }> {}

/**
 * The loaded `snorlax-refresh.timer` does not come from the CLI's own unit file. There is no app on Linux
 * to share the name with; the other path is still not this install's to change.
 */
export class ForeignTimerLoaded extends Data.TaggedError("ForeignTimerLoaded")<{
  readonly message: string;
}> {}

/** A unit file could not be written. */
export class UnitWriteFailed extends Data.TaggedError("UnitWriteFailed")<{ readonly message: string }> {}

/** A unit file could not be removed. */
export class UnitRemoveFailed extends Data.TaggedError("UnitRemoveFailed")<{ readonly message: string }> {}

const SYSTEMCTL_TIMEOUT_MS = 15_000;
/**
 * How long an interrupted run waits for its stopped `systemctl` child to exit. The kit sends SIGKILL 2 s
 * after SIGTERM, so the child is normally gone well before this; the limit keeps a child that never exits
 * from holding the interrupted run open.
 */
const CHILD_EXIT_LIMIT = Duration.seconds(5);
const UNIT_MODE = 0o644;
const DEFAULT_SYSTEMCTL = "/usr/bin/systemctl";

const SHOW_ARGS = [
  "--user",
  "show",
  TIMER_NAME,
  "--property=LoadState",
  "--property=UnitFileState",
  "--property=ActiveState",
  "--property=FragmentPath",
  "--no-pager"
] as const;

const RELOAD_ARGS = ["--user", "daemon-reload"] as const;
const ENABLE_ARGS = ["--user", "enable", "--now", TIMER_NAME] as const;
const DISABLE_ARGS = ["--user", "disable", "--now", TIMER_NAME] as const;
const SHOW_UNIT_PATH_ARGS = ["--user", "show", "--property=UnitPath", "--no-pager"] as const;

/** `run` is the only process operation install uses. */
type SchedulerPlatform = Pick<Platform, "env" | "fs" | "home"> & {
  readonly process: Pick<Platform["process"], "run">;
};

type SystemctlResult = Awaited<ReturnType<SchedulerPlatform["process"]["run"]>>;

const systemctlBinary = (platform: Pick<Platform, "env">): string => {
  const override = platform.env.SNORLAX_SYSTEMCTL;
  if (override === undefined || override === "") {
    return DEFAULT_SYSTEMCTL;
  }
  return override;
};

/** The running Node binary and the `snorlax.mjs` entry this process was started with. */
const runningCollectorPaths: Effect.Effect<
  Pick<SystemdUnitSpec, "nodePath" | "cliPath">,
  UnitPathsUnresolved
> = Effect.suspend(() => {
  const entry = process.argv[1];
  if (entry === undefined || entry === "") {
    return Effect.fail(new UnitPathsUnresolved({ message: "cannot resolve the running snorlax CLI path" }));
  }
  const nodePath = process.execPath;
  const cliPath = resolve(entry);
  if (!isAbsolute(nodePath) || !isAbsolute(cliPath)) {
    return Effect.fail(
      new UnitPathsUnresolved({ message: "the Node and CLI paths in the systemd unit must be absolute" })
    );
  }
  return Effect.succeed({ nodePath, cliPath });
});

/**
 * An interrupted run stops the `systemctl` child and waits, up to `CHILD_EXIT_LIMIT` on the Effect clock,
 * until it has exited — the kit settles `run` only after the child has closed — so whatever the interrupted
 * run reads from systemd next is no longer changing under it.
 */
const runSystemctl = (
  platform: SchedulerPlatform,
  args: readonly string[]
): Effect.Effect<SystemctlResult, SystemctlFailed> => {
  const command = systemctlBinary(platform);
  return Effect.callback<SystemctlResult, SystemctlFailed>((resume) => {
    const controller = new AbortController();
    const running = Promise.resolve().then(() =>
      platform.process.run(command, args, { timeoutMs: SYSTEMCTL_TIMEOUT_MS, signal: controller.signal })
    );
    void running.then(
      (result) => resume(Effect.succeed(result)),
      (error: unknown) =>
        resume(
          Effect.fail(new SystemctlFailed({ message: `cannot run systemctl (${command}): ${errorMessage(error)}` }))
        )
    );
    return Effect.sync(() => controller.abort()).pipe(
      Effect.andThen(Effect.ignore(Effect.tryPromise(() => running))),
      Effect.timeoutOption(CHILD_EXIT_LIMIT),
      Effect.asVoid
    );
  }).pipe(
    Effect.flatMap((result) => {
      if (result.timedOut || result.signal !== null) {
        const reason = result.timedOut ? "timeout" : result.signal;
        return Effect.fail(
          new SystemctlFailed({ message: `systemctl ${args[1] ?? "command"} did not finish (${reason})` })
        );
      }
      return Effect.succeed(result);
    })
  );
};

const systemctlFailure = (result: SystemctlResult, action: string): SystemctlFailed => {
  const detail = (result.stderr !== "" ? result.stderr : result.stdout).trim();
  const suffix = detail === "" ? "" : `: ${detail}`;
  return new SystemctlFailed({
    message: `systemctl ${action} failed (exit ${result.code ?? "unknown"})${suffix}`
  });
};

/**
 * The manager's unit search path. A non-zero exit or a report that is not one `UnitPath=` line fails
 * instead of being replaced with this process's `XDG_CONFIG_HOME`.
 */
const showUnitPath = (platform: SchedulerPlatform): Effect.Effect<readonly string[], SystemctlFailed> =>
  Effect.flatMap(runSystemctl(platform, SHOW_UNIT_PATH_ARGS), (result) => {
    if (result.code !== 0) {
      return Effect.fail(systemctlFailure(result, "show UnitPath"));
    }
    const paths = parseSystemctlUnitPath(result.stdout);
    if (paths === undefined) {
      return Effect.fail(new SystemctlFailed({ message: "systemctl show UnitPath did not report a path list" }));
    }
    return Effect.succeed(paths);
  });

interface UnitPaths {
  readonly unitDir: string;
  readonly servicePath: string;
  readonly timerPath: string;
}

/** Where the user manager looks up this user's configuration units. Never a guessed `~/.config`. */
const resolveUnitPaths = (platform: SchedulerPlatform): Effect.Effect<UnitPaths, SystemctlFailed> =>
  Effect.flatMap(showUnitPath(platform), (paths) => {
    const unitDir = userConfigUnitDir(platform.home, paths);
    if (unitDir === undefined) {
      return Effect.fail(
        new SystemctlFailed({
          message: `systemctl show UnitPath has no user configuration directory under ${platform.home}`
        })
      );
    }
    return Effect.succeed({
      unitDir,
      servicePath: join(unitDir, SERVICE_NAME),
      timerPath: join(unitDir, TIMER_NAME)
    });
  });

/** `systemctl show` of the timer. A non-zero exit or an unexpected report fails instead of being guessed. */
const showTimer = (platform: SchedulerPlatform): Effect.Effect<SystemctlShow, SystemctlFailed> =>
  Effect.flatMap(runSystemctl(platform, SHOW_ARGS), (result) => {
    if (result.code !== 0) {
      return Effect.fail(systemctlFailure(result, "show"));
    }
    const shown = parseSystemctlShow(result.stdout);
    if (shown === undefined) {
      return Effect.fail(
        new SystemctlFailed({
          message: `systemctl show ${TIMER_NAME} did not report LoadState, UnitFileState, ActiveState and FragmentPath`
        })
      );
    }
    return Effect.succeed(shown);
  });

const reload = (platform: SchedulerPlatform): Effect.Effect<void, SystemctlFailed> =>
  Effect.flatMap(runSystemctl(platform, RELOAD_ARGS), (result) =>
    result.code === 0 ? Effect.void : Effect.fail(systemctlFailure(result, "daemon-reload"))
  );

const enable = (platform: SchedulerPlatform): Effect.Effect<void, SystemctlFailed> =>
  Effect.flatMap(runSystemctl(platform, ENABLE_ARGS), (result) =>
    result.code === 0 ? Effect.void : Effect.fail(systemctlFailure(result, "enable --now"))
  );

const disable = (platform: SchedulerPlatform): Effect.Effect<void, SystemctlFailed> =>
  Effect.flatMap(runSystemctl(platform, DISABLE_ARGS), (result) =>
    result.code === 0 ? Effect.void : Effect.fail(systemctlFailure(result, "disable --now"))
  );

/**
 * A timer systemd loaded from somewhere other than `timerPath` is not this CLI's. An empty fragment means
 * the unit is not loaded. Our own fragment is stopped with `disable --now`, which uninstall wants and which
 * a failed install wants when `enable --now` already loaded this timer. Enable is not atomic: the symlink
 * can exist before start fails.
 */
const refuseForeignTimer = (shown: SystemctlShow, timerPath: string): Effect.Effect<void, ForeignTimerLoaded> => {
  if (shown.FragmentPath === "" || shown.FragmentPath === timerPath) {
    return Effect.void;
  }
  return Effect.fail(
    new ForeignTimerLoaded({
      message:
        `refusing to change the systemd timer: ${TIMER_NAME} is loaded from ${shown.FragmentPath}, ` +
        `not ${timerPath}`
    })
  );
};

const disableIfLoadedFrom = (
  platform: SchedulerPlatform,
  timerPath: string
): Effect.Effect<void, SystemctlFailed | ForeignTimerLoaded> =>
  Effect.gen(function* () {
    const shown = yield* showTimer(platform);
    yield* refuseForeignTimer(shown, timerPath);
    if (shown.FragmentPath === timerPath) {
      yield* disable(platform);
    }
  });

/**
 * Cleanup after a failed enable. Ownership was confirmed before the units were written, so a `show` that
 * fails — a 15 s timeout usually means the manager is stuck, and this `show` will time out too — still runs
 * `disable --now`. A `show` that succeeds disables only when this file is the loaded fragment.
 */
const disableForCleanup = (platform: SchedulerPlatform, timerPath: string): Effect.Effect<void, SystemctlFailed> =>
  showTimer(platform).pipe(
    Effect.matchEffect({
      onFailure: () => disable(platform),
      onSuccess: (shown) => (shown.FragmentPath === timerPath ? disable(platform) : Effect.void)
    })
  );

const removeUnitFiles = (
  platform: SchedulerPlatform,
  paths: readonly string[]
): Effect.Effect<void, UnitRemoveFailed> =>
  Effect.tryPromise({
    try: async () => {
      for (const path of paths) {
        await platform.fs.remove(path);
      }
    },
    catch: (error) => new UnitRemoveFailed({ message: `cannot remove the systemd units: ${errorMessage(error)}` })
  });

/** The CLI's service unit and the Node binary it names; undefined when there is no service file. */
const readCliJob = (platform: SchedulerPlatform, servicePath: string): Effect.Effect<CliJob | undefined> =>
  Effect.promise(() =>
    readTextFile(platform, servicePath).then(
      (text) => (text === undefined ? undefined : { file: servicePath, nodePath: serviceNodePath(text) }),
      // A service file that exists but cannot be read names no Node binary snorlax can check.
      () => ({ file: servicePath, nodePath: undefined })
    )
  );

/**
 * Where the loaded timer comes from. Not loaded is `nothing`. Our timer, enabled and active, is `cli`.
 * Any other fragment path is `unknown`: Linux has no app registering this unit, and a path the CLI did not
 * write is not reported as one. A show that cannot run is an unknown source too.
 */
const loadedJob = (platform: SchedulerPlatform, timerPath: string): Effect.Effect<LoadedJob> =>
  showTimer(platform).pipe(
    Effect.map((shown): LoadedJob => {
      if (shown.LoadState === "not-found" || shown.FragmentPath === "") {
        return { from: "nothing" };
      }
      if (shown.FragmentPath !== timerPath) {
        return {
          from: "unknown",
          reason: `systemctl show reports ${TIMER_NAME} loaded from ${shown.FragmentPath}, not ${timerPath}`
        };
      }
      if (shown.UnitFileState === "enabled" && shown.ActiveState === "active") {
        return { from: "cli", file: timerPath };
      }
      return { from: "nothing" };
    }),
    Effect.catch((error) => Effect.succeed({ from: "unknown", reason: error.message } as const))
  );

/** The systemd implementation of the scheduler capability over `platform`. */
export const systemdScheduler = (platform: SchedulerPlatform): Context.Service.Shape<typeof Scheduler> => ({
  install: (job, prepare) =>
    Effect.gen(function* () {
      yield* requireAbsoluteDataDir(job.dataDir);
      const paths = yield* resolveUnitPaths(platform);
      // Ownership comes before any write: a timer loaded from another file is never replaced.
      const shown = yield* showTimer(platform);
      yield* refuseForeignTimer(shown, paths.timerPath);
      yield* prepare;
      // `job.dataDir` is the directory this install resolved. The timer must use that path, not look it up
      // again: the user manager does not inherit `XDG_DATA_HOME` from a shell rc.
      const service = renderRefreshService({
        ...(yield* runningCollectorPaths),
        snorlaxHome: job.dataDir
      });
      const timer = renderRefreshTimer();
      yield* Effect.tryPromise({
        try: async () => {
          await platform.fs.mkdir(paths.unitDir);
          await platform.fs.writeAtomic(paths.servicePath, service, { mode: UNIT_MODE });
          try {
            await platform.fs.writeAtomic(paths.timerPath, timer, { mode: UNIT_MODE });
          } catch (error) {
            await platform.fs.remove(paths.servicePath);
            throw error;
          }
        },
        catch: (error) => new UnitWriteFailed({ message: `cannot write ${paths.unitDir}: ${errorMessage(error)}` })
      });
      // `enable --now` is idempotent, so a repeat install rewrites the units, reloads and enables again.
      // It is not atomic: enable can install the symlink before start fails or the 15 s limit fires.
      // Any failed or interrupted enable therefore disables the timer when this file is the one loaded,
      // and still disables when that check cannot run, then deletes the unit files and reloads. An
      // interrupt has already waited, inside runSystemctl, for the child to exit before this cleanup
      // reads systemd. The cleanup's own failures are dropped: the command reports the enable failure
      // or the interruption, not the cleanup.
      yield* reload(platform).pipe(
        Effect.andThen(enable(platform)),
        Effect.onError(() =>
          Effect.andThen(
            Effect.ignore(disableForCleanup(platform, paths.timerPath)),
            Effect.andThen(
              Effect.ignore(removeUnitFiles(platform, [paths.servicePath, paths.timerPath])),
              Effect.ignore(reload(platform))
            )
          )
        )
      );
      return paths.timerPath;
    }),
  uninstall: (job, guard) =>
    Effect.gen(function* () {
      yield* requireAbsoluteDataDir(job.dataDir);
      // The caller's guard runs before anything changes: a refused `--data` must not have already disabled
      // the timer and removed its units.
      const guarded = yield* guard;
      const paths = yield* resolveUnitPaths(platform);
      yield* disableIfLoadedFrom(platform, paths.timerPath);
      yield* removeUnitFiles(platform, [paths.servicePath, paths.timerPath]);
      yield* reload(platform);
      return guarded;
    }),
  inspect: Effect.gen(function* () {
    // A UnitPath we cannot read does not fall back to `~/.config` or this process's `XDG_CONFIG_HOME`:
    // that would inspect a directory the manager is not using.
    const located = yield* resolveUnitPaths(platform).pipe(
      Effect.map((paths) => ({ located: true, paths }) as const),
      Effect.catch((error) => Effect.succeed({ located: false, reason: error.message } as const))
    );
    if (!located.located) {
      return {
        kind: "inspected" as const,
        scheduler: "systemd" as const,
        cliJob: undefined,
        loaded: { from: "unknown" as const, reason: located.reason }
      };
    }
    return {
      kind: "inspected" as const,
      scheduler: "systemd" as const,
      cliJob: yield* readCliJob(platform, located.paths.servicePath),
      loaded: yield* loadedJob(platform, located.paths.timerPath)
    };
  })
});
