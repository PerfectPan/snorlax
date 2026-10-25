import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { Platform } from "@rivus/agent-kit/platform";
import type { UsageRecord } from "@rivus/agent-kit/transcript/usage";
import type { RefreshResult } from "@rivus/snorlax-protocol";
import { Data, Effect, Exit, type Scope } from "effect";
import * as z from "zod/mini";

import type { BucketDelta, BucketRow, RemoteBucketRow, RemoteDeviceRow } from "../../core/buckets/buckets.ts";
import { errorMessage } from "../../core/error-message/error-message.ts";
import { buildSnapshot } from "../../core/snapshot/snapshot.ts";
import { readConfig, type ConfigInvalid } from "../config/config.ts";
import type { LogFieldValue, Logger } from "../log/log.ts";
import { writeSnapshot, type SnapshotWriteFailed } from "../snapshot-file/snapshot-file.ts";
import { holdLedgerLock, LedgerLockHeld } from "./lock.ts";
import { LedgerBackupFailed, LedgerSchemaTooNew, prepareMigrations, SCHEMA_VERSION } from "./migrations.ts";
import { commitScan, PRICING_VERSION, type ScanWindow } from "./commit-scan.ts";
import type { PlatformSqlite, SqliteDatabase, SqliteValue } from "./sqlite.ts";

/** The `meta` row; `device_id` is generated once, here, when the ledger is created. */
export interface LedgerMeta {
  readonly deviceId: string;
  readonly deviceName: string | null;
  readonly lastScanCompletedAt: number | null;
  readonly pullCursor: number;
  readonly pricingVersion: string | null;
}

export interface LedgerPlatform {
  readonly fs: Platform["fs"];
  /** The ledger needs SQLite; the Node platform has it, and refresh refuses to run without it. */
  readonly sqlite: PlatformSqlite;
}

const BUCKET_COLUMNS =
  "hour, agent, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, requests, sessions_started, cost_usd, unpriced_requests";

/**
 * The persisted scan state (plan 3.3.2, `scan_state`), read back with a schema at the boundary. The shape
 * mirrors the kit's `UsageScanState`; a cursor's `state` and the items of its `queue` are the kit's own
 * opaque JSON — written by this collector from the kit's output and read back leniently by the kit's
 * decoders — so they stay `unknown` here.
 */
