import type { Platform } from "@rivus/agent-kit/platform";
import { Effect } from "effect";

import { accumulateRecord, createAccumulator } from "../../core/buckets/buckets.ts";
import { collectUsage, type ScanOutcome } from "../scan/scan.ts";
import type { Ledger, LedgerUnreadable, PersistedScanState } from "./ledger.ts";

/** Where a run's scan starts, and what the run writes before the scan. */
export interface ScanWindow {
  /** Epoch milliseconds; records before this are left out (plan 3.4.1 step 3). */
  readonly since: number;
  /** The saved state to continue from; `undefined` scans the window from scratch. */
  readonly state: PersistedScanState | undefined;
  /** Writes inside the scan's transaction, before the scan (rebuild's zeroing); they roll back with it. */
  readonly beforeScan?: Effect.Effect<void>;
}

/**
 * Steps 3–5 of a run (plan 3.4.1): scan only what was written since `since`, fold every record into hourly
 * buckets, then — in one transaction — write the buckets, the sessions first seen, the new scan state and
 * `last_scan_completed_at`. The scan iterates inside the transaction, so a run that fails or is interrupted
 * anywhere before the commit leaves the ledger exactly as it was (Spec S3), and a rebuild's zeroing rolls back
 * with it.
 */
export const commitScan = (
  platform: Platform,
  ledger: Ledger,
  window: ScanWindow,
  now: number
): Effect.Effect<ScanOutcome, LedgerUnreadable> =>
  ledger.transaction(
    Effect.gen(function* () {
      if (window.beforeScan !== undefined) {
        yield* window.beforeScan;
      }
      const seen = yield* ledger.sessionsSeen();
      const accumulator = createAccumulator();
      const outcome = yield* Effect.promise((signal) =>
        collectUsage(platform, { since: window.since, state: window.state, signal }, (record) =>
          accumulateRecord(record, accumulator, seen)
        )
      );
      yield* ledger.addBuckets([...accumulator.buckets.values()]);
      yield* ledger.addSessionsSeen(accumulator.newSessions);
      yield* ledger.setScanState(outcome.state);
      yield* ledger.setLastScanCompleted(now);
      return outcome;
    })
  );
