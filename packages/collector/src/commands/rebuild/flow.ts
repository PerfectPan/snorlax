import { Effect } from "effect";

import { pairedSync } from "../../capabilities/backend/backend.ts";
import { ensureDataDir, resolveDataDir } from "../../modules/data-dir/data-dir.ts";
import { scanAndCommit, type ScanRun } from "../../modules/ledger/ledger.ts";
import { appendingLogger } from "../../modules/log/log.ts";
import { NodeFiles, SnorlaxPlatform } from "../../modules/platform/platform.ts";
import { TimeZone } from "../../modules/time-zone/time-zone.ts";

/** `rebuild --days` accepts 1–30 days; Claude Code deletes older logs by default (plan 3.4.3). */
export const REBUILD_MIN_DAYS = 1;
export const REBUILD_MAX_DAYS = 30;

/**
 * The first UTC hour a rebuild of `days` days zeroes and rescans: the window is hour-aligned so no bucket
 * is half inside it. The window rolls back from now by whole days, like the retention it mirrors.
 */
export function rebuildStartHour(now: number, days: number): number {
  return Math.floor((now - days * 86_400_000) / 3_600_000) * 3600;
}

/**
 * Rebuild's part of the scan-and-commit run (plan 3.4.3): inside the run's one transaction, zeroes every bucket
 * from the window start, drops the `sessions_seen` rows inside the window, and rescans the window with no saved
 * state. Zeroed buckets that receive no usage stay as zero rows marked dirty, so a later upload replaces the
 * backend's rows with zeros. Only a rebuild of the longest window prices again every bucket the snapshot shows,
 * so only that one records the current pricing version (plan 3.7); a shorter one leaves older days at the prices
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
    const platform = yield* SnorlaxPlatform;
    const nodeFiles = yield* NodeFiles;
    const dataDir = resolveDataDir(platform);
    yield* ensureDataDir(platform, nodeFiles, dataDir);
    const log = appendingLogger(platform, nodeFiles, dataDir);
    const sync = yield* pairedSync({ platform, dataDir });
    return yield* scanAndCommit({ platform, dataDir, log, timeZone: yield* TimeZone, sync }, rebuildScan(days));
  });
