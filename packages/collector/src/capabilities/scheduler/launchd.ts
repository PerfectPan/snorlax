import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";

import type { Platform } from "@rivus/agent-kit/platform";
import { Data, Effect, type Context } from "effect";

import { errorMessage } from "../../core/error-message/error-message.ts";
import { requireAbsoluteDataDir } from "../../modules/data-dir/data-dir.ts";
import { readTextFile } from "../../modules/read-text-file/read-text-file.ts";
import {
  LAUNCH_AGENT_LABEL,
  launchAgentNodePath,
  launchAgentPlistPath,
  renderLaunchAgentPlist,
  type LaunchAgentSpec
} from "./plist.ts";
import type { CliJob, LoadedJob, Scheduler } from "./scheduler.ts";

/**
 * The scheduler on macOS: a LaunchAgent in `~/Library/LaunchAgents`.
 *
 * The app's Launch at login (`SMAppService`, 3.11) and this LaunchAgent share one launchd label and are
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

/**
 * The loaded service with this label is not provably loaded from the CLI's own plist: Snorlax.app's Launch
 * at login owns it, or `launchctl print` names no plist.
 */
export class ForeignServiceLoaded extends Data.TaggedError("ForeignServiceLoaded")<{ readonly message: string }> {}

/** The LaunchAgent plist could not be written. */
export class PlistWriteFailed extends Data.TaggedError("PlistWriteFailed")<{ readonly message: string }> {}

/** The LaunchAgent plist could not be removed. */
export class PlistRemoveFailed extends Data.TaggedError("PlistRemoveFailed")<{ readonly message: string }> {}

const LAUNCHCTL_TIMEOUT_MS = 15_000;
const PLIST_MODE = 0o644;
const DEFAULT_LAUNCHCTL = "/bin/launchctl";

/** `run` is the only process operation install uses. */
type SchedulerPlatform = Pick<Platform, "env" | "fs" | "home"> & {
  readonly process: Pick<Platform["process"], "run">;
};

type LaunchctlResult = Awaited<ReturnType<SchedulerPlatform["process"]["run"]>>;

const launchctlBinary = (platform: Pick<Platform, "env">): string => {
  const override = platform.env.SNORLAX_LAUNCHCTL;
  if (override === undefined || override === "") {
    return DEFAULT_LAUNCHCTL;
  }
  return override;
};

/** The running Node binary and the `snorlax.mjs` entry this process was started with. */
const runningCollectorPaths: Effect.Effect<
  Pick<LaunchAgentSpec, "nodePath" | "cliPath">,
  CollectorPathUnresolved
> = Effect.suspend(() => {
  const entry = process.argv[1];
  if (entry === undefined || entry === "") {
    return Effect.fail(new CollectorPathUnresolved({ message: "cannot resolve the running snorlax CLI path" }));
  }
  const nodePath = process.execPath;
  const cliPath = resolve(entry);
  if (!isAbsolute(nodePath) || !isAbsolute(cliPath)) {
    return Effect.fail(
      new CollectorPathUnresolved({ message: "the Node and CLI paths in the LaunchAgent must be absolute" })
    );
  }
  return Effect.succeed({ nodePath, cliPath });
});

const currentUid: Effect.Effect<number, UserIdUnavailable> = Effect.suspend(() => {
  const uid = process.getuid?.();
  return uid === undefined
    ? Effect.fail(new UserIdUnavailable({ message: "launchd install needs a numeric user id" }))
    : Effect.succeed(uid);
});

const guiDomain = (uid: number): string => `gui/${uid}`;

/** An interrupted run stops the `launchctl` child through the signal instead of leaving it running. */
const runLaunchctl = (
  platform: SchedulerPlatform,
  args: readonly string[]
): Effect.Effect<LaunchctlResult, LaunchctlFailed> => {
  const command = launchctlBinary(platform);
  return Effect.tryPromise({
    try: (signal) => platform.process.run(command, args, { timeoutMs: LAUNCHCTL_TIMEOUT_MS, signal }),
    catch: (error) => new LaunchctlFailed({ message: `cannot run launchctl (${command}): ${errorMessage(error)}` })
  }).pipe(
    Effect.flatMap((result) => {
      if (result.timedOut || result.signal !== null) {
        const reason = result.timedOut ? "timeout" : result.signal;
        return Effect.fail(
          new LaunchctlFailed({ message: `launchctl ${args[0] ?? "command"} did not finish (${reason})` })
        );
      }
      return Effect.succeed(result);
    })
  );
};