export interface PersistedScanState {
  readonly sources: Readonly<Record<string, PersistedScanSource>>;
  readonly requests: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

interface PersistedScanSource {
  readonly agent: string;
  readonly path: string;
  readonly mtimeMs: number;
  readonly cursor?: {
    readonly agent: string;
    readonly offset: number;
    readonly line: number;
    readonly state?: unknown;
    readonly queue?: readonly UsageRecord[];
  };
  readonly mark?: { readonly time: number; readonly count: number };
}

const scanCursorSchema = z.looseObject({
  agent: z.string(),
  offset: z.number(),
  line: z.number(),
  state: z.optional(z.unknown()),
  queue: z.optional(z.array(z.unknown()))
});

// Loose at every level: the state returns to the kit's decoders, so fields a newer kit adds must survive
// this build's read-back instead of being stripped (plan 3.7).
const scanStateSchema = z.looseObject({
  sources: z.record(
    z.string(),
    z.looseObject({
      agent: z.string(),
      path: z.string(),
      mtimeMs: z.number(),
      cursor: z.optional(scanCursorSchema),
      mark: z.optional(z.looseObject({ time: z.number(), count: z.number() }))
    })
  ),
  requests: z.record(z.string(), z.record(z.string(), z.string()))
});

/**
 * The open ledger. Every operation runs on the one connection `openLedger` holds for its scope; the
 * multi-statement writes of a run go inside `transaction`, so a run that fails or is interrupted mid-way leaves
 * the database as it was (Spec S3). A SQLite statement that throws is a defect; a row this build cannot read
 * fails as `LedgerUnreadable`.
 */
export interface Ledger {
  readonly meta: LedgerMeta;
  /** The saved scan state, `undefined` before the first completed scan. */
  readonly scanState: PersistedScanState | undefined;
  /**
   * Runs `body` between `BEGIN IMMEDIATE` and `COMMIT`, rolling back when it fails or is interrupted. The body
   * may wait between statements (the run's scan iterates inside it); nothing else may write meanwhile, which
   * the ledger lock guarantees.
   */
  transaction<A, E, R>(body: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
  /** Adds each bucket's numbers into its row and marks the row dirty (absolute totals, plan 3.3.1). */
  addBuckets(buckets: readonly BucketDelta[]): Effect.Effect<void>;
  /** Records sessions first seen in this run; a row that exists already is ignored. */
  addSessionsSeen(sessions: readonly { agent: string; sessionId: string; firstHour: number }[]): Effect.Effect<void>;
  /** Every (agent, session id) the ledger has already counted a session start for. */
  sessionsSeen(): Effect.Effect<Map<string, Set<string>>, LedgerUnreadable>;
  setScanState(state: unknown): Effect.Effect<void>;
  setLastScanCompleted(atMs: number): Effect.Effect<void>;
  /** Records the version of the pricing table that priced the buckets (plan 3.7). */
  setPricingVersion(version: string): Effect.Effect<void>;
  readBuckets(): Effect.Effect<BucketRow[], LedgerUnreadable>;
  readRemoteBuckets(): Effect.Effect<RemoteBucketRow[], LedgerUnreadable>;
  readRemoteDevices(): Effect.Effect<RemoteDeviceRow[], LedgerUnreadable>;
  /** Zeroes every bucket at or after `startHour` and marks it dirty, for `rebuild` (plan 3.4.3). */
  zeroBucketsFrom(startHour: number): Effect.Effect<void>;
  /** Drops session-first-seen rows at or after `startHour`, so a rescan counts those sessions again. */
  deleteSessionsSeenFrom(startHour: number): Effect.Effect<void>;
}

export const ledgerPath = (dataDir: string): string => join(dataDir, "ledger.db");

/**
 * How long a ledger connection waits for another connection's lock before failing with SQLITE_BUSY. `status` reads
 * without the ledger lock, so its read and a refresh's COMMIT in another process can meet: in the rollback journal
 * the COMMIT waits for open reads to end and a read waits for the COMMIT to finish, neither longer than one
 * statement or one commit. WAL would remove the wait, but every read-only `status` would then create and write
 * `ledger.db-wal` and `-shm`, which plan 3.13 rule 8 forbids. `uninstall --data` relies on the rollback journal too:
 * it does not take a WAL `ledger.db` as snorlax's.
 */
const BUSY_TIMEOUT_MS = 5_000;

const openConnection = (
  sqlite: PlatformSqlite,
  path: string,
  options?: Parameters<PlatformSqlite["open"]>[1]
): SqliteDatabase => {
  const db = sqlite.open(path, options);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
};

/** The ledger could not be opened, or holds a row or scan state this build cannot read. */
export class LedgerUnreadable extends Data.TaggedError("LedgerUnreadable")<{ readonly message: string }> {}

/** SQLite reads `ledger.db`, but the database has no `meta` table, so another program wrote it. */
export class LedgerNotSnorlax extends Data.TaggedError("LedgerNotSnorlax")<{ readonly message: string }> {}

// The ledger rows are unknown data at the read boundary: every table is parsed through a schema, and a row
// this build cannot read fails as `LedgerUnreadable` naming the table (AGENTS.md, plan 3.6).
const metaRowSchema = z.object({
  device_id: z.string(),
  device_name: z.nullable(z.string()),
  last_scan_completed_at: z.nullable(z.number()),
  pull_cursor: z.number(),
  pricing_version: z.nullable(z.string())
});

/** The bucket columns `buckets` and `remote_buckets` share (plan 3.3.2). */
const bucketColumnsSchema = {
  hour: z.number(),
  agent: z.string(),
  model: z.string(),
  input_tokens: z.number(),
  cache_read_tokens: z.number(),
  cache_write_tokens: z.number(),
  output_tokens: z.number(),
  reasoning_tokens: z.number(),
  requests: z.number(),
  sessions_started: z.number(),
  cost_usd: z.number(),
  unpriced_requests: z.number()
};

const bucketRowSchema = z.object({ ...bucketColumnsSchema, dirty: z.number() });
const remoteBucketRowSchema = z.object({ device_id: z.string(), seq: z.number(), ...bucketColumnsSchema });
const sessionSeenRowSchema = z.object({ agent: z.string(), session_id: z.string() });
const remoteDeviceRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  last_push_at: z.nullable(z.number()),
  revoked: z.number()
});
const scanStateRowSchema = z.object({ state: z.string() });
const userVersionSchema = z.object({ user_version: z.number() });

