import type { DatabaseSync, StatementSync } from "node:sqlite";

import type { D1Database, D1PreparedStatement, D1Result, D1Value } from "./db.ts";

/**
 * Implements the Worker's D1 subset (`db.ts`) over `node:sqlite`, so the handler runs against a local
 * SQLite file or an in-memory database in tests and on a self-hosted server. A `batch` is one
 * `BEGIN … COMMIT` in statement order: every statement commits, or a failure rolls the transaction back
 * and the database is left as it was. Reads may appear inside a batch and see the writes of the
 * statements before them, which the push's sequence assignment relies on.
 */

/** A statement the adapter could not prepare or execute; the sqlite3 error rides on `cause`. */
export class SqliteD1Error extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SqliteD1Error";
  }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface StatementExecution {
  readonly results: unknown[];
  readonly changes: number;
}

const executeStatement = (database: DatabaseSync, sql: string, values: readonly D1Value[]): StatementExecution => {
  let statement: StatementSync;
  try {
    statement = database.prepare(sql);
  } catch (cause) {
    throw new SqliteD1Error(`cannot prepare statement: ${describe(cause)}`, { cause });
  }
  try {
    // `all` runs every statement kind: reads return their rows, writes change rows and return none.
    return { results: statement.all(...values), changes: 0 };
  } catch (cause) {
    throw new SqliteD1Error(`cannot execute statement: ${describe(cause)}`, { cause });
  }
};

/**
 * Builds the database over one open `node:sqlite` connection. The connection is not closed here: the
 * caller owns its lifetime (a request scope in tests, the server's lifetime when self-hosting).
 */
export const createSqliteD1 = (database: DatabaseSync): D1Database => {
  // `batch` receives the public statement interface, so the execution it drives is kept beside the
  // object the builder created, keyed by identity.
  const executions = new WeakMap<D1PreparedStatement, () => StatementExecution>();

  const buildStatement = (sql: string, values: readonly D1Value[]): D1PreparedStatement => {
    const execute = (): StatementExecution => executeStatement(database, sql, values);
    const statement: D1PreparedStatement = {
      bind: (...next: D1Value[]) => buildStatement(sql, next),
      first: async <T>(): Promise<T | null> => (execute().results[0] ?? null) as T | null,
      all: async <T>(): Promise<D1Result<T>> => {
        const { results, changes } = execute();
        return { results: results as T[], success: true, meta: { changes } };
      },
      run: async (): Promise<D1Result<never>> => {
        execute();
        return { results: [], success: true, meta: { changes: 0 } };
      }
    };
    executions.set(statement, execute);
    return statement;
  };

  return {
    prepare: (query) => buildStatement(query, []),
    batch: async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
      try {
        database.exec("BEGIN IMMEDIATE");
      } catch (cause) {
        throw new SqliteD1Error(`cannot begin a transaction: ${describe(cause)}`, { cause });
      }
      const results: D1Result<T>[] = [];
      try {
        for (const statement of statements) {
          const execute = executions.get(statement);
          if (execute === undefined) {
            throw new SqliteD1Error("a batch statement was not created by this adapter");
          }
          const { results: rows, changes } = execute();
          results.push({ results: rows as T[], success: true, meta: { changes } });
        }
        database.exec("COMMIT");
        return results;
      } catch (cause) {
        try {
          database.exec("ROLLBACK");
        } catch (rollbackCause) {
          throw new SqliteD1Error(
            `a statement failed and the transaction could not be rolled back: ${describe(rollbackCause)}`,
            { cause: rollbackCause }
          );
        }
        throw cause instanceof SqliteD1Error ? cause : new SqliteD1Error(describe(cause), { cause });
      }
    }
  };
};
