import { Context, Effect, Layer } from "effect";

import { DataDirCreateFailed, ensureDataDir, resolveDataDir } from "../../modules/data-dir/data-dir.ts";
import { NodeFiles, SnorlaxPlatform } from "../../modules/platform/platform.ts";
import {
  CollectorPathUnresolved,
  DataDirDeleteFailed,
  DataDirNotAbsolute,
  DataDirNotDeletable,
  ForeignServiceLoaded,
  installLaunchAgent,
  LaunchctlFailed,
  PlistRemoveFailed,
  PlistWriteFailed,
  SchedulerOsOverrideInvalid,
  SchedulerUnsupportedOs,
  uninstallLaunchAgent,
  UserIdUnavailable,
  type UninstallResult
} from "./launchd.ts";

type ScheduleFailure =
  | SchedulerOsOverrideInvalid
  | SchedulerUnsupportedOs
  | DataDirNotAbsolute
  | DataDirNotDeletable
  | DataDirDeleteFailed
  | DataDirCreateFailed
  | CollectorPathUnresolved
  | UserIdUnavailable
  | LaunchctlFailed
  | ForeignServiceLoaded
  | PlistWriteFailed
  | PlistRemoveFailed;

/** Keeps what `launchd.ts` throws on purpose as typed failures; any other rejection is a defect. */
const scheduleFailure = (defect: unknown): Effect.Effect<never, ScheduleFailure> =>
  defect instanceof SchedulerOsOverrideInvalid ||
  defect instanceof SchedulerUnsupportedOs ||
  defect instanceof DataDirNotAbsolute ||
  defect instanceof DataDirNotDeletable ||
  defect instanceof DataDirDeleteFailed ||
  defect instanceof DataDirCreateFailed ||
  defect instanceof CollectorPathUnresolved ||
  defect instanceof UserIdUnavailable ||
  defect instanceof LaunchctlFailed ||
  defect instanceof ForeignServiceLoaded ||
  defect instanceof PlistWriteFailed ||
  defect instanceof PlistRemoveFailed
    ? Effect.fail(defect)
    : Effect.die(defect);

/**
 * The LaunchAgent as a service, over the plain orchestration in `launchd.ts`; the real `launchctl`
 * is never started by tests, which point `SNORLAX_LAUNCHCTL` at a stub. `install` prepares the data
 * directory — but only after the ownership check has accepted the loaded service, so a refused
 * install builds nothing (plan 3.13). `uninstall` prepares nothing at all: it only removes known
 * entries, and both the kit's `fs.remove` and the leftovers handling treat a missing data directory
 * or a missing `logs/` directory as already clean.
 */
export class Schedule extends Context.Service<
  Schedule,
  {
    readonly install: Effect.Effect<string, ScheduleFailure>;
    readonly uninstall: (options: { readonly deleteData: boolean }) => Effect.Effect<UninstallResult, ScheduleFailure>;
  }
>()("snorlax/schedule/Schedule") {
  static readonly live = Layer.effect(
    Schedule,
    Effect.gen(function* () {
      const platform = yield* SnorlaxPlatform;
      const nodeFiles = yield* NodeFiles;
      const dataDir = resolveDataDir(platform);
      return Schedule.of({
        // `Effect.runPromise` rejects with the failure itself, so a `DataDirCreateFailed` from `prepare`
        // reaches `scheduleFailure` as the same instance.
        install: Effect.promise(() =>
          installLaunchAgent(platform, dataDir, () => Effect.runPromise(ensureDataDir(platform, nodeFiles, dataDir)))
        ).pipe(Effect.catchDefect(scheduleFailure)),
        uninstall: (options) =>
          Effect.promise(() => uninstallLaunchAgent(platform, dataDir, options)).pipe(
            Effect.catchDefect(scheduleFailure)
          )
      });
    })
  );
}

export {
  CollectorPathUnresolved,
  DataDirDeleteFailed,
  DataDirNotAbsolute,
  DataDirNotDeletable,
  ForeignServiceLoaded,
  LaunchctlFailed,
  PlistRemoveFailed,
  PlistWriteFailed,
  SchedulerOsOverrideInvalid,
  SchedulerUnsupportedOs,
  UserIdUnavailable
};