const cannotOpen = (path: string, error: unknown): LedgerUnreadable =>
  new LedgerUnreadable({ message: `cannot open the ledger ${path}: ${errorMessage(error)}` });

const unreadableRow = (path: string, table: string, error: z.core.$ZodError): LedgerUnreadable =>
  new LedgerUnreadable({
    message: `${path}: the ledger's ${table} table holds a row this build cannot read: ${z.prettifyError(error)}`
  });

/** Parses a table's rows, failing on the first row this build cannot read. */
const parseRows = <S extends z.core.$ZodType>(
  path: string,
  table: string,
  schema: S,
  rows: readonly unknown[]
): Effect.Effect<z.output<S>[], LedgerUnreadable> => {
  const parsed: z.output<S>[] = [];
  for (const row of rows) {
    const result = z.safeParse(schema, row);
    if (!result.success) {
      return Effect.fail(unreadableRow(path, table, result.error));
    }
    parsed.push(result.data);
  }
  return Effect.succeed(parsed);
};

const readMeta = (path: string, db: SqliteDatabase): Effect.Effect<LedgerMeta, LedgerUnreadable> =>
  Effect.suspend(() => {
    const row = db.prepare("SELECT * FROM meta WHERE id = 0").get();
    if (row === undefined) {
      return Effect.fail(new LedgerUnreadable({ message: "the ledger's meta row is missing; run snorlax doctor" }));
    }
    const parsed = z.safeParse(metaRowSchema, row);
    if (!parsed.success) {
      return Effect.fail(unreadableRow(path, "meta", parsed.error));
    }
    const meta = parsed.data;
    return Effect.succeed({
      deviceId: meta.device_id,
      deviceName: meta.device_name,
      lastScanCompletedAt: meta.last_scan_completed_at,
      pullCursor: meta.pull_cursor,
      pricingVersion: meta.pricing_version
    });
  });

/** The schema version the database is on (plan 3.3.2). */
const readUserVersion = (path: string, db: SqliteDatabase): Effect.Effect<number, LedgerUnreadable> =>
  Effect.suspend(() => {
    const parsed = z.safeParse(userVersionSchema, db.prepare("PRAGMA user_version").get());
    return parsed.success
      ? Effect.succeed(parsed.data.user_version)
      : Effect.fail(
          new LedgerUnreadable({
            message: `${path}: the ledger's user_version pragma holds a value this build cannot read: ${z.prettifyError(parsed.error)}`
          })
        );
  });

const bucketOf = (bucket: z.output<typeof bucketRowSchema>): BucketRow => ({
  hour: bucket.hour,
  agent: bucket.agent,
  model: bucket.model,
  inputTokens: bucket.input_tokens,
  cacheReadTokens: bucket.cache_read_tokens,
  cacheWriteTokens: bucket.cache_write_tokens,
  outputTokens: bucket.output_tokens,
  reasoningTokens: bucket.reasoning_tokens,
  requests: bucket.requests,
  sessionsStarted: bucket.sessions_started,
  costUsd: bucket.cost_usd,
  unpricedRequests: bucket.unpriced_requests,
  dirty: bucket.dirty !== 0
});

