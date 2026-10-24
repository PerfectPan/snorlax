import { join, resolve } from "node:path";

import type { Platform } from "@rivus/agent-kit/platform";
import { Data, Effect } from "effect";

import { errorMessage } from "../../core/error-message/error-message.ts";
import { requireAbsoluteDataDir, type DataDirNotAbsolute } from "../../modules/data-dir/data-dir.ts";
import { ledgerPath, readLedgerStatus } from "../../modules/ledger/ledger.ts";

/** `uninstall --data` refuses the data directory: it is `/`, the home directory or one of its ancestors. */
export class DataDirNotDeletable extends Data.TaggedError("DataDirNotDeletable")<{ readonly message: string }> {}

/** `uninstall --data` refuses the data directory: it holds no `ledger.db`, or a `ledger.db` that is not snorlax's. */
class DataDirNotSnorlax extends Data.TaggedError("DataDirNotSnorlax")<{ readonly message: string }> {}

/** `uninstall --data` refuses the data directory: its `ledger.db` cannot be read to tell whether it is snorlax's. */
class DataDirLedgerUnreadable extends Data.TaggedError("DataDirLedgerUnreadable")<{ readonly message: string }> {}

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

/** The start of a SQLite file: the 16-byte magic, then at offsets 18 and 19 the write and read format versions. */
const SQLITE_MAGIC = "SQLite format 3\0";
const SQLITE_HEADER_BYTES = 20;
/** Format version 1 is the rollback journal the ledger runs in; WAL databases carry 2. */
const ROLLBACK_JOURNAL_FORMAT = 1;

const readHeader = (fs: Pick<Platform["fs"], "read">, path: string): Effect.Effect<number[], unknown> =>
  Effect.tryPromise({
    try: async () => {
      const bytes: number[] = [];
      for await (const chunk of fs.read(path, { start: 0, end: SQLITE_HEADER_BYTES })) {
        bytes.push(...chunk);
      }
      return bytes;
    },
    catch: (error) => error
  });

const isRollbackJournalSqlite = (header: readonly number[]): boolean =>
  header.length === SQLITE_HEADER_BYTES &&
  String.fromCharCode(...header.slice(0, SQLITE_MAGIC.length)) === SQLITE_MAGIC &&
  header[18] === ROLLBACK_JOURNAL_FORMAT &&
  header[19] === ROLLBACK_JOURNAL_FORMAT;

/**
 * The snorlax marker `uninstall --data` requires before it deletes anything or touches the scheduled job: the
 * directory holds snorlax's ledger, a rollback-journal SQLite database whose `meta` row reads, opened read-only as
 * `status` opens it. Same-named files (`config.json`, `logs/`) prove nothing, so a directory without that ledger —
 * including one `install` created before its first refresh — is refused. Nothing at the path, or an empty
 * directory, holds nothing to protect and passes; the empty directory is what a repeat `uninstall --data` finds
 * once the user has moved away the entries an earlier run kept. The header is checked before SQLite opens the
 * file: a read-only open of a WAL database creates `-wal` and `-shm` files beside it, and a WAL `ledger.db` is
 * not snorlax's. A refusal says which case it met: no `ledger.db`; a `ledger.db` that is not snorlax's; or one
 * that cannot be read (a hot journal a read-only connection cannot roll back, a lock held past the busy timeout,
 * a damaged file). Only the last suggests `snorlax refresh`, which rolls back a hot journal and waits out a lock;
 * on a database another program wrote, a refresh would migrate it into a ledger.
 */
export const requireSnorlaxDataDir = (
  platform: Pick<Platform, "fs" | "sqlite">,
  dir: string
): Effect.Effect<void, DataDirNotSnorlax | DataDirLedgerUnreadable> =>
  Effect.gen(function* () {
    const found = yield* Effect.promise(() => platform.fs.stat(dir));
    if (
      found === undefined ||
      (found.kind === "dir" && (yield* Effect.promise(() => platform.fs.list(dir))).length === 0)
    ) {
      return;
    }
    const untouched = "nothing was deleted and the LaunchAgent was left in place";
    const ledger = ledgerPath(dir);
    const ledgerFound = yield* Effect.promise(() => platform.fs.stat(ledger));
    if (ledgerFound === undefined) {
      return yield* Effect.fail(
        new DataDirNotSnorlax({
          message:
            `no snorlax ledger in ${dir}: it has no ledger.db, so ${untouched}; to remove only the scheduled ` +
            "refresh, run `snorlax uninstall` without --data"
        })
      );
    }
    const notSnorlax = (reason: string) => new DataDirNotSnorlax({ message: `${reason}, so ${untouched}` });
    const unreadable = (reason: string) =>
      new DataDirLedgerUnreadable({
        message:
          `cannot tell whether ${ledger} is a snorlax ledger (${reason}), so ${untouched}; run \`snorlax refresh\` ` +
          "once, then `snorlax uninstall --data` again"
      });
    if (ledgerFound.kind !== "file") {
      return yield* Effect.fail(notSnorlax(`${ledger} is not a snorlax ledger: it is not a regular file`));
    }
    const header = yield* readHeader(platform.fs, ledger).pipe(
      Effect.mapError((error) => unreadable(`cannot read ${ledger}: ${errorMessage(error)}`))
    );
    if (!isRollbackJournalSqlite(header)) {
      return yield* Effect.fail(
        notSnorlax(`${ledger} is not a snorlax ledger: it is not a SQLite database in rollback-journal mode`)
      );
    }
    const status = yield* readLedgerStatus(platform, dir).pipe(
      Effect.mapError((error) =>
        error._tag === "LedgerNotSnorlax" ? notSnorlax(error.message) : unreadable(error.message)
      )
    );
    if (status === null) {
      return yield* Effect.fail(unreadable(`cannot open ${ledger}`));
    }
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
 * This is the sole deletion path for `uninstall --data`; `dir` comes from `resolvedDeletableDataDir` and has
 * passed `requireSnorlaxDataDir`.
 */
export const deleteDataDir = (fs: Platform["fs"], dir: string): Effect.Effect<readonly string[], DataDirDeleteFailed> =>
  Effect.gen(function* () {
    const remove = (path: string) =>
      Effect.tryPromise({
        try: () => fs.remove(path),
        catch: (error) =>
          new DataDirDeleteFailed({ message: `cannot delete the data directory ${dir}: ${errorMessage(error)}` })
      });
    const keptLogs: string[] = [];
    for (const name of KNOWN_DATA_ENTRIES) {
      if (name === "logs") {
        const logsDir = join(dir, name);
        for (const logName of KNOWN_LOG_FILES) {
          yield* remove(join(logsDir, logName));
        }
        keptLogs.push(...(yield* removeDirKeepingLeftovers(fs, logsDir, (entry) => `${name}/${entry}`)));
      } else {
        yield* remove(join(dir, name));
      }
    }
    for (const entry of yield* listOrNothing(fs, dir)) {
      if (LEDGER_BACKUP_PATTERN.test(entry.name) || ATOMIC_TEMP_PATTERN.test(entry.name)) {
        yield* remove(join(dir, entry.name));
      }
    }
    // A kept `logs` directory is already named through the entries it kept (`logs/<entry>`), so it is not listed again.
    const kept = yield* removeDirKeepingLeftovers(fs, dir);
    return [...keptLogs, ...kept.filter((name) => keptLogs.length === 0 || name !== "logs")].sort();
  });
