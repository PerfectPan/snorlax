import type { UsagePlatform } from "@rivus/agent-kit/transcript/usage";

/**
 * The kit's SQLite port and its statement and database shapes, reached through the types the kit exports
 * publicly (`@rivus/agent-kit/platform` exports only the `Platform` interface itself).
 */
export type PlatformSqlite = NonNullable<UsagePlatform["sqlite"]>;
export type SqliteDatabase = ReturnType<PlatformSqlite["open"]>;
export type SqliteStatement = ReturnType<SqliteDatabase["prepare"]>;
export type SqliteValue = Parameters<SqliteStatement["run"]>[number];