const bucketParams = (bucket: BucketDelta): SqliteValue[] => [
  bucket.hour,
  bucket.agent,
  bucket.model,
  bucket.inputTokens,
  bucket.cacheReadTokens,
  bucket.cacheWriteTokens,
  bucket.outputTokens,
  bucket.reasoningTokens,
  bucket.requests,
  bucket.sessionsStarted,
  bucket.costUsd,
  bucket.unpricedRequests
];

const parseScanState = (path: string, raw: string): Effect.Effect<PersistedScanState, LedgerUnreadable> =>
  Effect.gen(function* () {
    const json = yield* Effect.try({
      try: (): unknown => JSON.parse(raw),
      catch: (error) =>
        new LedgerUnreadable({ message: `${path} holds a scan state that is not JSON: ${errorMessage(error)}` })
    });
    const parsed = z.safeParse(scanStateSchema, json);
    if (!parsed.success) {
      return yield* new LedgerUnreadable({
        message: `${path} holds a scan state this build cannot read: ${z.prettifyError(parsed.error)}`
      });
    }
    // The schema checks every field this collector reads; a cursor's `queue` holds the kit's own records,
    // opaque here and leniently re-parsed by the kit, so the checked shape is widened only at this one cast.
    return parsed.data as PersistedScanState;
  });

/** The saved scan state, `undefined` before the first completed scan. */
const readScanState = (
  path: string,
  db: SqliteDatabase
): Effect.Effect<PersistedScanState | undefined, LedgerUnreadable> =>
  Effect.suspend(() => {
    const row = db.prepare("SELECT state FROM scan_state WHERE id = 0").get();
    if (row === undefined) {
      return Effect.succeed(undefined);
    }
    const parsed = z.safeParse(scanStateRowSchema, row);
    return parsed.success
      ? parseScanState(path, parsed.data.state)
      : Effect.fail(unreadableRow(path, "scan_state", parsed.error));
  });

