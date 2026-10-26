import { describe, expect, it } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import * as z from "zod/mini";

import { applyMigrations, createTestBackend } from "../test/fixtures/backend.ts";
import { SqliteD1Error, createSqliteD1 } from "./sqlite-d1.ts";

const countRows = (database: DatabaseSync, table: "devices" | "buckets"): number =>
  z.parse(z.object({ n: z.int() }), database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n;

/**
 * The node:sqlite adapter as production code: statement binding and results, real change counts for
 * writes, per-statement results inside a batch (the push's sequence assignment reads the batch's first
 * statement), and the batch's all-or-nothing transaction that never loses the original error.
 */

describe("statements", () => {
  it("binds values, returns rows from first and all, and never mutates the bound receiver", async () => {
    const { database } = createTestBackend();
    const db = createSqliteD1(database);
    const insert = db
      .prepare("INSERT INTO devices (id, name, token_sha256, created_at) VALUES (?1, ?2, ?3, ?4)")
      .bind("6f1c8d2e-4a3b-4c5d-9e6f-7a8b9c0d1e2f", "Device A", "hash-a", 1);
    await insert.run();

    // The receiver stays unbound; bind returns a new statement.
    const byHash = db.prepare("SELECT id, name FROM devices WHERE token_sha256 = ?1");
    expect(await byHash.bind("hash-a").first()).toEqual({
      id: "6f1c8d2e-4a3b-4c5d-9e6f-7a8b9c0d1e2f",
      name: "Device A"
    });
    expect(await byHash.first()).toBeNull();
    expect((await byHash.bind("hash-a").all()).results).toHaveLength(1);
    expect((await byHash.bind("hash-a").all()).meta).toEqual({ changes: 0 });
  });

  it("reports real change counts for writes, including one a guard stops from firing", async () => {
    const { database } = createTestBackend();
    const db = createSqliteD1(database);
    const insertDevice = db
      .prepare("INSERT INTO devices (id, name, token_sha256, created_at) VALUES (?1, ?2, ?3, ?4)")
      .bind("6f1c8d2e-4a3b-4c5d-9e6f-7a8b9c0d1e2f", "Device A", "hash-a", 1);
    expect((await insertDevice.run()).meta.changes).toBe(1);

    const touch = db
      .prepare("UPDATE devices SET name = name WHERE id = ?1")
      .bind("6f1c8d2e-4a3b-4c5d-9e6f-7a8b9c0d1e2f");
    expect((await touch.run()).meta.changes).toBe(1);

    // The guarded overwrite is what registration's 409 rests on: an active device fails the guard, so
    // the statement changes nothing even though the id conflicts.
    const guarded = db
      .prepare(
        "INSERT INTO devices (id, name, token_sha256, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (id) DO UPDATE SET name = excluded.name WHERE devices.revoked_at IS NOT NULL"
      )
      .bind("6f1c8d2e-4a3b-4c5d-9e6f-7a8b9c0d1e2f", "Other", "hash-b", 5);
    expect((await guarded.run()).meta.changes).toBe(0);

    // The same counts inside a batch.
    const batch = await db.batch([
      db
        .prepare("INSERT INTO devices (id, name, token_sha256, created_at) VALUES (?1, ?2, ?3, ?4)")
        .bind("0b2a4d6c-8e9f-4a1b-b3c5-d7e9f0a1b2c3", "Device B", "hash-c", 6),
      guarded
    ]);
    expect(batch.map((result) => result.meta.changes)).toEqual([1, 0]);
  });

  it("wraps statement failures in SqliteD1Error with the sqlite3 cause", async () => {
    const { database } = createTestBackend();
    const db = createSqliteD1(database);
    const failing = db
      .prepare("INSERT INTO devices (id, name, token_sha256, created_at) VALUES (?1, ?2, ?3, ?4)")
      .bind("6f1c8d2e-4a3b-4c5d-9e6f-7a8b9c0d1e2f", "Device A", "hash-a", 1);
    await failing.run();
    const duplicate = db
      .prepare("INSERT INTO devices (id, name, token_sha256, created_at) VALUES (?1, ?2, ?3, ?4)")
      .bind("6f1c8d2e-4a3b-4c5d-9e6f-7a8b9c0d1e2f", "Other", "hash-b", 2);
    await expect(duplicate.run()).rejects.toMatchObject({ name: "SqliteD1Error", cause: expect.anything() });
  });
});

describe("batch", () => {
  it("returns every statement's result; a read sees the batch's earlier writes", async () => {
    const { database } = createTestBackend();
    const db = createSqliteD1(database);
    const id = "6f1c8d2e-4a3b-4c5d-9e6f-7a8b9c0d1e2f";
    const results = await db.batch([
      db
        .prepare("INSERT INTO devices (id, name, token_sha256, created_at) VALUES (?1, ?2, ?3, ?4)")
        .bind(id, "Device A", "hash-a", 1),
      db.prepare("SELECT name FROM devices WHERE id = ?1").bind(id)
    ]);
    expect(results).toHaveLength(2);
    expect(results[1]?.results).toEqual([{ name: "Device A" }]);
  });

  it("rolls the whole batch back when a statement fails", async () => {
    const { database } = createTestBackend();
    const db = createSqliteD1(database);
    const insert = db
      .prepare("INSERT INTO devices (id, name, token_sha256, created_at) VALUES (?1, ?2, ?3, ?4)")
      .bind("6f1c8d2e-4a3b-4c5d-9e6f-7a8b9c0d1e2f", "Device A", "hash-a", 1);
    await insert.run();

    const id = "0b2a4d6c-8e9f-4a1b-b3c5-d7e9f0a1b2c3";
    // The first statement would insert a bucket row; the second violates the devices primary key. Both
    // are undone: a push whose rows partly fail must leave no row behind.
    const batch = db.batch([
      db
        .prepare(
          "INSERT INTO buckets (device_id, hour, agent, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, reasoning_tokens, requests, sessions_started, cost_usd, unpriced_requests, seq) VALUES (?1, 0, 'claude-code', '', 0, 0, 0, 0, 0, 0, 0, 0.0, 0, 1)"
        )
        .bind(id),
      db
        .prepare("INSERT INTO devices (id, name, token_sha256, created_at) VALUES (?1, ?2, ?3, ?4)")
        .bind("6f1c8d2e-4a3b-4c5d-9e6f-7a8b9c0d1e2f", "Duplicate", "hash-c", 3)
    ]);
    // The error thrown is the statement's own, not a rollback artifact.
    await expect(batch).rejects.toMatchObject({
      name: "SqliteD1Error",
      message: /cannot execute statement/
    });

    expect(countRows(database, "devices")).toBe(1);
    expect(countRows(database, "buckets")).toBe(0);
  });

  it("keeps the original error reachable when the rollback itself fails", async () => {
    const { database } = createTestBackend();
    const db = createSqliteD1(
      new Proxy(database, {
        get(target, property) {
          if (property === "exec") {
            return (sql: string) => {
              if (sql === "ROLLBACK") {
                throw new Error("rollback broke");
              }
              return target.exec(sql);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
      })
    );
    const id = "0b2a4d6c-8e9f-4a1b-b3c5-d7e9f0a1b2c3";
    const batch = db.batch([
      db
        .prepare("INSERT INTO devices (id, name, token_sha256, created_at) VALUES (?1, ?2, ?3, ?4)")
        .bind(id, "Device B", "hash-b", 1),
      db
        .prepare("INSERT INTO devices (id, name, token_sha256, created_at) VALUES (?1, ?2, ?3, ?4)")
        .bind(id, "Duplicate", "hash-c", 2)
    ]);
    // The thrown error names the failed rollback and keeps the statement error on `cause`.
    const error = await batch.then(
      () => undefined,
      (failed: unknown) => failed
    );
    if (!(error instanceof SqliteD1Error)) {
      throw new Error(`expected the batch to fail with SqliteD1Error, got ${String(error)}`);
    }
    expect(error.message).toContain("could not be rolled back");
    expect(error.message).toContain("rollback broke");
    expect(error.cause).toBeInstanceOf(SqliteD1Error);
    expect(error.cause instanceof SqliteD1Error ? error.cause.message : "").toContain("cannot execute statement");
  });

  it("rejects a statement the adapter did not create", async () => {
    const { database } = createTestBackend();
    const db = createSqliteD1(database);
    const foreign = createSqliteD1(new DatabaseSync(":memory:")).prepare("SELECT 1");
    await expect(db.batch([foreign])).rejects.toBeInstanceOf(SqliteD1Error);
    // The refused batch left no open transaction behind: a fresh BEGIN would fail inside one.
    expect(() => {
      database.exec("BEGIN IMMEDIATE");
      database.exec("ROLLBACK");
    }).not.toThrow();
  });
});

describe("migration", () => {
  it("builds the schema the handler runs on from the committed migration alone", () => {
    const database = new DatabaseSync(":memory:");
    expect(() => applyMigrations(database)).not.toThrow();
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    const names = z
      .array(z.object({ name: z.string() }))
      .parse(tables)
      .map((table) => table.name);
    expect(names).toEqual(["buckets", "devices"]);
  });
});
