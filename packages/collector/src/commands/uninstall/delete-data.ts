import { join, resolve } from "node:path";

import type { Platform } from "@rivus/agent-kit/platform";
import { Data, Effect } from "effect";

import { errorMessage } from "../../core/error-message/error-message.ts";
import { requireAbsoluteDataDir, type DataDirNotAbsolute } from "../../modules/data-dir/data-dir.ts";

/** `uninstall --data` refuses the data directory: it is `/`, the home directory or one of its ancestors. */
export class DataDirNotDeletable extends Data.TaggedError("DataDirNotDeletable")<{ readonly message: string }> {}

/** `uninstall --data` could not delete the data directory or an entry snorlax wrote in it. */
class DataDirDeleteFailed extends Data.TaggedError("DataDirDeleteFailed")<{ readonly message: string }> {}

/**
 * The directory `uninstall --data` may delete. Relative paths are refused so a bad `SNORLAX_HOME`
 * cannot be resolved against the process working directory. `/`, the home directory, and its ancestors
 * are refused — compared through `realpath`, so a symlinked spelling is caught too. The directory is
 * only ever emptied entry by entry (`deleteDataDir`), so nothing outside snorlax's own files is deleted
 * even when a path slips past this guard.
 */
export const resolvedDeletableDataDir = (
  fs: Pick<Platform["fs"], "realpath">,
  dataDir: string,
  home: string
): Effect.Effect<string, DataDirNotAbsolute | DataDirNotDeletable> =>
  Effect.gen(function* () {
    yield* requireAbsoluteDataDir(dataDir);
    const refused = new DataDirNotDeletable({ message: `refusing to delete the data directory ${dataDir}` });
    const resolved = resolve(dataDir);
    if (resolved === resolve(home) || resolved === "/") {
      return yield* Effect.fail(refused);
    }
    const dataReal = yield* Effect.promise(() => fs.realpath(resolved));
    const homeReal = yield* Effect.promise(() => fs.realpath(home));
    if (
      dataReal !== undefined &&
      (dataReal === "/" || dataReal === homeReal || (homeReal !== undefined && homeReal.startsWith(`${dataReal}/`)))
    ) {
      return yield* Effect.fail(refused);
    }
    return resolved;
  });

type DirEntry = Awaited<ReturnType<Platform["fs"]["list"]>>[number];

/** `fs.list` rejects a missing directory; deletion treats that as nothing left to remove. */
const listOrNothing = (fs: Platform["fs"], dir: string): Effect.Effect<readonly DirEntry[]> =>
  Effect.promise(async () => {
    try {
      return await fs.list(dir);
    } catch {
      return [];
    }
  });

/**
 * Every entry snorlax writes directly in the data directory (3.3.2, 3.4.2, 3.9, 3.11): the ledger
 * database with its SQLite sidecars and lock files, the config, the snapshot, the app's `node-path`,
 * and the logs directory. Migration backups and crashed atomic-write temps are matched by pattern
 * below. launchd output files no longer exist (StandardOutPath/StandardErrorPath are /dev/null); the
 * `logs` directory still removes the ones older installs wrote.
 */
const KNOWN_DATA_ENTRIES = [
  "ledger.db",
  "ledger.db-wal",
  "ledger.db-shm",
  "ledger.db-journal",
  "ledger.lock",
  "ledger.lock.holder",
  "config.json",
  "snapshot.json",
  "node-path",
  "logs"
] as const;

const LEDGER_BACKUP_PATTERN = /^ledger\.db\.bak-v(\d+)$/;
/** `platform.fs.writeAtomic` leaves `.<16 hex>.tmp` beside the target when a write crashes. */
const ATOMIC_TEMP_PATTERN = /^\.[0-9a-f]{16}\.tmp$/;

/** Files the collector writes inside `logs/` (3.9); the last two are what older installs redirected launchd to. */
const KNOWN_LOG_FILES = [
  "snorlax.log",
  "snorlax.log.1",
  "snorlax.log.2",
  "refresh.stdout.log",
  "refresh.stderr.log"
] as const;

/**
 * Removes `dir` only when it is empty, and returns the entries that kept it alive (mapped through
 * `name` so a nested directory can be reported as `logs/<entry>`). Any other failure — an empty
 * directory that cannot be removed, a listing that comes back unreadable — is a `DataDirDeleteFailed`:
 * a kept directory must never read as deleted.
 */
const removeDirKeepingLeftovers = (
  fs: Platform["fs"],
  dir: string,
  name: (entry: string) => string = (entry) => entry
): Effect.Effect<readonly string[], DataDirDeleteFailed> =>
  Effect.tryPromise({ try: () => fs.remove(dir), catch: (error) => error }).pipe(
    Effect.map((): readonly string[] => []),
    Effect.catch((error) =>
      Effect.gen(function* () {
        const entries = yield* listOrNothing(fs, dir);
        if (entries.length === 0) {
          return yield* Effect.fail(
            new DataDirDeleteFailed({ message: `cannot delete ${dir}: ${errorMessage(error)}` })
          );
        }
        return entries.map((entry) => name(entry.name));
      })
    )
  );

/**
 * Deletes only entries snorlax wrote, then removes the directory itself only when nothing else
 * remains; the surviving names are returned for the command output. Nothing here deletes
 * recursively: `logs/` is emptied file by file too, so a data directory that happens to be
 * `~/Library` (same name as `logs`, case-insensitive APFS) cannot lose the user's `Logs` tree.
 * This is the sole deletion path for `uninstall --data`; `dir` comes from `resolvedDeletableDataDir`.
 */
export const deleteDataDir = (fs: Platform["fs"], dir: string): Effect.Effect<readonly string[], DataDirDeleteFailed> =>
  Effect.gen(function* () {
    const remove = (path: string) =>
      Effect.tryPromise({
        try: () => fs.remove(path),
        catch: (error) =>
          new DataDirDeleteFailed({ message: `cannot delete the data directory ${dir}: ${errorMessage(error)}` })
      });
    const leftovers: string[] = [];
    for (const name of KNOWN_DATA_ENTRIES) {
      if (name === "logs") {
        const logsDir = join(dir, name);
        for (const logName of KNOWN_LOG_FILES) {
          yield* remove(join(logsDir, logName));
        }
        leftovers.push(...(yield* removeDirKeepingLeftovers(fs, logsDir, (entry) => `${name}/${entry}`)));
      } else {
        yield* remove(join(dir, name));
      }
    }
    for (const entry of yield* listOrNothing(fs, dir)) {
      if (LEDGER_BACKUP_PATTERN.test(entry.name) || ATOMIC_TEMP_PATTERN.test(entry.name)) {
        yield* remove(join(dir, entry.name));
      }
    }
    leftovers.push(...(yield* removeDirKeepingLeftovers(fs, dir)));
    return leftovers.sort();
  });
