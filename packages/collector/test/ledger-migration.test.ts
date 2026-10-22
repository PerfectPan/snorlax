import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createNodePlatform } from "@rivus/agent-kit/node";

import { CliError } from "../src/cli/errors.ts";
import { listBackups, SCHEMA_VERSION } from "../src/ledger/migrations.ts";
import { ledgerPath, openLedger } from "../src/ledger/ledger.ts";

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

const open = () => openLedger(platform, dataDir);

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
    try {
      expect(userVersion()).toBe(SCHEMA_VERSION);
      expect(ledger.meta.deviceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(ledger.meta.lastScanCompletedAt).toBe(null);
      expect(ledger.meta.pullCursor).toBe(0);
      expect(ledger.meta.pricingVersion).toBe(null);
    } finally {
      ledger.close();
    }
    expect(await listBackups(platform.fs, dataDir)).toEqual([]);
  });

  it("keeps the device id and the schema version on reopening", async () => {
    const first = await open();
    const deviceId = first.meta.deviceId;
    first.close();

    const second = await open();
    try {
      expect(second.meta.deviceId).toBe(deviceId);
      expect(userVersion()).toBe(SCHEMA_VERSION);
    } finally {
      second.close();
    }
    expect(await listBackups(platform.fs, dataDir)).toEqual([]);
  });
});

describe("a database on an older schema version", () => {
  it("is backed up as bak-v<old> and migrated with its data intact", async () => {
    const ledger = await open();
    const deviceId = ledger.meta.deviceId;
    await ledger.transaction(() => {
      ledger.addBuckets([
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
      ]);
    });
    ledger.close();

    // A database that predates version bookkeeping sits on `user_version` 0 with its tables in place.
    setUserVersion(0);
    const migrated = await open();
    try {
      expect(userVersion()).toBe(SCHEMA_VERSION);
      expect(migrated.meta.deviceId).toBe(deviceId);
      expect(migrated.readBuckets()).toHaveLength(1);
    } finally {
      migrated.close();
    }
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

describe("a database from a newer build", () => {
  it("refuses to open instead of downgrading", async () => {
    setUserVersion(SCHEMA_VERSION + 1);
    await expect(open()).rejects.toThrow(/newer snorlax/);
    await expect(open()).rejects.toBeInstanceOf(CliError);
    expect(userVersion()).toBe(SCHEMA_VERSION + 1);
  });
});
