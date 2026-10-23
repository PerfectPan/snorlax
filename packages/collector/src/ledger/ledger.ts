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

// The ledger rows are unknown data at the read boundary: every table is parsed through a schema, and a row
// this build cannot read fails as `data-dir` naming the table (AGENTS.md, plan 3.6).
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

const parseRow = <S extends z.core.$ZodType>(path: string, table: string, schema: S, row: unknown): z.output<S> => {
  const parsed = z.safeParse(schema, row);
  if (!parsed.success) {
    throw new CliError(
      "data-dir",
      `${path}: the ledger's ${table} table holds a row this build cannot read: ${z.prettifyError(parsed.error)}`
    );
  }
  return parsed.data;
};

const readMeta = (path: string, db: SqliteDatabase): LedgerMeta => {
  const row = db.prepare("SELECT * FROM meta WHERE id = 0").get();
  if (row === undefined) {
    throw new CliError("data-dir", "the ledger's meta row is missing; run snorlax doctor");
  }
  const meta = parseRow(path, "meta", metaRowSchema, row);
  return {
    deviceId: meta.device_id,
    deviceName: meta.device_name,
    lastScanCompletedAt: meta.last_scan_completed_at,
    pullCursor: meta.pull_cursor,
    pricingVersion: meta.pricing_version
  };
};

const bucketOf = (path: string, row: unknown): BucketRow => {
  const bucket = parseRow(path, "buckets", bucketRowSchema, row);
  return {
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
  };
};

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
  let db: SqliteDatabase;
  try {
    db = platform.sqlite.open(path);
  } catch (error) {
    throw new CliError("data-dir", `cannot open the ledger ${path}: ${errorMessage(error)}`);
  }
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
    meta = readMeta(path, db);
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
      const rows = db.prepare("SELECT agent, session_id FROM sessions_seen").all();
      for (const row of rows.map((row) => parseRow(path, "sessions_seen", sessionSeenRowSchema, row))) {
        const sessions = seen.get(row.agent) ?? new Set<string>();
        sessions.add(row.session_id);
        seen.set(row.agent, sessions);
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
      return db
        .prepare(`SELECT ${BUCKET_COLUMNS}, dirty FROM buckets ORDER BY hour, agent, model`)
        .all()
        .map((row) => bucketOf(path, row));
    },
    readRemoteBuckets(): RemoteBucketRow[] {
      return db
        .prepare(`SELECT device_id, seq, ${BUCKET_COLUMNS} FROM remote_buckets ORDER BY device_id, hour, agent, model`)
        .all()
        .map((row): RemoteBucketRow => {
          const bucket = parseRow(path, "remote_buckets", remoteBucketRowSchema, row);
          return {
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
          };
        });
    },
    readRemoteDevices(): RemoteDeviceRow[] {
      return db
        .prepare("SELECT id, name, last_push_at, revoked FROM remote_devices")
        .all()
        .map((row): RemoteDeviceRow => {
          const device = parseRow(path, "remote_devices", remoteDeviceRowSchema, row);
          return {
            id: device.id,
            name: device.name,
            lastPushAt: device.last_push_at,
            revoked: device.revoked !== 0
          };
        });
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
    const meta = readMeta(path, db);
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
