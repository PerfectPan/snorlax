import type { Platform } from "@rivus/agent-kit/platform";
import { Context, Data, Effect, Layer } from "effect";

import type { DataDirNotAbsolute } from "../../modules/data-dir/data-dir.ts";
import { SnorlaxPlatform } from "../../modules/platform/platform.ts";
import {
  ForeignServiceLoaded,
  launchdScheduler,
  type CollectorPathUnresolved,
  type LaunchctlFailed,
  type PlistRemoveFailed,
  type PlistWriteFailed,
  type UserIdUnavailable
} from "./launchd.ts";
import {
  systemdScheduler,
  type ForeignTimerLoaded,
  type SystemctlFailed,
  type UnitPathsUnresolved,
  type UnitRemoveFailed,
  type UnitWriteFailed
} from "./systemd.ts";

/** `SNORLAX_OS` names a system other than darwin, linux or win32. */
class SchedulerOsOverrideInvalid extends Data.TaggedError("SchedulerOsOverrideInvalid")<{
  readonly message: string;
}> {}

/** This build has no scheduler for the system (win32; macOS uses launchd and Linux uses systemd). */
class SchedulerUnsupportedOs extends Data.TaggedError("SchedulerUnsupportedOs")<{ readonly message: string }> {}

/** `darwin`, `linux` or `win32`: the systems `SNORLAX_OS` may name. */
export type SchedulerOs = "darwin" | "linux" | "win32";

/**
 * The job a scheduler manages. `install` and `uninstall` name this in their text. They do not read
 * `platform.os`: `SNORLAX_OS` can select a scheduler the host is not, and a test's fake declares its own.
 */
export type SchedulerKind = "launchd" | "systemd";

/**
 * The system whose scheduler `cli/bin.ts` installs. `SNORLAX_OS`, when set, stands in for `platform.os`
 * so the bundled CLI can run either scheduler on any CI job. An override that names nothing is undefined.
 */
export const schedulerOs = (platform: Pick<Platform, "env" | "os">): SchedulerOs | undefined => {
  const override = platform.env.SNORLAX_OS;
  const os = override === undefined || override === "" ? platform.os : override;
  if (os === "darwin" || os === "linux" || os === "win32") {
    return os;
  }
  return undefined;
};

/** The job snorlax schedules: `snorlax refresh` every 300 seconds over `dataDir`, which must be absolute. */
interface RefreshJob {
  readonly dataDir: string;
}

type SchedulerUnavailable = SchedulerOsOverrideInvalid | SchedulerUnsupportedOs;

/**
 * Where the loaded job with snorlax's label comes from: nowhere, the job file `snorlax install` writes, another
 * file (Snorlax.app's Launch at login, the only other registrant of the label), or a source the scheduler cannot
 * name, with the reason.
 */
export type LoadedJob =
  | { readonly from: "nothing" }
  | { readonly from: "cli"; readonly file: string }
  | { readonly from: "app"; readonly file: string }
  | { readonly from: "unknown"; readonly reason: string };

/** The job file `snorlax install` writes, and the Node binary it runs: undefined when the file does not read back. */
export interface CliJob {
  readonly file: string;
  readonly nodePath: string | undefined;
}

/**
 * What the scheduler sees of the refresh job, for `doctor`. `cliJob` is undefined when there is no job file.
 * `scheduler` says which implementation looked, so the verdict can name launchd or systemd; absent means
 * launchd, which is what the fake scheduler and the older fixtures report.
 */
export type JobInspection =
  | { readonly kind: "unsupported"; readonly reason: string }
  | {
      readonly kind: "inspected";
      readonly scheduler?: "launchd" | "systemd";
      readonly cliJob: CliJob | undefined;
      readonly loaded: LoadedJob;
    };

type InstallFailure =
  | SchedulerUnavailable
  | DataDirNotAbsolute
  | UserIdUnavailable
  | LaunchctlFailed
  | ForeignServiceLoaded
  | CollectorPathUnresolved
  | PlistWriteFailed
  | SystemctlFailed
  | ForeignTimerLoaded
  | UnitPathsUnresolved
  | UnitWriteFailed;

