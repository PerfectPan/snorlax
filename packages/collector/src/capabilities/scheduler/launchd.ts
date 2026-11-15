import { join } from "node:path";

import type { Platform } from "@rivus/agent-kit/platform";
import { Cause, Data, Effect, type Context } from "effect";

import { errorMessage } from "../../core/error-message/error-message.ts";
import { runSchedulerCommand, schedulerCommandFailure, runningCliPath, type SchedulerPlatform, UNIT_FILE_MODE } from "./command.ts";
import { LAUNCH_AGENT_LABEL, launchAgentLauncherPath, launchAgentPlistPath, renderLaunchAgentPlist } from "./plist.ts";
import { renderRefreshLauncher, writeLauncherFiles } from "./launcher.ts";
import type { CliJob, LoadedJob, Scheduler } from "./scheduler.ts";
import { requireAbsoluteDataDir, type DataDirNotAbsolute } from "../../modules/data-dir/data-dir.ts";
import { readTextFile } from "../../modules/read-text-file/read-text-file.ts";

/**
 * The scheduler on macOS: a LaunchAgent in `~/Library/LaunchAgents`.
 *
 * The app's Launch at login (`SMAppService`) and this LaunchAgent share one launchd label and are
 * mutually exclusive. Before any change, `launchctl print` must name the loaded service's `path`, and the
 * CLI refuses — touching no file — unless that path is its own `~/Library/LaunchAgents` plist.
 *
 * `SNORLAX_LAUNCHCTL`, when set, is the `launchctl` binary. Tests point it at a stub so they never
 * start the real one and never bootstrap into the caller's gui domain.
 */

/** The Node binary or the `snorlax.mjs` entry this process runs from has no absolute path. */
export class CollectorPathUnresolved extends Data.TaggedError("CollectorPathUnresolved")<{
  readonly message: string;
}> {}

/** The process has no numeric user id, so the launchd gui domain cannot be named. */
export class UserIdUnavailable extends Data.TaggedError("UserIdUnavailable")<{ readonly message: string }> {}

/** `launchctl` could not be started, did not finish, or exited non-zero. */
export class LaunchctlFailed extends Data.TaggedError("LaunchctlFailed")<{ readonly message: string }> {}

type LaunchctlResult = Awaited<ReturnType<SchedulerPlatform["process"]["run"]>>;

/**
 * The loaded service with this label is not provably loaded from the CLI's own plist: Snorlax.app's Launch
 * at login owns it, or `launchctl print` names no plist.
 */
export class ForeignServiceLoaded extends Data.TaggedError("ForeignServiceLoaded")<{ readonly message: string }> {}

/** The LaunchAgent plist could not be written. */
export class PlistWriteFailed extends Data.TaggedError("PlistWriteFailed")<{ readonly message: string }> {}

/** The LaunchAgent plist could not be removed. */
export class PlistRemoveFailed extends Data.TaggedError("PlistRemoveFailed")<{ readonly message: string }> {}

const DEFAULT_LAUNCHCTL = "/bin/launchctl";

const launchctlBinary = (platform: Pick<Platform, "env">): string => {
  const override = platform.env.SNORLAX_LAUNCHCTL;
  if (override === undefined || override === "") {
    return DEFAULT_LAUNCHCTL;
  }
  return override;
};

const launchctlFailed = (message: string): LaunchctlFailed => new LaunchctlFailed({ message });

const currentUid: Effect.Effect<number, UserIdUnavailable> = Effect.suspend(() => {
  const uid = process.getuid?.();
  return uid === undefined
    ? Effect.fail(new UserIdUnavailable({ message: "launchd install needs a numeric user id" }))
    : Effect.succeed(uid);
});

const guiDomain = (uid: number): string => `gui/${uid}`;

const runLaunchctl = (
  platform: SchedulerPlatform,
  args: readonly string[]
): Effect.Effect<LaunchctlResult, LaunchctlFailed> =>
  runSchedulerCommand(platform, {
    program: launchctlBinary(platform),
    name: "launchctl",
    args,
    fail: launchctlFailed
  });

const launchctlFailure = (result: LaunchctlResult, action: string): LaunchctlFailed =>
  schedulerCommandFailure(result, { name: "launchctl", action, fail: launchctlFailed });

/**
 * The launchd target install and uninstall share: the data directory checked absolute, then this user's
 * gui-domain label target.
 */
const ownTarget = (
  dataDir: string
): Effect.Effect<{ readonly domain: string; readonly target: string }, DataDirNotAbsolute | UserIdUnavailable> =>
  Effect.gen(function* () {
    yield* requireAbsoluteDataDir(dataDir);
    const domain = guiDomain(yield* currentUid);
    return { domain, target: `${domain}/${LAUNCH_AGENT_LABEL}` };
  });

/**
 * One `launchctl print` outcome for this label: `loaded` carries the plist the loaded service was started
 * from, `unknown` means launchd names no `path` line, so the owner cannot be confirmed.
 */
