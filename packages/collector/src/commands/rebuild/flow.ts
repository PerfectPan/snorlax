import { Effect } from "effect";

import { DataDir } from "../../modules/data-dir/data-dir.ts";
import { scanAndCommit } from "../../modules/ledger/ledger.ts";
import { Log } from "../../modules/log/log.ts";
import { SnorlaxPlatform } from "../../modules/platform/platform.ts";
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
 * One `snorlax rebuild --days n` (plan 3.4.3): like refresh, prepares the data directory first; then, through
 * the ledger's scan-and-commit and inside its one transaction, zeroes every bucket from the window start, drops
 * the `sessions_seen` rows inside the window, and rescans the window with no saved state. Zeroed buckets that
 * receive no usage stay as zero rows marked dirty, so a later upload replaces the backend's rows with zeros.
 */
export const rebuildFlow = (days: number) =>
  Effect.gen(function* () {
    const platform = yield* SnorlaxPlatform;
    const dataDir = yield* DataDir;
    const log = yield* Log;
    const timeZone = yield* TimeZone;
    yield* dataDir.ensure;
    return yield* scanAndCommit(
      { platform, dataDir: dataDir.path, log, timeZone },
      {
        event: "rebuild",
        fields: { days },
        window: (ledger, now) => {
          const startHour = rebuildStartHour(now, days);
          return {
            since: startHour * 1000,
            state: undefined,
            beforeScan: Effect.andThen(ledger.zeroBucketsFrom(startHour), ledger.deleteSessionsSeenFrom(startHour))
          };
        }
      }
    );
  });
