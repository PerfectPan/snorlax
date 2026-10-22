import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type { Platform } from "@rivus/agent-kit/platform";
import type { UsageRecord } from "@rivus/agent-kit/transcript/usage";
import * as z from "zod/mini";

import { CliError } from "../cli/errors.ts";
import { errorMessage } from "../util/error-message.ts";
import { MigrationError, prepareMigrations, SCHEMA_VERSION } from "./migrations.ts";
import type { PlatformSqlite, SqliteDatabase, SqliteValue } from "./sqlite.ts";

/** One local bucket row: the protocol's bucket fields plus the `dirty` upload flag (plan 3.3.2). */
export interface BucketRow {
  readonly hour: number;
  readonly agent: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly requests: number;
  readonly sessionsStarted: number;
  readonly costUsd: number;
  readonly unpricedRequests: number;
  readonly dirty: boolean;
}

/** What a scan adds to one bucket before it is written; `dirty` is always set on write. */
export type BucketDelta = Omit<BucketRow, "dirty">;

/** One `remote_buckets` row as pulled from the backend; empty until sync arrives (Batch 7). */
export interface RemoteBucketRow extends Omit<BucketRow, "dirty"> {
  readonly deviceId: string;
  readonly seq: number;
}

/** One `remote_devices` row. */
export interface RemoteDeviceRow {
  readonly id: string;
  readonly name: string;
  readonly lastPushAt: number | null;
  readonly revoked: boolean;
}

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

const scanCursorSchema = z.object({
  agent: z.string(),
  offset: z.number(),
  line: z.number(),
  state: z.optional(z.unknown()),
  queue: z.optional(z.array(z.unknown()))
});

const scanStateSchema = z.object({
  sources: z.record(
    z.string(),
    z.object({
      agent: z.string(),
      path: z.string(),
      mtimeMs: z.number(),
      cursor: z.optional(scanCursorSchema),
      mark: z.optional(z.object({ time: z.number(), count: z.number() }))
    })
  ),
  requests: z.record(z.string(), z.record(z.string(), z.string()))
});

/**
 * The open ledger. Every method runs on the one connection opened in `openLedger`; the multi-statement
 * writes of a refresh run inside `transaction`, so a run that dies mid-way leaves the database as it was
 * (Spec S3).
 */
export interface Ledger {
  readonly db: SqliteDatabase;
  readonly meta: LedgerMeta;
  /** The saved scan state, `undefined` before the first completed scan. */
  readonly scanState: PersistedScanState | undefined;
  /**
   * Runs `body` between `BEGIN IMMEDIATE` and `COMMIT`, rolling back on any throw. The body may await
   * between statements (the refresh scan iterates inside it); nothing else may write meanwhile, which the
   * ledger lock guarantees.
   */
  transaction<T>(body: () => T | Promise<T>): Promise<T>;
  /** Adds each bucket's numbers into its row and marks the row dirty (absolute totals, plan 3.3.1). */
  addBuckets(buckets: readonly BucketDelta[]): void;
  /** Records sessions first seen in this run; a row that exists already is ignored. */
  addSessionsSeen(sessions: readonly { agent: string; sessionId: string; firstHour: number }[]): void;
  /** Every (agent, session id) the ledger has already counted a session start for. */
  sessionsSeen(): Map<string, Set<string>>;
  setScanState(state: unknown): void;
  setLastScanCompleted(atMs: number): void;
  readBuckets(): BucketRow[];
  readRemoteBuckets(): RemoteBucketRow[];
  readRemoteDevices(): RemoteDeviceRow[];
  /** Zeroes every bucket at or after `startHour` and marks it dirty, for `rebuild` (plan 3.4.3). */
  zeroBucketsFrom(startHour: number): void;
  /** Drops session-first-seen rows at or after `startHour`, so a rescan counts those sessions again. */
  deleteSessionsSeenFrom(startHour: number): void;
  close(): void;
}

export const ledgerPath = (dataDir: string): string => join(dataDir, "ledger.db");

const readMeta = (db: SqliteDatabase): LedgerMeta => {
  const row = db.prepare("SELECT * FROM meta WHERE id = 0").get();
  if (row === undefined) {
    throw new CliError("data-dir", "the ledger's meta row is missing; run snorlax doctor");
  }
  return {
    deviceId: String(row.device_id),
    deviceName: row.device_name === null || row.device_name === undefined ? null : String(row.device_name),
    lastScanCompletedAt:
      row.last_scan_completed_at === null || row.last_scan_completed_at === undefined
        ? null
        : Number(row.last_scan_completed_at),
    pullCursor: Number(row.pull_cursor ?? 0),
    pricingVersion:
      row.pricing_version === null || row.pricing_version === undefined ? null : String(row.pricing_version)
  };
};

