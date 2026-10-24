import { isAbsolute, join, resolve } from "node:path";

import type { Platform } from "@rivus/agent-kit/platform";
import { Data, Effect } from "effect";

import { errorMessage } from "../../core/error-message/error-message.ts";
import type { NodeFileOps } from "../platform/platform.ts";

/** The data directory is private to the user (plan 3.4.1, Spec 3.8). */
export const DATA_DIR_MODE = 0o700;

/**
 * Where the collector keeps everything it writes: `SNORLAX_HOME` when set, else the platform default —
 * `~/Library/Application Support/snorlax` on macOS, `${XDG_DATA_HOME:-~/.local/share}/snorlax` elsewhere
 * (plan 3.4.1 step 1). `SNORLAX_HOME` is used as given; an absolute path is expected.
 */
export function resolveDataDir(platform: Pick<Platform, "env" | "home" | "os">): string {
  const override = platform.env.SNORLAX_HOME;
  if (override !== undefined && override !== "") {
    return override;
  }
  if (platform.os === "darwin") {
    return join(platform.home, "Library", "Application Support", "snorlax");
  }
  const xdg = platform.env.XDG_DATA_HOME;
  const dataHome = xdg !== undefined && xdg !== "" ? xdg : join(platform.home, ".local", "share");
  return join(dataHome, "snorlax");
}

/** The data directory or its `logs` subdirectory could not be created or given mode 0700. */
export class DataDirCreateFailed extends Data.TaggedError("DataDirCreateFailed")<{ readonly message: string }> {}

/**
 * Creates the directory (and parents) and the `logs` subdirectory (plan 3.9), and keeps the data
 * directory at mode 0700; existing wider modes are tightened. Only commands that write call this —
 * `status`, `doctor` and `snapshot` run without it and create nothing (plan 3.13).
 */
export const ensureDataDir = (
  platform: Pick<Platform, "fs">,
  nodeFiles: NodeFileOps,
  path: string
): Effect.Effect<void, DataDirCreateFailed> =>
  Effect.tryPromise({
    try: async () => {
      await platform.fs.mkdir(path);
      await nodeFiles.chmod(path, DATA_DIR_MODE);
      await platform.fs.mkdir(join(path, "logs"));
    },
    catch: (error) =>
      new DataDirCreateFailed({ message: `cannot create the data directory ${path}: ${errorMessage(error)}` })
  });

/** The data directory is a relative path, so the LaunchAgent and `uninstall --data` cannot use it. */
export class DataDirNotAbsolute extends Data.TaggedError("DataDirNotAbsolute")<{ readonly message: string }> {}

/** `uninstall --data` refuses the data directory: it is `/`, the home directory or one of its ancestors. */
export class DataDirNotDeletable extends Data.TaggedError("DataDirNotDeletable")<{ readonly message: string }> {}

/** `uninstall --data` could not delete the data directory or an entry snorlax wrote in it. */
class DataDirDeleteFailed extends Data.TaggedError("DataDirDeleteFailed")<{ readonly message: string }> {}

export const requireAbsoluteDataDir = (dataDir: string): Effect.Effect<void, DataDirNotAbsolute> =>
  isAbsolute(dataDir)
    ? Effect.void
    : Effect.fail(new DataDirNotAbsolute({ message: `the data directory must be absolute, got ${dataDir}` }));

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