type UninstallFailure =
  | SchedulerUnavailable
  | DataDirNotAbsolute
  | UserIdUnavailable
  | LaunchctlFailed
  | ForeignServiceLoaded
  | PlistRemoveFailed
  | SystemctlFailed
  | ForeignTimerLoaded
  | UnitRemoveFailed;

/** A system without a scheduler in this build: both operations fail before anything runs, and `inspect` says why. */
const unavailable = (
  failure: (command: "install" | "uninstall") => SchedulerUnavailable,
  reason: string
): Context.Service.Shape<typeof Scheduler> => ({
  // Both operations fail before a command formats text, so this value is never printed.
  kind: "launchd",
  install: () => Effect.fail(failure("install")),
  uninstall: () => Effect.fail(failure("uninstall")),
  inspect: Effect.succeed({ kind: "unsupported", reason })
});

/**
 * The scheduled refresh (plan 3.11, 3.13 rule 5). Snorlax.app's Launch at login registers the same job under
 * the same label, so the launchd operations refuse, changing nothing, while the loaded job is not provably
 * the CLI's own. One Layer per implementation, picked by `cli/bin.ts`: launchd, systemd, and for win32 one
 * whose operations fail. Tests provide a fake.
 */
export class Scheduler extends Context.Service<
  Scheduler,
  {
    /**
     * Which job this implementation manages. The commands name it; an implementation that manages none still
     * carries `launchd` because its operations fail before that text is formatted.
     */
    readonly kind: SchedulerKind;
    /**
     * Writes and loads the job and returns the file it was written to. `prepare` runs once the ownership
     * check has passed and before the first write, so a refused install builds nothing.
     */
    readonly install: <E>(
      job: RefreshJob,
      prepare: Effect.Effect<void, E>
    ) => Effect.Effect<string, InstallFailure | E>;
    /**
     * Unloads the job and removes its file. `guard` runs before the job is looked at, so a refusal there
     * leaves the job loaded; its value is returned.
     */
    readonly uninstall: <A, E>(job: RefreshJob, guard: Effect.Effect<A, E>) => Effect.Effect<A, UninstallFailure | E>;
    /**
     * Reads the job file and asks the scheduler what it has loaded, writing nothing (plan 3.13 rule 8). A
     * scheduler that cannot answer says so in the result instead of failing.
     */
    readonly inspect: Effect.Effect<JobInspection>;
  }
>()("snorlax/scheduler/Scheduler") {
  /** launchd, the scheduler on macOS (`launchd.ts`). */
  static readonly launchd: Layer.Layer<Scheduler, never, SnorlaxPlatform> = Layer.effect(
    Scheduler,
    Effect.gen(function* () {
      return launchdScheduler(yield* SnorlaxPlatform);
    })
  );

  /** systemd user timer, the scheduler on Linux (`systemd.ts`). */
  static readonly systemd: Layer.Layer<Scheduler, never, SnorlaxPlatform> = Layer.effect(
    Scheduler,
    Effect.gen(function* () {
      return systemdScheduler(yield* SnorlaxPlatform);
    })
  );

  /**
   * A system this build has no scheduler for: install and uninstall fail before anything runs, and every other
   * command runs as usual.
   */
  static readonly unsupported = (os: "win32"): Layer.Layer<Scheduler> =>
    Layer.succeed(
      Scheduler,
      unavailable(
        (command) =>
          new SchedulerUnsupportedOs({
            message: `snorlax ${command} has no scheduler on ${os} in this build`
          }),
        `this build schedules refresh with launchd on macOS and a systemd user timer on Linux; ${os} has none`
      )
    );

  /** `SNORLAX_OS` names no system: install and uninstall fail, and every other command runs as usual. */
  static readonly osOverrideInvalid: Layer.Layer<Scheduler> = Layer.succeed(
    Scheduler,
    unavailable(
      () => new SchedulerOsOverrideInvalid({ message: "SNORLAX_OS must be darwin, linux, or win32" }),
      "SNORLAX_OS must be darwin, linux, or win32, so no scheduler was picked"
    )
  );
}

export { ForeignServiceLoaded };