const bucketOf = (row: Record<string, unknown>): BucketRow => ({
  hour: Number(row.hour),
  agent: String(row.agent),
  model: String(row.model),
  inputTokens: Number(row.input_tokens),
  cacheReadTokens: Number(row.cache_read_tokens),
  cacheWriteTokens: Number(row.cache_write_tokens),
  outputTokens: Number(row.output_tokens),
  reasoningTokens: Number(row.reasoning_tokens),
  requests: Number(row.requests),
  sessionsStarted: Number(row.sessions_started),
  costUsd: Number(row.cost_usd),
  unpricedRequests: Number(row.unpriced_requests),
  dirty: Number(row.dirty) !== 0
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

const parseScanState = (path: string, raw: string): PersistedScanState => {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new CliError("data-dir", `${path} holds a scan state that is not JSON: ${errorMessage(error)}`);
  }
  const parsed = z.safeParse(scanStateSchema, json);
  if (!parsed.success) {
    throw new CliError(
      "data-dir",
      `${path} holds a scan state this build cannot read: ${z.prettifyError(parsed.error)}`
    );
  }
  // The schema checks every field this collector reads; a cursor's `queue` holds the kit's own records,
  // opaque here and leniently re-parsed by the kit, so the checked shape is widened only at this one cast.
  return parsed.data as PersistedScanState;
};

/**
 * Opens (creating on first run) `<data>/ledger.db`, migrates it to `SCHEMA_VERSION` with a backup first,
 * and makes sure the `meta` row with its device id exists. The device id is generated once per data
 * directory and never derived from the host name (plan 2.4 D7).
 */
export async function openLedger(platform: LedgerPlatform, dataDir: string): Promise<Ledger> {
  const path = ledgerPath(dataDir);
  const existing = await platform.fs.stat(path);
  const db = platform.sqlite.open(path);
  let meta: LedgerMeta;
  let scanState: PersistedScanState | undefined;
  try {
    await prepareMigrations(platform.fs, dataDir, path, db, existing?.kind === "file");
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT OR IGNORE INTO meta (id, device_id) VALUES (0, ?)").run(randomUUID());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    meta = readMeta(db);
    const saved = db.prepare("SELECT state FROM scan_state WHERE id = 0").get();
    scanState = saved === undefined ? undefined : parseScanState(path, String(saved.state));
  } catch (error) {
    db.close();
    if (error instanceof CliError) {
      throw error;
    }
    const detail =
      error instanceof MigrationError ? error.message : `cannot open the ledger ${path}: ${errorMessage(error)}`;
    throw new CliError("data-dir", detail);
  }

  return {
    db,
    meta,
    scanState,
    async transaction<T>(body: () => T | Promise<T>): Promise<T> {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = await body();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    addBuckets(buckets) {
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
    },
    addSessionsSeen(sessions) {
      const statement = db.prepare(
        "INSERT INTO sessions_seen (agent, session_id, first_hour) VALUES (?, ?, ?) ON CONFLICT (agent, session_id) DO NOTHING"
      );
      for (const session of sessions) {
        statement.run(session.agent, session.sessionId, session.firstHour);
      }
    },
    sessionsSeen(): Map<string, Set<string>> {
      const seen = new Map<string, Set<string>>();
      for (const row of db.prepare("SELECT agent, session_id FROM sessions_seen").all()) {
        const agent = String(row.agent);
        const sessions = seen.get(agent) ?? new Set<string>();
        sessions.add(String(row.session_id));
        seen.set(agent, sessions);
      }
      return seen;
    },
    setScanState(state) {
      db.prepare(
        "INSERT INTO scan_state (id, state) VALUES (0, ?) ON CONFLICT (id) DO UPDATE SET state = excluded.state"
      ).run(JSON.stringify(state));
    },
    setLastScanCompleted(atMs) {
      db.prepare("UPDATE meta SET last_scan_completed_at = ? WHERE id = 0").run(atMs);
    },
    readBuckets(): BucketRow[] {
      return db.prepare(`SELECT ${BUCKET_COLUMNS}, dirty FROM buckets ORDER BY hour, agent, model`).all().map(bucketOf);
    },
    readRemoteBuckets(): RemoteBucketRow[] {
      return db
        .prepare(`SELECT device_id, seq, ${BUCKET_COLUMNS} FROM remote_buckets ORDER BY device_id, hour, agent, model`)
        .all()
        .map((row) => ({ ...bucketOf({ ...row, dirty: 0 }), deviceId: String(row.device_id), seq: Number(row.seq) }));
    },
    readRemoteDevices(): RemoteDeviceRow[] {
      return db
        .prepare("SELECT id, name, last_push_at, revoked FROM remote_devices")
        .all()
        .map((row) => ({
          id: String(row.id),
          name: String(row.name),
          lastPushAt: row.last_push_at === null || row.last_push_at === undefined ? null : Number(row.last_push_at),
          revoked: Number(row.revoked) !== 0
        }));
    },
    zeroBucketsFrom(startHour) {
      db.prepare(
        `UPDATE buckets SET
           input_tokens = 0, cache_read_tokens = 0, cache_write_tokens = 0, output_tokens = 0,
           reasoning_tokens = 0, requests = 0, sessions_started = 0, cost_usd = 0, unpriced_requests = 0,
           dirty = 1
         WHERE hour >= ?`
      ).run(startHour);
    },
    deleteSessionsSeenFrom(startHour) {
      db.prepare("DELETE FROM sessions_seen WHERE first_hour >= ?").run(startHour);
    },
    close() {
      db.close();
    }
  };
}

/** The part of `meta` that `status` reports, read without taking the ledger lock or migrating anything. */
export async function readLedgerStatus(
  platform: Pick<Platform, "fs"> & { readonly sqlite?: PlatformSqlite },
  dataDir: string
): Promise<{ readonly deviceId: string; readonly lastScanCompletedAt: number | null } | null> {
  const path = ledgerPath(dataDir);
  if ((await platform.fs.stat(path)) === undefined || platform.sqlite === undefined) {
    return null;
  }
  const db = platform.sqlite.open(path, { readonly: true });
  try {
    const meta = readMeta(db);
    return { deviceId: meta.deviceId, lastScanCompletedAt: meta.lastScanCompletedAt };
  } catch (error) {
    throw error instanceof CliError
      ? error
      : new CliError("data-dir", `cannot read the ledger ${path}: ${errorMessage(error)}`);
  } finally {
    db.close();
  }
}

export { SCHEMA_VERSION };
