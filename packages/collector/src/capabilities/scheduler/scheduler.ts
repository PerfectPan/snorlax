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

/** `SNORLAX_OS` names a system other than darwin, linux or win32. */
class SchedulerOsOverrideInvalid extends Data.TaggedError("SchedulerOsOverrideInvalid")<{
  readonly message: string;
}> {}

/** This build has no scheduler for the system (only launchd on macOS). */
class SchedulerUnsupportedOs extends Data.TaggedError("SchedulerUnsupportedOs")<{ readonly message: string }> {}

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

/** What the scheduler sees of the refresh job, for `doctor`; `cliJob` is undefined when there is no job file. */
export type JobInspection =
  | { readonly kind: "unsupported"; readonly reason: string }
  | { readonly kind: "inspected"; readonly cliJob: CliJob | undefined; readonly loaded: LoadedJob };

type InstallFailure =
  | SchedulerUnavailable
  | DataDirNotAbsolute
  | UserIdUnavailable
  | LaunchctlFailed
  | ForeignServiceLoaded
  | CollectorPathUnresolved
  | PlistWriteFailed;

type UninstallFailure =
  | SchedulerUnavailable
  | DataDirNotAbsolute
  | UserIdUnavailable
  | LaunchctlFailed
  | ForeignServiceLoaded
  | PlistRemoveFailed;

/** A system without a scheduler in this build: both operations fail before anything runs, and `inspect` says why. */
const unavailable = (
  failure: (command: "install" | "uninstall") => SchedulerUnavailable,
  reason: string
): Context.Service.Shape<typeof Scheduler> => ({
  install: () => Effect.fail(failure("install")),
  uninstall: () => Effect.fail(failure("uninstall")),
  inspect: Effect.succeed({ kind: "unsupported", reason })
});

/**
 * The scheduled refresh (plan 3.11, 3.13 rule 5). Snorlax.app's Launch at login registers the same job under
 * the same label, so both operations refuse, changing nothing, while the loaded job is not provably the
 * CLI's own. One Layer per implementation, picked by `cli/bin.ts`: launchd, and for the systems this build
 * cannot schedule on, one whose operations fail; systemd arrives with Batch 8; tests provide a fake.
 */
export class Scheduler extends Context.Service<
  Scheduler,
  {
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

  /**
   * A system this build has no scheduler for: install and uninstall fail before anything runs, and every other
   * command runs as usual.
   */
  static readonly unsupported = (os: "linux" | "win32"): Layer.Layer<Scheduler> =>
    Layer.succeed(
      Scheduler,
      unavailable(
        (command) =>
          new SchedulerUnsupportedOs({
            message: `snorlax ${command} schedules a LaunchAgent on macOS in this build; ${os} support arrives with Batch 8 (systemd user timer)`
          }),
        `this build schedules refresh only with launchd on macOS; ${os} support arrives with Batch 8 (systemd user timer)`
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
