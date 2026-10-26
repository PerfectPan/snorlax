import type { Platform } from "@rivus/agent-kit/platform";
import { Data, Effect } from "effect";

import { Scheduler } from "../../capabilities/scheduler/scheduler.ts";
import { Secrets } from "../../capabilities/secrets/secrets.ts";
import { resolveDataDir } from "../../modules/data-dir/data-dir.ts";
import { readLedgerStatus } from "../../modules/ledger/ledger.ts";
import { SnorlaxPlatform } from "../../modules/platform/platform.ts";
import { deleteDataDir, requireSnorlaxDataDir, resolvedDeletableDataDir } from "./delete-data.ts";

/**
 * The keychain item could not be deleted. The scheduled job is already gone and the data directory was kept,
 * so a retry of `uninstall --data` can delete the item and then the directory. Exit 1, `keychain`.
 */
class UninstallKeychainFailed extends Data.TaggedError("UninstallKeychainFailed")<{ readonly message: string }> {}

/**
 * `uninstall --data` deletes the keychain item after the scheduler has removed the job and before the data
 * directory is deleted. A keychain failure stops there: the job is already gone, the data directory stays,
 * and the command exits 1 with `keychain`. A missing item is success. Without `--data` the item is left in
 * place. No ledger means there is no device id, so the delete is skipped.
 */
const removeKeychainItem = (platform: Platform, dataDir: string) =>
  Effect.gen(function* () {
    const status = yield* readLedgerStatus(platform, dataDir).pipe(
      Effect.mapError(
        (error) =>
          new UninstallKeychainFailed({
            message:
              "the scheduled job is already removed, and the data directory was kept because the device id " +
              `could not be read (${error.message})`
          })
      )
    );
    if (status === null) {
      return;
    }
    yield* (yield* Secrets).delete(status.deviceId).pipe(
      Effect.mapError(
        (error) =>
          new UninstallKeychainFailed({
            message:
              "the scheduled job is already removed, and the data directory was kept because the keychain item " +
              `could not be deleted (${error.message})`
          })
      )
    );
  });

/**
 * One `snorlax uninstall` (plan 3.1): unschedules refresh, then with `deleteData` removes the keychain item and
 * deletes the data directory. The data directory is checked — its path, then the snorlax marker — before the
 * scheduler looks at the job, so a refused `--data` leaves the job loaded. `deleted` says the data directory was
 * emptied of snorlax's entries; `dataLeftovers` are the entries kept because snorlax did not write them.
 * The command names the job from the scheduler's kind, so this flow does not report an operating system.
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
    yield* removeKeychainItem(platform, toDelete);
    return { dataDir, deleted: true, dataLeftovers: yield* deleteDataDir(platform.fs, toDelete) };
  });