type LoadedService =
  | { readonly state: "not-loaded" }
  | { readonly state: "loaded"; readonly path: string }
  | { readonly state: "unknown" };

/** The `path = …` line `launchctl print` prints for a service loaded from a plist. */
const SERVICE_PATH_LINE = /^[\t ]*path[\t ]*=[\t ]*(\S.*?)\s*$/;
/** A line ending in `{` opens a nested block; a lone `}` closes one. */
const OPEN_BLOCK = /[{]\s*$/;
const CLOSE_BLOCK = /^[\t ]*}[ ;]*$/;

/**
 * `launchctl print` exits non-zero when the service is not loaded. A spawn failure fails instead. The
 * `path` line only counts in the service's own dictionary (depth 1), never in a nested block that
 * happens to print first.
 */
const loadedService = (platform: SchedulerPlatform, target: string): Effect.Effect<LoadedService, LaunchctlFailed> =>
  Effect.map(runLaunchctl(platform, ["print", target]), (result): LoadedService => {
    if (result.code !== 0) {
      return { state: "not-loaded" };
    }
    let depth = 0;
    for (const line of result.stdout.split("\n")) {
      if (depth === 1) {
        const match = SERVICE_PATH_LINE.exec(line);
        if (match?.[1] !== undefined) {
          return { state: "loaded", path: match[1] };
        }
      }
      if (OPEN_BLOCK.test(line)) {
        depth += 1;
      } else if (CLOSE_BLOCK.test(line)) {
        depth -= 1;
      }
    }
    return { state: "unknown" };
  });

/**
 * The app's `SMAppService` agent and the CLI's LaunchAgent are mutually exclusive: launchd
 * holds one label, and two same-label plists would fight over the load at every login. The CLI therefore
 * changes nothing — not its own plist, not the data directory — unless the loaded service provably comes
 * from its own `~/Library/LaunchAgents` plist.
 */
const refuseForeignService = (
  loaded: LoadedService,
  plistPath: string,
  target: string
): Effect.Effect<void, ForeignServiceLoaded> => {
  if (loaded.state === "not-loaded" || (loaded.state === "loaded" && loaded.path === plistPath)) {
    return Effect.void;
  }
  const detail =
    loaded.state === "loaded"
      ? `${LAUNCH_AGENT_LABEL} is already registered by Snorlax.app's Launch at login (${loaded.path}); ` +
        "turn Launch at login off in Snorlax's Settings first"
      : `launchctl print names no plist for the loaded ${LAUNCH_AGENT_LABEL} agent, so its owner cannot be ` +
        `confirmed; check Launch at login in Snorlax's Settings and turn it off, or inspect the service ` +
        `with \`launchctl print ${target}\``;
  return Effect.fail(new ForeignServiceLoaded({ message: `refusing to change the LaunchAgent: ${detail}` }));
};

/** The ownership check install and uninstall share: the loaded service must be the CLI's own, or the effect
 * fails and nothing changes.
 */
const ownLoadedService = (
  platform: SchedulerPlatform,
  plistPath: string,
  target: string
): Effect.Effect<LoadedService, LaunchctlFailed | ForeignServiceLoaded> =>
  Effect.gen(function* () {
    const loaded = yield* loadedService(platform, target);
    yield* refuseForeignService(loaded, plistPath, target);
    return loaded;
  });

const bootout = (platform: SchedulerPlatform, target: string): Effect.Effect<void, LaunchctlFailed> =>
  Effect.flatMap(runLaunchctl(platform, ["bootout", target]), (result) =>
    result.code === 0 ? Effect.void : Effect.fail(launchctlFailure(result, "bootout"))
  );

/** Boots out the service when launchd runs it from `plistPath`. */
const bootoutIfLoadedFrom = (
  platform: SchedulerPlatform,
  target: string,
  plistPath: string
): Effect.Effect<void, LaunchctlFailed> =>
  Effect.flatMap(loadedService(platform, target), (loaded) =>
    loaded.state === "loaded" && loaded.path === plistPath ? bootout(platform, target) : Effect.void
  );

const bootstrap = (
  platform: SchedulerPlatform,
  domain: string,
  plistPath: string
): Effect.Effect<void, LaunchctlFailed> =>
  Effect.flatMap(runLaunchctl(platform, ["bootstrap", domain, plistPath]), (result) =>
    result.code === 0 ? Effect.void : Effect.fail(launchctlFailure(result, "bootstrap"))
  );

const snorlaxHomeOverride = (platform: Pick<Platform, "env">): string | undefined => {
  const value = platform.env.SNORLAX_HOME;
  if (value === undefined || value === "") {
    return undefined;
  }
  return value;
};