const ledgerOn = (
  path: string,
  db: SqliteDatabase,
  meta: LedgerMeta,
  scanState: PersistedScanState | undefined
): Ledger => ({
  meta,
  scanState,
  transaction: (body) =>
    Effect.acquireUseRelease(
      Effect.sync(() => db.exec("BEGIN IMMEDIATE")),
      () => Effect.tap(body, () => Effect.sync(() => db.exec("COMMIT"))),
      (_, exit) => (Exit.isSuccess(exit) ? Effect.void : Effect.sync(() => db.exec("ROLLBACK")))
    ),
  addBuckets: (buckets) =>
    Effect.sync(() => {
      const statement = db.prepare(
        `INSERT INTO buckets (${BUCKET_COLUMNS}, dirty) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT (hour, agent, model) DO UPDATE SET
           input_tokens = input_tokens + excluded.input_tokens,
           cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
           cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
           output_tokens = output_tokens + excluded.output_tokens,
           reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
           requests = requests + excluded.requests,
           sessions_started = sessions_started + excluded.sessions_started,
           cost_usd = cost_usd + excluded.cost_usd,
           unpriced_requests = unpriced_requests + excluded.unpriced_requests,
           dirty = 1`
      );
      for (const bucket of buckets) {
        statement.run(...bucketParams(bucket));
      }
    }),
  addSessionsSeen: (sessions) =>
    Effect.sync(() => {
      const statement = db.prepare(
        "INSERT INTO sessions_seen (agent, session_id, first_hour) VALUES (?, ?, ?) ON CONFLICT (agent, session_id) DO NOTHING"
      );
      for (const session of sessions) {
        statement.run(session.agent, session.sessionId, session.firstHour);
      }
    }),
  sessionsSeen: () =>
    Effect.suspend(() =>
      parseRows(
        path,
        "sessions_seen",
        sessionSeenRowSchema,
        db.prepare("SELECT agent, session_id FROM sessions_seen").all()
      )
    ).pipe(
      Effect.map((rows) => {
        const seen = new Map<string, Set<string>>();
        for (const row of rows) {
          const sessions = seen.get(row.agent) ?? new Set<string>();
          sessions.add(row.session_id);
          seen.set(row.agent, sessions);
        }
        return seen;
      })
    ),
  setScanState: (state) =>
    Effect.sync(() => {
      db.prepare(
        "INSERT INTO scan_state (id, state) VALUES (0, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state"
      ).run(JSON.stringify(state));
    }),
  setLastScanCompleted: (atMs) =>
    Effect.sync(() => {
      db.prepare("UPDATE meta SET last_scan_completed_at = ? WHERE id = 0").run(atMs);
    }),
  setPricingVersion: (version) =>
    Effect.sync(() => {
      db.prepare("UPDATE meta SET pricing_version = ? WHERE id = 0").run(version);
    }),
  readBuckets: () =>
    Effect.suspend(() =>
      parseRows(
        path,
        "buckets",
        bucketRowSchema,
        db.prepare(`SELECT ${BUCKET_COLUMNS}, dirty FROM buckets ORDER BY hour, agent, model`).all()
      )
    ).pipe(Effect.map((rows) => rows.map(bucketOf))),
  readRemoteBuckets: () =>
    Effect.suspend(() =>
      parseRows(
        path,
        "remote_buckets",
        remoteBucketRowSchema,
        db
          .prepare(
            `SELECT device_id, seq, ${BUCKET_COLUMNS} FROM remote_buckets ORDER BY device_id, hour, agent, model`
          )
          .all()
      )
    ).pipe(
      Effect.map((rows) =>
        rows.map((bucket): RemoteBucketRow => ({
          deviceId: bucket.device_id,
          seq: bucket.seq,
          hour: bucket.hour,
          agent: bucket.agent,
          model: bucket.model,
          inputTokens: bucket.input_tokens,
          cacheReadTokens: bucket.cache_read_tokens,
          cacheWriteTokens: bucket.cache_write_tokens,
          outputTokens: bucket.output_tokens,
          reasoningTokens: bucket.reasoning_tokens,
          requests: bucket.requests,
          sessionsStarted: bucket.sessions_started,
          costUsd: bucket.cost_usd,
          unpricedRequests: bucket.unpriced_requests
        }))
      )
    ),
  readRemoteDevices: () =>
    Effect.suspend(() =>
      parseRows(
        path,
        "remote_devices",
        remoteDeviceRowSchema,
        db.prepare("SELECT id, name, last_push_at, revoked FROM remote_devices").all()
      )
    ).pipe(
      Effect.map((rows) =>
        rows.map((device): RemoteDeviceRow => ({
          id: device.id,
          name: device.name,
          lastPushAt: device.last_push_at,
          revoked: device.revoked !== 0
        }))
      )
    ),
  zeroBucketsFrom: (startHour) =>
    Effect.sync(() => {
      db.prepare(
        `UPDATE buckets SET
           input_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0, output_tokens = 0,
           reasoning_tokens = 0, requests = 0, sessions_started = 0, cost_usd = 0, unpriced_requests = 0,
           dirty = 1
         WHERE hour >= ?`
      ).run(startHour);
    }),
  deleteSessionsSeenFrom: (startHour) =>
    Effect.sync(() => {
      db.prepare("DELETE FROM sessions_seen WHERE first_hour >= ?").run(startHour);
    })
});

