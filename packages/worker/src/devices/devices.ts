import type { D1Database } from "../db.ts";
import { generateDeviceToken, hashToken } from "../tokens.ts";
import { deviceExists, findByTokenHash, insertUnlessActive, markRevoked, readDevices } from "./store.ts";

/**
 * Device use cases (plan 3.2.4, 3.8): registration, revocation, listing and device-token authentication.
 * They take parsed values and throw the errors below, which say what went wrong and know no HTTP status.
 */

class DeviceAlreadyActive extends Error {
  readonly _tag = "DeviceAlreadyActive";

  constructor(deviceId: string) {
    super(`device ${deviceId} is already registered`);
  }
}

class DeviceNotFound extends Error {
  readonly _tag = "DeviceNotFound";

  constructor(deviceId: string) {
    super(`no device ${deviceId}`);
  }
}

/** A device token that is unknown, or belongs to a revoked device. */
class DeviceTokenRejected extends Error {
  readonly _tag = "DeviceTokenRejected";

  constructor() {
    super("unknown or revoked token");
  }
}

/** Every error these use cases throw; `http/failures.ts` gives each tag its answer. */
export const devicesErrors = [DeviceAlreadyActive, DeviceNotFound, DeviceTokenRejected] as const;

interface DevicesDeps {
  readonly db: D1Database;
  /** Epoch milliseconds. */
  readonly now: () => number;
}

export interface AuthenticatedDevice {
  readonly id: string;
}

interface Device {
  readonly id: string;
  readonly name: string;
  /** Epoch milliseconds; null before the device's first push. */
  readonly lastPushAt: number | null;
  readonly revoked: boolean;
}

/**
 * Registers a new id, or a revoked one again under a fresh token, and returns that token: the only time it
 * exists outside the device, since D1 keeps its SHA-256 alone (plan 3.8). An active id is
 * `DeviceAlreadyActive`; the store decides that in the same statement that writes.
 */
export const registerDevice = async (
  { db, now }: DevicesDeps,
  registration: { readonly deviceId: string; readonly name: string }
): Promise<string> => {
  const deviceToken = generateDeviceToken();
  const registered = await insertUnlessActive(db, {
    id: registration.deviceId,
    name: registration.name,
    tokenSha256: await hashToken(deviceToken),
    createdAt: now()
  });
  if (!registered) {
    throw new DeviceAlreadyActive(registration.deviceId);
  }
  return deviceToken;
};

/** Marks a device revoked and keeps its buckets (Spec S9); an unknown id is `DeviceNotFound`. */
export const revokeDevice = async ({ db, now }: DevicesDeps, deviceId: string): Promise<void> => {
  if (!(await deviceExists(db, deviceId))) {
    throw new DeviceNotFound(deviceId);
  }
  await markRevoked(db, deviceId, now());
};

export const listDevices = async (db: D1Database): Promise<Device[]> =>
  (await readDevices(db)).map(({ id, name, lastPushAt, revokedAt }) => ({
    id,
    name,
    lastPushAt,
    revoked: revokedAt !== null
  }));

/** The device a token belongs to, looked up by the token's hash; an unknown or revoked token is rejected. */
export const authenticateDevice = async (db: D1Database, token: string): Promise<AuthenticatedDevice> => {
  const owner = await findByTokenHash(db, await hashToken(token));
  if (owner === null || owner.revokedAt !== null) {
    throw new DeviceTokenRejected();
  }
  return { id: owner.id };
};
