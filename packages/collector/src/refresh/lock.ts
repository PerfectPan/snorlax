import { join } from "node:path";

import { acquireProcessLock, type ProcessLock } from "@rivus/agent-kit-collab/process-lock";
import type { Platform } from "@rivus/agent-kit/platform";

import { CliError } from "../cli/errors.ts";
import type { PlatformSqlite } from "../ledger/sqlite.ts";
import { errorMessage } from "../util/error-message.ts";

/**
 * The platform a refresh or rebuild runs on: what the kit's scan needs, plus the SQLite and process
 * identity the ledger lock reads (plan 3.4.1 step 2).
 */
export type RefreshPlatform = Pick<Platform, "env" | "home" | "os" | "fs" | "clock"> & {
  readonly sqlite: PlatformSqlite;
  readonly process: Platform["process"];
};

/** How long a refresh waits for the ledger lock before exiting with `locked` (plan 3.4.1 step 2). */
export const LOCK_WAIT_MS = 60_000;

/**
 * Takes the ledger lock `<data>/ledger.lock` and runs `body` under it, releasing afterwards. Waiting past
 * `LOCK_WAIT_MS` exits with the `locked` failure code; the platform's SQLite gives the lock its exclusive
 * mechanism, so the kernel releases it even if this process is killed.
 */
export async function withLedgerLock<T>(
  platform: RefreshPlatform,
  dataDir: string,
  body: () => Promise<T>
): Promise<T> {
  const path = join(dataDir, "ledger.lock");
  const signal = AbortSignal.timeout(LOCK_WAIT_MS);
  let lock: ProcessLock;
  try {
    const acquired = await acquireProcessLock(platform, path, { wait: true, signal });
    if (!acquired.ok) {
      throw new CliError("locked", `another snorlax process holds ${path}`);
    }
    lock = acquired.value;
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    if (signal.aborted) {
      throw new CliError(
        "locked",
        `waited ${LOCK_WAIT_MS / 1000}s for the ledger lock ${path}: ${errorMessage(error)}`
      );
    }
    throw error;
  }
  try {
    return await body();
  } finally {
    await lock.release();
  }
}
