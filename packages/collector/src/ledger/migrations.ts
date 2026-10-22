import { join } from "node:path";

import type { Platform } from "@rivus/agent-kit/platform";

import { errorMessage } from "../util/error-message.ts";

/**
 * The ledger's schema history (plan 3.3.2). `PRAGMA user_version` holds the version a database is on; every
 * entry older than the database's version has run already. Migrations are forward-only: a database on a newer
 * version than this build refuses to open instead of being downgraded.
 */
export interface Migration {
  readonly version: number;
  readonly sql: readonly string[];
}

/**
 * Version 1 is the whole M1 schema (plan 3.3.2). The `remote_*` tables stay empty until sync arrives in
 * Batch 7 but exist from the start, so a later migration only adds columns. `IF NOT EXISTS` keeps the
 * statements idempotent for a database that predates `user_version` bookkeeping.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: [
      `CREATE TABLE IF NOT EXISTS meta (
         id                    INTEGER PRIMARY KEY CHECK (id = 0),
         device_id             TEXT NOT NULL,
         device_name           TEXT,
         last_scan_completed_at INTEGER,
         pull_cursor           INTEGER NOT NULL DEFAULT 0,
         pricing_version       TEXT
       )`,
      `CREATE TABLE IF NOT EXISTS scan_state (
         id    INTEGER PRIMARY KEY CHECK (id = 0),
         state TEXT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS buckets (
         hour                INTEGER NOT NULL,
         agent               TEXT    NOT NULL,
         model               TEXT    NOT NULL,
         input_tokens        INTEGER NOT NULL,
         cache_read_tokens   INTEGER NOT NULL,
         cache_write_tokens  INTEGER NOT NULL,
         output_tokens       INTEGER NOT NULL,
         reasoning_tokens    INTEGER NOT NULL,
         requests            INTEGER NOT NULL,
         sessions_started    INTEGER NOT NULL,
         cost_usd            REAL    NOT NULL,
         unpriced_requests   INTEGER NOT NULL,
         dirty               INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (hour, agent, model)
       )`,
      `CREATE TABLE IF NOT EXISTS remote_buckets (
         device_id           TEXT    NOT NULL,
         hour                INTEGER NOT NULL,
         agent               TEXT    NOT NULL,
         model               TEXT    NOT NULL,
         input_tokens        INTEGER NOT NULL,
         cache_read_tokens   INTEGER NOT NULL,
         cache_write_tokens  INTEGER NOT NULL,
         output_tokens       INTEGER NOT NULL,
         reasoning_tokens    INTEGER NOT NULL,
         requests            INTEGER NOT NULL,
         sessions_started    INTEGER NOT NULL,
         cost_usd            REAL    NOT NULL,
         unpriced_requests   INTEGER NOT NULL,
         seq                 INTEGER NOT NULL,
         PRIMARY KEY (device_id, hour, agent, model)
       )`,
      `CREATE TABLE IF NOT EXISTS remote_devices (
         id            TEXT PRIMARY KEY,
         name          TEXT NOT NULL,
         last_push_at  INTEGER,
         revoked       INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE TABLE IF NOT EXISTS sessions_seen (
         agent      TEXT    NOT NULL,
         session_id TEXT    NOT NULL,
         first_hour INTEGER NOT NULL,
         PRIMARY KEY (agent, session_id)
       )`
    ]
  }
];

/** The schema version this build writes; the last entry of `MIGRATIONS`. */
export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

/** How many `ledger.db.bak-v*` files the data directory keeps (plan 3.3.2). */
export const BACKUPS_KEPT = 2;

export const backupName = (version: number): string => `ledger.db.bak-v${version}`;

const BACKUP_PATTERN = /^ledger\.db\.bak-v(\d+)$/;

export interface LedgerBackup {
  readonly version: number;
  readonly path: string;
}

export async function listBackups(fs: Platform["fs"], dataDir: string): Promise<LedgerBackup[]> {
  const entries = await fs.list(dataDir);
  return entries
    .flatMap((entry) => {
      const match = BACKUP_PATTERN.exec(entry.name);
      return match === null || match[1] === undefined
        ? []
        : [{ version: Number(match[1]), path: join(dataDir, entry.name) }];
    })
    .sort((a, b) => a.version - b.version);
}

/**
 * Copies the database to `ledger.db.bak-v<version>` before it is migrated, then keeps only the newest
 * `BACKUPS_KEPT` backups by version. Copying goes through the platform (read plus atomic write), so a test
 * platform sees it like any other write.
 */
export async function backupLedger(
  fs: Platform["fs"],
  dataDir: string,
  ledgerPath: string,
  version: number
): Promise<LedgerBackup> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of fs.read(ledgerPath)) {
    chunks.push(chunk);
  }
  let length = 0;
  for (const chunk of chunks) {
    length += chunk.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const backup: LedgerBackup = { version, path: join(dataDir, backupName(version)) };
  await fs.writeAtomic(backup.path, bytes);
  for (const old of (await listBackups(fs, dataDir)).slice(0, -BACKUPS_KEPT)) {
    await fs.remove(old.path);
  }
  return backup;
}

/** Runs every migration newer than `from` inside one transaction, ending at `SCHEMA_VERSION`. */
export function runMigrations(
  db: { exec(sql: string): void; prepare(sql: string): { get(): Record<string, unknown> | undefined } },
  from: number,
  sqlByVersion = MIGRATIONS
): void {
  const pending = sqlByVersion.filter((migration) => migration.version > from);
  if (pending.length === 0) {
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const migration of pending) {
      for (const statement of migration.sql) {
        db.exec(statement);
      }
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/**
 * Opens the door for `openLedger`: reads `PRAGMA user_version`, refuses a database from a newer build, and
 * backs up before any migration runs. `isExisting` says whether the database file existed before it was
 * opened; a database this call creates has nothing to back up.
 */
export async function prepareMigrations(
  fs: Platform["fs"],
  dataDir: string,
  ledgerPath: string,
  db: { exec(sql: string): void; prepare(sql: string): { get(): Record<string, unknown> | undefined } },
  isExisting: boolean
): Promise<{ readonly from: number; readonly backup: LedgerBackup | undefined }> {
  const row = db.prepare("PRAGMA user_version").get();
  const from = Number(row?.user_version ?? 0);
  if (from > SCHEMA_VERSION) {
    throw new MigrationError(
      `${ledgerPath} was written by a newer snorlax (schema version ${from}; this build knows ${SCHEMA_VERSION})`
    );
  }
  if (from === SCHEMA_VERSION) {
    return { from, backup: undefined };
  }
  let backup: LedgerBackup | undefined;
  if (isExisting) {
    try {
      backup = await backupLedger(fs, dataDir, ledgerPath, from);
    } catch (error) {
      throw new MigrationError(`cannot back up ${ledgerPath} before migrating: ${errorMessage(error)}`);
    }
  }
  runMigrations(db, from);
  return { from, backup };
}
