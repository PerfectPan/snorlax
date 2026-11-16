import { Effect } from "effect";

import { scanAndCommit, type ScanRun } from "../../modules/ledger/ledger.ts";
import { TimeZone } from "../../modules/time-zone/time-zone.ts";
import { preparedScanContext } from "../../capabilities/backend/backend.ts";

/** `rebuild --days` accepts 1–180 days. Deleted source logs cannot be recovered; their rebuilt buckets become zero. */
export const REBUILD_MIN_DAYS = 1;
export const REBUILD_MAX_DAYS = 180;

/**
 * The first UTC hour a rebuild of `days` days zeroes and rescans: the window is hour-aligned so no bucket
 * is half inside it. The window rolls back from now by whole days; source logs may already have been deleted.
 */
export function rebuildStartHour(now: number, days: number): number {
  return Math.floor((now - days * 86_400_000) / 3_600_000) * 3600;
}

/**
 * Rebuild's part of the scan-and-commit run: inside the run's one transaction, zeroes every bucket
 * from the window start, drops the `sessions_seen` rows inside the window, and rescans the window with no saved
 * state. Zeroed buckets that receive no usage stay as zero rows marked dirty, so a later upload replaces the
 * backend's rows with zeros. Only a rebuild of the longest window prices again every bucket the snapshot shows,
 * so only that one records the current pricing version; a shorter one leaves older days at the prices
 * they had.
 */
export const rebuildScan = (days: number): ScanRun => ({
  event: "rebuild",
  fields: { days },
  window: (ledger, now) => {
    const startHour = rebuildStartHour(now, days);
    return {
      since: startHour * 1000,
      state: undefined,
      beforeScan: Effect.andThen(ledger.zeroBucketsFrom(startHour), ledger.deleteSessionsSeenFrom(startHour)),
      reprices: days === REBUILD_MAX_DAYS
    };
  }
});

/** One `snorlax rebuild --days n`: like refresh, prepares the data directory first, then runs `rebuildScan`. */
export const rebuildFlow = (days: number) =>
  Effect.gen(function* () {
    const { platform, dataDir, log, sync } = yield* preparedScanContext;
    return yield* scanAndCommit({ platform, dataDir, log, timeZone: yield* TimeZone, sync }, rebuildScan(days));
  });
