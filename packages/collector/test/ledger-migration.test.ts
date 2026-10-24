import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";

import { createNodePlatform } from "@rivus/agent-kit/node";

import { listBackups, SCHEMA_VERSION } from "../src/modules/ledger/migrations.ts";
import { ledgerPath, LedgerSchemaTooNew, readLedgerStatus } from "../src/modules/ledger/ledger.ts";
import { readLedger } from "./fixtures/flows.ts";

/**
 * The ledger's forward-only migrations and backups (plan 3.3.2, 5.3): a fresh data directory creates the
 * schema without a backup, a database on an older `user_version` is backed up to
 * `ledger.db.bak-v<old>` and migrated with its data intact, only the latest two backups are kept, and a
 * newer schema refuses to open. A real temporary directory with the Node platform; no agent home is read.
 */

let dataDir: string;

const nodePlatform = createNodePlatform({
  home: "/tmp",
  env: { PATH: "/usr/bin:/bin" }
});
const { fs, sqlite } = nodePlatform;
if (sqlite === undefined) {
  throw new Error("the agent-kit Node platform must provide SQLite");
}
const platform = { fs, sqlite };

const open = () => readLedger(platform, dataDir, Effect.succeed);

const userVersion = (): number => {
  const db = new DatabaseSync(ledgerPath(dataDir));
  try {
    return Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  } finally {
    db.close();
  }
};