/**
 * Opens (creating on first run) `<data>/ledger.db` for the rest of the scope, migrates it to `SCHEMA_VERSION`
 * with a backup first, and makes sure the `meta` row with its device id exists. The device id is generated once
 * per data directory and never derived from the host name (plan 2.4 D7). The connection closes with the scope.
 */
export const openLedger = (
  platform: LedgerPlatform,
  dataDir: string
): Effect.Effect<Ledger, LedgerUnreadable | LedgerSchemaTooNew | LedgerBackupFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const path = ledgerPath(dataDir);
    const existing = yield* Effect.promise(() => platform.fs.stat(path));
    const db = yield* Effect.acquireRelease(
      Effect.try({ try: () => openConnection(platform.sqlite, path), catch: (error) => cannotOpen(path, error) }),
      (opened) => Effect.sync(() => opened.close())
    );
    return yield* Effect.gen(function* () {
      const from = yield* readUserVersion(path, db);
      yield* prepareMigrations(platform.fs, dataDir, path, db, from, existing?.kind === "file");
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT OR IGNORE INTO meta (id, device_id) VALUES (0, ?)").run(randomUUID());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      const meta = yield* readMeta(path, db);
      const scanState = yield* readScanState(path, db);
      return ledgerOn(path, db, meta, scanState);
    }).pipe(
      // A SQLite statement that throws while the ledger is being opened means it cannot be opened.
      Effect.catchDefect((defect) => Effect.fail(cannotOpen(path, defect)))
    );
  });

/**
 * The part of `meta` that `status` reports, read without taking the ledger lock or migrating anything; null when
 * there is no ledger yet. `pricingChanged` says the buckets were priced with another table than this build's
 * (plan 3.7); a ledger that records no version yet has not been priced, so it has not changed. `uninstall --data` reads it as the snorlax marker. A `stat` that throws is a defect; a
 * ledger that cannot be opened, or whose meta row cannot be read, is `LedgerUnreadable`, as in `openLedger`; a
 * database SQLite reads without a `meta` table is `LedgerNotSnorlax`.
 */
export const readLedgerStatus = (
  platform: Pick<Platform, "fs"> & { readonly sqlite?: PlatformSqlite },
  dataDir: string
): Effect.Effect<
  { readonly deviceId: string; readonly lastScanCompletedAt: number | null; readonly pricingChanged: boolean } | null,
  LedgerUnreadable | LedgerNotSnorlax
> =>
  Effect.gen(function* () {
    const path = ledgerPath(dataDir);
    const existing = yield* Effect.promise(() => platform.fs.stat(path));
    const { sqlite } = platform;
    if (existing === undefined || sqlite === undefined) {
      return null;
    }
    const meta = yield* Effect.acquireUseRelease(
      Effect.try({
        try: () => openConnection(sqlite, path, { readonly: true }),
        catch: (error) => cannotOpen(path, error)
      }),
      (db) =>
        Effect.gen(function* () {
          if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() === undefined) {
            return yield* Effect.fail(
              new LedgerNotSnorlax({ message: `${path} is not a snorlax ledger: it has no meta table` })
            );
          }
          return yield* readMeta(path, db);
        }).pipe(
          // A statement that throws while meta is read means the ledger cannot be read.
          Effect.catchDefect((defect) =>
            Effect.fail(new LedgerUnreadable({ message: `cannot read the ledger ${path}: ${errorMessage(defect)}` }))
          )
        ),
      (db) => Effect.sync(() => db.close())
    );
    return {
      deviceId: meta.deviceId,
      lastScanCompletedAt: meta.lastScanCompletedAt,
      pricingChanged: meta.pricingVersion !== null && meta.pricingVersion !== PRICING_VERSION
    };
  });

/** The platform has no SQLite, which the ledger needs. */
export class LedgerPlatformUnsupported extends Data.TaggedError("LedgerPlatformUnsupported")<{
  readonly message: string;
}> {}

