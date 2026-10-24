import { Effect } from "effect";

import { Scheduler } from "../../capabilities/scheduler/scheduler.ts";
import { deleteDataDir, resolveDataDir, resolvedDeletableDataDir } from "../../modules/data-dir/data-dir.ts";
import { SnorlaxPlatform } from "../../modules/platform/platform.ts";

/**
 * Deletes the device token from the keychain. Pairing does not exist in this build, so there is no item to
 * delete; Batch 7 replaces this with the secrets capability's delete.
 */
const removeKeychainItem: Effect.Effect<void> = Effect.void;

/**
 * One `snorlax uninstall` (plan 3.1): unschedules refresh, then with `deleteData` removes the keychain item and
 * deletes the data directory. The data directory is checked before the scheduler looks at the job, so a
 * refused `--data` leaves the job loaded. `dataLeftovers` are the entries kept because snorlax did not write
 * them.
 */
export const uninstallFlow = ({ deleteData }: { readonly deleteData: boolean }) =>
  Effect.gen(function* () {
    const platform = yield* SnorlaxPlatform;
    const dataDir = resolveDataDir(platform);
    const toDelete = yield* (yield* Scheduler).uninstall(
      { dataDir },
      deleteData ? resolvedDeletableDataDir(platform.fs, dataDir, platform.home) : Effect.succeed(undefined)
    );
    if (toDelete === undefined) {
      return { dataDir, dataLeftovers: [] };
    }
    yield* removeKeychainItem;
    return { dataDir, dataLeftovers: yield* deleteDataDir(platform.fs, toDelete) };
  });
