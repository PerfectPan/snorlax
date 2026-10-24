import { join } from "node:path";

import { acquireProcessLock, type ProcessLockPlatform } from "@rivus/agent-kit-collab/process-lock";
import { Data, Duration, Effect, type Scope } from "effect";

/** How long a refresh waits for the ledger lock before giving up (plan 3.4.1 step 2). */
export const LOCK_WAIT_MS = 60_000;

/** The ledger lock could not be taken within `LOCK_WAIT_MS`: another snorlax process holds it. */
export class LedgerLockHeld extends Data.TaggedError("LedgerLockHeld")<{ readonly message: string }> {}

/**
 * Takes the ledger lock `<data>/ledger.lock` and holds it until the scope closes, however the run ends. The wait
 * is timed on Effect's clock, so tests drive it with `TestClock`; past `LOCK_WAIT_MS` it fails with
 * `LedgerLockHeld`. The platform's SQLite gives the lock its exclusive mechanism, so the kernel releases it even
 * if this process is killed.
 */
export function holdLedgerLock(
  platform: ProcessLockPlatform,
  dataDir: string
): Effect.Effect<void, LedgerLockHeld, Scope.Scope> {
  const path = join(dataDir, "ledger.lock");
  const acquire = Effect.promise((signal) =>
    acquireProcessLock(platform, path, { wait: true, signal }).then(async (acquired) => {
      // An interruption that lands after the kit took the lock, but before this fiber resumes, drops the result;
      // releasing it here keeps the lock from outliving the run.
      if (signal.aborted && acquired.ok) {
        await acquired.value.release();
      }
      return acquired;
    })
  ).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(LOCK_WAIT_MS),
      orElse: () =>
        Effect.fail(
          new LedgerLockHeld({
            message: `waited ${LOCK_WAIT_MS / 1000}s for the ledger lock ${path}: The operation was aborted due to timeout`
          })
        )
    }),
    Effect.flatMap((acquired) =>
      acquired.ok
        ? Effect.succeed(acquired.value)
        : Effect.fail(new LedgerLockHeld({ message: `another snorlax process holds ${path}` }))
    )
  );
  return Effect.asVoid(
    Effect.acquireRelease(acquire, (lock) => Effect.promise(() => lock.release()), { interruptible: true })
  );
}