const launchctlFailure = (result: LaunchctlResult, action: string): LaunchctlFailed => {
  const detail = (result.stderr !== "" ? result.stderr : result.stdout).trim();
  const suffix = detail === "" ? "" : `: ${detail}`;
  return new LaunchctlFailed({
    message: `launchctl ${action} failed (exit ${result.code ?? "unknown"})${suffix}`
  });
};

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
 * Plan 3.11 keeps the app's `SMAppService` agent and the CLI's LaunchAgent mutually exclusive: launchd
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

const bootout = (platform: SchedulerPlatform, target: string): Effect.Effect<void, LaunchctlFailed> =>
  Effect.flatMap(runLaunchctl(platform, ["bootout", target]), (result) =>
    result.code === 0 ? Effect.void : Effect.fail(launchctlFailure(result, "bootout"))
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

/** The CLI's plist and the Node binary it names; undefined when there is no plist. */
const readCliJob = (platform: SchedulerPlatform, plistPath: string): Effect.Effect<CliJob | undefined> =>
  Effect.promise(() =>
    readTextFile(platform, plistPath).then(
      (xml) => (xml === undefined ? undefined : { file: plistPath, nodePath: launchAgentNodePath(xml) }),
      // A plist that exists but cannot be read names no Node binary snorlax can check.
      () => ({ file: plistPath, nodePath: undefined })
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
    install: (job, prepare) =>
      Effect.gen(function* () {
        yield* requireAbsoluteDataDir(job.dataDir);
        const domain = guiDomain(yield* currentUid);
        const target = `${domain}/${LAUNCH_AGENT_LABEL}`;
        // Ownership comes before any write: a foreign or unattributable service is never replaced.
        const loaded = yield* loadedService(platform, target);
        yield* refuseForeignService(loaded, plistPath, target);
        yield* prepare;
        const plist = renderLaunchAgentPlist({
          ...(yield* runningCollectorPaths),
          dataDir: job.dataDir,
          snorlaxHome: snorlaxHomeOverride(platform)
        });
        yield* Effect.tryPromise({
          try: async () => {
            await platform.fs.mkdir(join(platform.home, "Library", "LaunchAgents"));
            await platform.fs.writeAtomic(plistPath, plist, { mode: PLIST_MODE });
          },
          catch: (error) => new PlistWriteFailed({ message: `cannot write ${plistPath}: ${errorMessage(error)}` })
        });
        // bootstrap rejects a service that is already loaded, so a repeat install boots out first — by service
        // target, so a hand-deleted plist cannot block the bootout.
        if (loaded.state === "loaded") {
          yield* bootout(platform, target);
        }
        yield* bootstrap(platform, domain, plistPath).pipe(
          // A failed or interrupted install must not leave an installed-looking plist for the next login. The
          // removal's own failure is dropped: the command reports the bootstrap failure, not the cleanup.
          Effect.onError(() => Effect.ignore(Effect.tryPromise(() => platform.fs.remove(plistPath))))
        );
        return plistPath;
      }),
    uninstall: (job, guard) =>
      Effect.gen(function* () {
        yield* requireAbsoluteDataDir(job.dataDir);
        const domain = guiDomain(yield* currentUid);
        const target = `${domain}/${LAUNCH_AGENT_LABEL}`;
        // The caller's guard runs before anything changes: a refused `--data` must not have already booted
        // out the agent and removed its plist.
        const guarded = yield* guard;
        const loaded = yield* loadedService(platform, target);
        yield* refuseForeignService(loaded, plistPath, target);
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
        kind: "inspected",
        cliJob: yield* readCliJob(platform, plistPath),
        loaded: yield* loadedJob(platform, plistPath)
      };
    })
  };
};