/** What a refresh or rebuild runs on, besides the window it scans. */
export interface ScanAndCommitDeps {
  readonly platform: Platform;
  readonly dataDir: string;
  readonly log: Logger;
  /** IANA time zone of this device; the snapshot's day windows follow it (plan 3.2.2). */
  readonly timeZone: string;
}

/** What a command adds to the shared run: where its scan starts and the summary line it logs. */
export interface ScanRun {
  /** The summary line's event name; `fields` come before the shared ones (rebuild's `days`). */
  readonly event: string;
  readonly fields?: Readonly<Record<string, LogFieldValue>>;
  /** The scan's window, from the ledger as opened under the lock and the run's wall-clock time. */
  readonly window: (ledger: Ledger, now: number) => ScanWindow;
}

export interface ScanAndCommitOutcome {
  readonly result: RefreshResult;
  readonly failuresByAgent: Record<string, number>;
}

/**
 * One refresh or rebuild over the ledger (plan 3.4.1 steps 2–8, minus the sync of step 6 that arrives with
 * Batch 7): take the ledger lock, open the ledger under it, scan the command's window and commit buckets and
 * scan state in one transaction, then build and atomically write the snapshot and log the summary line. Opening
 * under the lock puts the migration, the meta write and the read of meta and scan state after the previous
 * run's commit, so two overlapping runs queue instead of the second reading the first's pre-commit state. The
 * lock and the ledger are held in a scope, so a run that fails or is interrupted rolls back, closes the ledger
 * and releases the lock. The scan result stays committed even when the snapshot write fails; the next run
 * rewrites the snapshot.
 */
export const scanAndCommit = (
  deps: ScanAndCommitDeps,
  run: ScanRun
): Effect.Effect<
  ScanAndCommitOutcome,
  | LedgerPlatformUnsupported
  | LedgerLockHeld
  | LedgerUnreadable
  | LedgerSchemaTooNew
  | LedgerBackupFailed
  | ConfigInvalid
  | SnapshotWriteFailed
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const { platform, dataDir } = deps;
      const { sqlite } = platform;
      if (sqlite === undefined) {
        return yield* new LedgerPlatformUnsupported({
          message: "this platform has no SQLite; the ledger cannot run here"
        });
      }
      const startedAt = platform.clock.monotonic();
      yield* holdLedgerLock(platform, dataDir);
      const now = platform.clock.now();
      const ledger = yield* openLedger({ fs: platform.fs, sqlite }, dataDir);
      const scanned = yield* commitScan(platform, ledger, run.window(ledger, now), now);
      const config = yield* readConfig(platform, dataDir);
      const snapshot = buildSnapshot({
        now,
        timeZone: deps.timeZone,
        thisDevice: { id: ledger.meta.deviceId, name: config.deviceName ?? null },
        buckets: yield* ledger.readBuckets(),
        remoteBuckets: yield* ledger.readRemoteBuckets(),
        remoteDevices: yield* ledger.readRemoteDevices(),
        lastScanAt: now,
        failuresByAgent: scanned.failuresByAgent,
        paired: false
      });
      yield* writeSnapshot(platform, dataDir, snapshot);
      yield* deps.log.event(run.event, {
        ...run.fields,
        records: scanned.records,
        failures: scanned.failures,
        pushed: 0,
        pulled: 0,
        durationMs: Math.round(platform.clock.monotonic() - startedAt)
      });
      return {
        result: {
          schemaVersion: 1,
          ok: true,
          scannedAt: new Date(now).toISOString(),
          records: scanned.records,
          failures: scanned.failures,
          // Not paired in this milestone: the sync fields say no sync ran (Batch 7 pairs a backend).
          sync: { ok: false, pushed: 0, pulled: 0 }
        },
        failuresByAgent: scanned.failuresByAgent
      };
    })
  );

export { LedgerBackupFailed, LedgerLockHeld, LedgerSchemaTooNew, SCHEMA_VERSION };
