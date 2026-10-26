import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { httpDeviceRegisterResponseSchema, type Bucket } from "@rivus/snorlax-protocol";
import * as z from "zod/mini";

import type { Handler } from "../../src/handler.ts";
import { createHandler } from "../../src/handler.ts";
import { createSqliteD1 } from "../../src/sqlite-d1.ts";

/**
 * Builds the handler over an in-memory SQLite database whose schema is the committed D1 migration, with
 * a fixed injected clock. Tests never use real elapsed time (plan 3.12).
 */

export const ADMIN_TOKEN = "test-admin-token-do-not-use";
export const NOW_MS = Date.UTC(2026, 9, 26, 12, 0, 0);

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const applyMigrations = (database: DatabaseSync): void => {
  database.exec(readFileSync(join(packageRoot, "migrations", "0001_init.sql"), "utf8"));
};

export interface TestBackend {
  handler: Handler;
  database: DatabaseSync;
}

export const createTestBackend = (options?: { now?: () => number }): TestBackend => {
  const database = new DatabaseSync(":memory:");
  applyMigrations(database);
  const handler = createHandler({
    db: createSqliteD1(database),
    adminToken: ADMIN_TOKEN,
    now: options?.now ?? (() => NOW_MS)
  });
  return { handler, database };
};

export interface CallResult {
  status: number;
  body: unknown;
  response: Response;
}

/** Runs one request against the handler and parses the JSON body, if any. */
export const call = async (handler: Handler, request: Request): Promise<CallResult> => {
  const response = await handler(request);
  const text = await response.text();
  return { status: response.status, body: text === "" ? null : (JSON.parse(text) as unknown), response };
};

export const jsonRequest = (method: string, path: string, options?: { body?: unknown; token?: string }): Request =>
  new Request(`https://snorlax.test${path}`, {
    method,
    headers: {
      ...(options?.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
      ...(options?.body === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(options?.body === undefined ? {} : { body: JSON.stringify(options.body) })
  });

const DEVICE_A_ID = "6f1c8d2e-4a3b-4c5d-9e6f-7a8b9c0d1e2f";
const DEVICE_B_ID = "0b2a4d6c-8e9f-4a1b-b3c5-d7e9f0a1b2c3";

export const deviceAId = DEVICE_A_ID;
export const deviceBId = DEVICE_B_ID;

export interface RegisteredDevice {
  id: string;
  token: string;
}

/** Registers a device with the admin token and returns its one-time device token. */
export const registerDevice = async (handler: Handler, id: string, name: string): Promise<RegisteredDevice> => {
  const { status, body } = await call(
    handler,
    jsonRequest("POST", "/v1/devices", { body: { deviceId: id, name }, token: ADMIN_TOKEN })
  );
  if (status !== 201) {
    throw new Error(`registering device ${id} failed with ${status}`);
  }
  return { id, token: z.parse(httpDeviceRegisterResponseSchema, body).deviceToken };
};

export const bucketFixture = (deviceId: string, overrides?: Partial<Bucket>): Bucket => ({
  deviceId,
  hour: Date.UTC(2026, 9, 26, 11) / 1000,
  agent: "claude-code",
  model: "claude-opus-5-5",
  inputTokens: 1_000,
  cacheReadTokens: 800,
  cacheWriteTokens: 50,
  outputTokens: 200,
  reasoningTokens: 20,
  requests: 4,
  sessionsStarted: 1,
  costUsd: 0.5,
  unpricedRequests: 0,
  ...overrides
});
