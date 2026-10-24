import { Effect } from "effect";

import { Scheduler } from "../../capabilities/scheduler/scheduler.ts";
import { resolveDataDir } from "../../modules/data-dir/data-dir.ts";
import { SnorlaxPlatform } from "../../modules/platform/platform.ts";
import { deleteDataDir, requireSnorlaxDataDir, resolvedDeletableDataDir } from "./delete-data.ts";

/**
 * Deletes the device token from the keychain. Pairing does not exist in this build, so there is no item to
 * delete; Batch 7 replaces this with the secrets capability's delete.
 */
const removeKeychainItem: Effect.Effect<void> = Effect.void;

/**
 * One `snorlax uninstall` (plan 3.1): unschedules refresh, then with `deleteData` removes the keychain item and
 * deletes the data directory. The data directory is checked — its path, then the snorlax marker — before the
 * scheduler looks at the job, so a refused `--data` leaves the job loaded. `deleted` says the data directory was
 * emptied of snorlax's entries; `dataLeftovers` are the entries kept because snorlax did not write them.
 */
export const uninstallFlow = ({ deleteData }: { readonly deleteData: boolean }) =>
  Effect.gen(function* () {
    const platform = yield* SnorlaxPlatform;
    const dataDir = resolveDataDir(platform);
    const toDelete = yield* (yield* Scheduler).uninstall(
      { dataDir },
      deleteData
        ? resolvedDeletableDataDir(platform.fs, dataDir, platform.home).pipe(
            Effect.tap((dir) => requireSnorlaxDataDir(platform, dir))
          )
        : Effect.succeed(undefined)
    );
    if (toDelete === undefined) {
      return { dataDir, deleted: false, dataLeftovers: [] };
    }
    yield* removeKeychainItem;
    return { dataDir, deleted: true, dataLeftovers: yield* deleteDataDir(platform.fs, toDelete) };
  });