/** The CLI's plist and the launcher script it runs; undefined when there is no plist. */
const readCliJob = (platform: SchedulerPlatform, plistPath: string): Effect.Effect<CliJob | undefined> =>
  Effect.promise(() =>
    readTextFile(platform, plistPath).then(
      (xml) => (xml === undefined ? undefined : { file: plistPath, launcher: launchAgentLauncherPath(xml) }),
      // A plist that exists but cannot be read names no launcher script snorlax can check.
      () => ({ file: plistPath, launcher: undefined })
    )
  );

/** `launchctl print` read as where the loaded job comes from; a print that cannot run is an unknown source. */
const loadedJob = (platform: SchedulerPlatform, plistPath: string): Effect.Effect<LoadedJob> =>
  Effect.gen(function* () {
    const target = `${guiDomain(yield* currentUid)}/${LAUNCH_AGENT_LABEL}`;
    const loaded = yield* loadedService(platform, target);
    if (loaded.state === "not-loaded") {
      return { from: "nothing" } as const;
    }
    if (loaded.state === "unknown") {
      return { from: "unknown", reason: `\`launchctl print ${target}\` names no plist for the loaded job` } as const;
    }
    return loaded.path === plistPath
      ? ({ from: "cli", file: loaded.path } as const)
      : ({ from: "app", file: loaded.path } as const);
  }).pipe(Effect.catch((error) => Effect.succeed({ from: "unknown", reason: error.message } as const)));

/** The launchd implementation of the scheduler capability over `platform`. */
export const launchdScheduler = (platform: SchedulerPlatform): Context.Service.Shape<typeof Scheduler> => {
  const plistPath = launchAgentPlistPath(platform.home);
  return {
    kind: "launchd",
    install: (job, prepare) =>
      Effect.gen(function* () {
        const { domain, target } = yield* ownTarget(job.dataDir);
        // Ownership comes before any write: a foreign or unattributable service is never replaced.
        const loaded = yield* ownLoadedService(platform, plistPath, target);
        yield* prepare;
        // The launcher files go into the data directory first, so a bootstrap that starts the job always
        // finds them: the plist only names the script, and the script resolves Node at run time — seeded
        // with the Node running this install, which the app's discovery keeps current afterwards.
        const launcher = renderRefreshLauncher({
          dataDir: job.dataDir,
          cliPath: yield* runningCliPath((message) => new CollectorPathUnresolved({ message }), "LaunchAgent")
        });
        const plist = renderLaunchAgentPlist({
          dataDir: job.dataDir,
          snorlaxHome: snorlaxHomeOverride(platform)
        });
        yield* writeLauncherFiles(platform, job.dataDir, launcher);
        yield* Effect.tryPromise({
          try: async () => {
            await platform.fs.mkdir(join(platform.home, "Library", "LaunchAgents"));
            await platform.fs.writeAtomic(plistPath, plist, { mode: UNIT_FILE_MODE });
          },
          catch: (error) => new PlistWriteFailed({ message: `cannot write ${plistPath}: ${errorMessage(error)}` })
        });
        // bootstrap rejects a service that is already loaded, so a repeat install boots out first — by service
        // target, so a hand-deleted plist cannot block the bootout.
        if (loaded.state === "loaded") {
          yield* bootout(platform, target);
        }
        yield* bootstrap(platform, domain, plistPath).pipe(
          // A failed or interrupted install must not leave an installed-looking plist for the next login. An
          // interrupted bootstrap may still have loaded the service before its child stopped; runLaunchctl has
          // waited for that child to exit, so a service launchd now runs from this plist is booted out before the
          // plist goes. The cleanup runs uninterruptibly, every launchctl in it is bounded, and its own failures are
          // dropped: the command reports the bootstrap failure or the interruption, not the cleanup.
          Effect.onError((cause) =>
            Effect.andThen(
              Cause.hasInterrupts(cause)
                ? Effect.ignore(bootoutIfLoadedFrom(platform, target, plistPath))
                : Effect.void,
              Effect.ignore(Effect.tryPromise(() => platform.fs.remove(plistPath)))
            )
          )
        );
        return plistPath;
      }),
    uninstall: (job, guard) =>
      Effect.gen(function* () {
        const { target } = yield* ownTarget(job.dataDir);
        // The caller's guard runs before anything changes: a refused `--data` must not have already booted
        // out the agent and removed its plist.
        const guarded = yield* guard;
        const loaded = yield* ownLoadedService(platform, plistPath, target);
        if (loaded.state === "loaded") {
          yield* bootout(platform, target);
        }
        yield* Effect.tryPromise({
          try: () => platform.fs.remove(plistPath),
          catch: (error) => new PlistRemoveFailed({ message: `cannot remove ${plistPath}: ${errorMessage(error)}` })
        });
        return guarded;
      }),
    inspect: Effect.gen(function* () {
      return {
        kind: "inspected" as const,
        scheduler: "launchd" as const,
        cliJob: yield* readCliJob(platform, plistPath),
        loaded: yield* loadedJob(platform, plistPath)
      };
    })
  };
};
