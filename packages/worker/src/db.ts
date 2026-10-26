/**
 * The subset of the D1 database API the Worker uses (plan 3.12), declared here so neither the handler nor
 * its tests need the Workers runtime types. Method shapes follow the real D1 worker API; the node:sqlite
 * adapter in `sqlite-d1.ts` implements the same interface for tests and self-hosting.
 */

/** A value bound to a SQL parameter: what D1 accepts and this Worker's statements use. */
export type D1Value = null | number | string | Uint8Array;

/** The result of one statement: its rows (empty for writes) and the number of rows it changed. */
export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
  meta: { changes: number };
}

export interface D1PreparedStatement {
  /** Returns a new statement with these values bound, leaving the receiver unchanged. */
  bind(...values: D1Value[]): D1PreparedStatement;
  /** The first row, or null when the statement returns none. */
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<D1Result<never>>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  /**
   * Runs every statement in order as one transaction: all of them commit, or none do. Every statement's
   * result is returned, so reads inside the batch see the writes of the statements before them.
   */
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}