const setUserVersion = (version: number): void => {
  const db = new DatabaseSync(ledgerPath(dataDir));
  try {
    db.exec(`PRAGMA user_version = ${version}`);
  } finally {
    db.close();
  }
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "snorlax-migrate-"));
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("a fresh data directory", () => {
  it("creates the schema, a device id and no backup", async () => {
    const ledger = await open();
    expect(userVersion()).toBe(SCHEMA_VERSION);
    expect(ledger.meta.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(ledger.meta.lastScanCompletedAt).toBe(null);
    expect(ledger.meta.pullCursor).toBe(0);
    expect(ledger.meta.pricingVersion).toBe(null);
    expect(await listBackups(platform.fs, dataDir)).toEqual([]);
  });

  it("keeps the device id and the schema version on reopening", async () => {
    const first = await open();
    const deviceId = first.meta.deviceId;

    const second = await open();
    expect(second.meta.deviceId).toBe(deviceId);
    expect(userVersion()).toBe(SCHEMA_VERSION);
    expect(await listBackups(platform.fs, dataDir)).toEqual([]);
  });
});

describe("a database on an older schema version", () => {
  it("is backed up as bak-v<old> and migrated with its data intact", async () => {
    const ledger = await readLedger(platform, dataDir, (opened) =>
      Effect.as(
        opened.transaction(
          opened.addBuckets([
            {
              hour: Date.UTC(2026, 9, 22, 9) / 1000,
              agent: "claude-code",
              model: "claude-opus-5-5",
              inputTokens: 100,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 5,
              reasoningTokens: 0,
              requests: 1,
              sessionsStarted: 1,
              costUsd: 0,
              unpricedRequests: 1
            }
          ])
        ),
        opened
      )
    );
    const deviceId = ledger.meta.deviceId;

    // A database that predates version bookkeeping sits on `user_version` 0 with its tables in place.
    setUserVersion(0);
    const migrated = await readLedger(platform, dataDir, (opened) =>
      Effect.map(opened.readBuckets(), (buckets) => ({ meta: opened.meta, buckets }))
    );
    expect(userVersion()).toBe(SCHEMA_VERSION);
    expect(migrated.meta.deviceId).toBe(deviceId);
    expect(migrated.buckets).toHaveLength(1);
    expect((await listBackups(platform.fs, dataDir)).map((backup) => backup.version)).toEqual([0]);
  });

  it("keeps only the two newest backups by version", async () => {
    for (const version of [1, 2]) {
      await writeFile(join(dataDir, `ledger.db.bak-v${version}`), "old backup");
    }
    setUserVersion(0);

    await open();
    // Versions 1 and 2 outrank the new bak-v0, so rotation drops it; backups sort by version.
    expect((await listBackups(platform.fs, dataDir)).map((backup) => backup.version)).toEqual([1, 2]);
  });
});

describe("the persisted scan state", () => {
  it("keeps fields this build does not know, at the top and inside a source", async () => {
    await readLedger(platform, dataDir, (ledger) =>
      ledger.setScanState({
        sources: {
          "a.jsonl": { agent: "claude-code", path: "a.jsonl", mtimeMs: 1, futureSourceField: true }
        },
        requests: {},
        futureStateField: "kept"
      })
    );

    // A newer kit reads its own added fields back out of the state this build persisted (plan 3.7).
    const reopened = await open();
    expect(reopened.scanState).toMatchObject({
      futureStateField: "kept",
      sources: { "a.jsonl": { futureSourceField: true } }
    });
  });
});

describe("a meta row this build cannot read", () => {
  it('fails as data-dir instead of coercing a NULL device id into the string "null"', async () => {
    // The schema forbids a NULL device id, so a row that has one stands for corruption or a foreign
    // writer: rebuild the table without the constraint to plant the row.
    const db = new DatabaseSync(ledgerPath(dataDir));
    try {
      db.exec(`CREATE TABLE meta_loose (
         id                     INTEGER PRIMARY KEY CHECK (id = 0),
         device_id              TEXT,
         device_name            TEXT,
         last_scan_completed_at INTEGER,
         pull_cursor            INTEGER NOT NULL DEFAULT 0,
         pricing_version        TEXT
       )`);
      db.exec("INSERT INTO meta_loose SELECT * FROM meta");
      db.exec("DROP TABLE meta");
      db.exec("ALTER TABLE meta_loose RENAME TO meta");
      db.exec("UPDATE meta SET device_id = NULL");
    } finally {
      db.close();
    }
    await expect(open()).rejects.toMatchObject({ _tag: "LedgerUnreadable", message: expect.stringMatching(/meta/) });
  });
});

describe("a database from a newer build", () => {
  it("refuses to open instead of downgrading", async () => {
    setUserVersion(SCHEMA_VERSION + 1);
    await expect(open()).rejects.toThrow(/newer snorlax/);
    await expect(open()).rejects.toBeInstanceOf(LedgerSchemaTooNew);
    expect(userVersion()).toBe(SCHEMA_VERSION + 1);
  });

  it("reports a ledger whose sqlite cannot be opened as data-dir, naming the path", async () => {
    const brokenPlatform = {
      fs,
      sqlite: {
        open: () => {
          throw new Error("sqlite cannot open the file");
        }
      }
    };
    await expect(readLedger(brokenPlatform, dataDir, Effect.succeed)).rejects.toMatchObject({
      _tag: "LedgerUnreadable",
      message: expect.stringMatching(/ledger\.db/)
    });
  });
});

describe("a value or an open this build cannot handle, on a ledger of its own", () => {
  let own: string;

  beforeEach(async () => {
    own = await mkdtemp(join(tmpdir(), "snorlax-unreadable-"));
    await readLedger(platform, own, Effect.succeed);
  });

  afterEach(async () => {
    await rm(own, { recursive: true, force: true });
  });

  it("fails a scan_state row that is not text as data-dir, naming the table", async () => {
    const db = new DatabaseSync(ledgerPath(own));
    try {
      // The bytes of "{}" stored as a blob: the column's text affinity keeps a blob a blob.
      db.exec("INSERT INTO scan_state (id, state) VALUES (0, x'7b7d')");
    } finally {
      db.close();
    }
    await expect(readLedger(platform, own, Effect.succeed)).rejects.toMatchObject({
      _tag: "LedgerUnreadable",
      message: expect.stringMatching(/scan_state table holds a row this build cannot read/)
    });
  });

  it("fails a user_version that is not a number as data-dir, naming the pragma", async () => {
    // SQLite itself always answers with an integer; a connection that answers with text stands in for a
    // driver or file that does not.
    const textVersion: typeof sqlite = {
      open: (path, options) => {
        const db = sqlite.open(path, options);
        return {
          exec: (sql) => db.exec(sql),
          close: () => db.close(),
          prepare: (sql) => {
            const statement = db.prepare(sql);
            return sql === "PRAGMA user_version"
              ? {
                  run: (...params) => statement.run(...params),
                  get: () => ({ user_version: String(SCHEMA_VERSION) }),
                  all: (...params) => statement.all(...params)
                }
              : statement;
          }
        };
      }
    };
    await expect(readLedger({ fs, sqlite: textVersion }, own, Effect.succeed)).rejects.toMatchObject({
      _tag: "LedgerUnreadable",
      message: expect.stringMatching(/user_version pragma holds a value this build cannot read/)
    });
  });

  it("reports a ledger that status cannot open as data-dir, naming the path", async () => {
    const unopenable: typeof sqlite = {
      open: () => {
        throw new Error("unable to open database file");
      }
    };
    await expect(Effect.runPromise(readLedgerStatus({ fs, sqlite: unopenable }, own))).rejects.toMatchObject({
      _tag: "LedgerUnreadable",
      message: expect.stringMatching(/^cannot open the ledger .*ledger\.db: unable to open database file$/)
    });
  });
});
