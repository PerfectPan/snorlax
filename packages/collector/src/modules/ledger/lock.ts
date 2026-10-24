import { join } from "node:path";

import { acquireProcessLock, type ProcessLock } from "@rivus/agent-kit-collab/process-lock";
import type { Platform } from "@rivus/agent-kit/platform";

import { CommandError } from "../errors/errors.ts";
import type { CollectorPlatform } from "../platform/platform.ts";
import type { PlatformSqlite } from "./sqlite.ts";
import { errorMessage } from "../../core/error-message/error-message.ts";

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
      throw new CommandError({ code: "locked", message: `another snorlax process holds ${path}` });
    }
    lock = acquired.value;
  } catch (error) {
    if (error instanceof CommandError) {
      throw error;
    }
    if (signal.aborted) {
      throw new CommandError({
        code: "locked",
        message: `waited ${LOCK_WAIT_MS / 1000}s for the ledger lock ${path}: ${errorMessage(error)}`
      });
    }
    throw error;
  }
  try {
    return await body();
  } finally {
    await lock.release();
  }
}

/**
 * Widens the platform into what a refresh runs on. SQLite is required (the ledger); the process
 * identity members are read by the ledger lock inside the kit's own try/catch, so a platform without
 * them gets members that throw — on the Node platform none of the fallbacks are used.
 */
export function refreshPlatformOf(platform: CollectorPlatform): RefreshPlatform {
  if (platform.sqlite === undefined) {
    throw new CommandError({ code: "internal", message: "this platform has no SQLite; the ledger cannot run here" });
  }
  const sqlite: PlatformSqlite = platform.sqlite;
  const unavailable = (member: "self" | "identify" | "spawn") => (): never => {
    throw new CommandError({
      code: "internal",
      message: `this platform has no process.${member}; the ledger lock cannot run here`
    });
  };
  const identityOf = platform.process;
  return {
    env: platform.env,
    home: platform.home,
    os: platform.os,
    fs: platform.fs,
    clock: platform.clock,
    sqlite,
    process: {
      run: identityOf.run,
      get self() {
        // `self` is a value on the kit's platform, read lazily here so a platform whose identity read
        // throws (the kit treats that as "no identity") still takes the lock.
        const identity = identityOf.self;
        if (identity === undefined) {
          throw new Error("this platform has no process identity; the ledger lock records none");
        }
        return identity;
      },
      identify: identityOf.identify ?? unavailable("identify"),
      spawn: identityOf.spawn ?? unavailable("spawn")
    }
  };
}
