import * as z from "zod/mini";

import type { D1Database } from "../db.ts";

/**
 * SQL on `devices` (plan 3.3.3). Rows are parsed with zod at this boundary, so the use cases see typed values.
 */

interface DeviceRow {
  readonly id: string;
  readonly name: string;
  /** Epoch milliseconds; null before the device's first push. */
  readonly lastPushAt: number | null;
  /** Epoch milliseconds; null while the device is active. */
  readonly revokedAt: number | null;
}

interface NewDevice {
  readonly id: string;
  readonly name: string;
  readonly tokenSha256: string;
  readonly createdAt: number;
}

/**
 * Inserts a fresh id or takes over a revoked one, in one statement, and reports whether a row changed. An
 * active device fails the guard and changes nothing, so two concurrent registrations of one id cannot both
 * pass. The overwrite keeps `created_at` and `last_push_at`, so the usage history survives (Spec R11).
 */
export const insertUnlessActive = async (db: D1Database, device: NewDevice): Promise<boolean> => {
  const { meta } = await db
    .prepare(
      `INSERT INTO devices (id, name, token_sha256, created_at, last_push_at, revoked_at)
       VALUES (?1, ?2, ?3, ?4, NULL, NULL)
       ON CONFLICT (id) DO UPDATE SET
         name = excluded.name, token_sha256 = excluded.token_sha256, revoked_at = NULL
         WHERE devices.revoked_at IS NOT NULL`
    )
    .bind(device.id, device.name, device.tokenSha256, device.createdAt)
    .run();
  return meta.changes !== 0;
};

const tokenOwnerSchema = z.object({ id: z.uuid(), revoked_at: z.nullable(z.int()) });

/** The device a token hash belongs to; null when no row matches or the row does not parse. */
export const findByTokenHash = async (
  db: D1Database,
  tokenSha256: string
): Promise<{ readonly id: string; readonly revokedAt: number | null } | null> => {
  const row = await db.prepare("SELECT id, revoked_at FROM devices WHERE token_sha256 = ?1").bind(tokenSha256).first();
  const parsed = row === null ? null : z.safeParse(tokenOwnerSchema, row);
  return parsed === null || !parsed.success ? null : { id: parsed.data.id, revokedAt: parsed.data.revoked_at };
};

/** Whether a device row with this id exists, revoked or not. */
export const deviceExists = async (db: D1Database, id: string): Promise<boolean> => {
  const row = await db.prepare("SELECT id FROM devices WHERE id = ?1").bind(id).first();
  return row !== null && z.safeParse(z.object({ id: z.string() }), row).success;
};

export const markRevoked = async (db: D1Database, id: string, revokedAt: number): Promise<void> => {
  await db.prepare("UPDATE devices SET revoked_at = ?1 WHERE id = ?2").bind(revokedAt, id).run();
};

const deviceRowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  last_push_at: z.nullable(z.int()),
  revoked_at: z.nullable(z.int())
});

/** Every device, oldest registration first; ids break ties between devices registered at the same instant. */
export const readDevices = async (db: D1Database): Promise<DeviceRow[]> => {
  const result = await db
    .prepare("SELECT id, name, last_push_at, revoked_at FROM devices ORDER BY created_at, id")
    .all();
  return result.results.map((row) => {
    const parsed = z.parse(deviceRowSchema, row);
    return { id: parsed.id, name: parsed.name, lastPushAt: parsed.last_push_at, revokedAt: parsed.revoked_at };
  });
};
