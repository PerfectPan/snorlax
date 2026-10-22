import { readConfig } from "../config/config.ts";
import { openLedger, type Ledger } from "../ledger/ledger.ts";
import { commitScan, type RefreshDeps, type RefreshOutcome, type ScanHooks } from "../refresh/refresh.ts";
import { withLedgerLock } from "../refresh/lock.ts";
import { buildSnapshot } from "../snapshot/build.ts";
import { writeSnapshot } from "../snapshot/write.ts";

/** `rebuild --days` accepts 1–30 days; Claude Code deletes older logs by default (plan 3.4.3). */
export const REBUILD_MIN_DAYS = 1;
export const REBUILD_MAX_DAYS = 30;

/** Rebuild's zeroing, inside the scan's transaction: buckets to zero, `sessions_seen` rows to drop. */
const zeroForRescan =
  (startHour: number) =>
  (ledger: Ledger): void => {
    ledger.zeroBucketsFrom(startHour);
    ledger.deleteSessionsSeenFrom(startHour);
  };

/**
 * The first UTC hour a rebuild of `days` days zeroes and rescans: the window is hour-aligned so no bucket
 * is half inside it. The window rolls back from now by whole days, like the retention it mirrors.
 */
export function rebuildStartHour(now: number, days: number): number {
  return Math.floor((now - days * 86_400_000) / 3_600_000) * 3600;
}

/**
 * One `snorlax rebuild --days n` (plan 3.4.3): under the lock and in one transaction — zeroing every
 * bucket from the window start, dropping the `sessions_seen` rows inside it, rescanning that window with
 * no saved state — then the same commit and snapshot a refresh writes. Zeroed buckets that receive no
 * usage stay as zero rows marked dirty, so a later upload replaces the backend's rows with zeros.
 */
export async function runRebuild(deps: RefreshDeps, days: number, hooks?: ScanHooks): Promise<RefreshOutcome> {
  const startedAt = deps.platform.clock.monotonic();
  const now = deps.platform.clock.now();
  const startHour = rebuildStartHour(now, days);
  const ledger = await openLedger(deps.platform, deps.dataDir);
  try {
    return await withLedgerLock(deps.platform, deps.dataDir, async () => {
      const outcome = await commitScan({
        platform: deps.platform,
        ledger,
        now,
        since: startHour * 1000,
        state: undefined,
        beforeScan: zeroForRescan(startHour),
        hooks
      });
      const config = await readConfig(deps.platform, deps.dataDir);
      const snapshot = buildSnapshot({
        now,
        timeZone: deps.timeZone,
        thisDevice: { id: ledger.meta.deviceId, name: config.deviceName ?? null },
        buckets: ledger.readBuckets(),
        remoteBuckets: ledger.readRemoteBuckets(),
        remoteDevices: ledger.readRemoteDevices(),
        lastScanAt: now,
        failuresByAgent: outcome.failuresByAgent,
        paired: false
      });
      await writeSnapshot(deps.platform, deps.dataDir, snapshot);
      await deps.log.event("rebuild", {
        days,
        records: outcome.records,
        failures: outcome.failures,
        pushed: 0,
        pulled: 0,
        durationMs: Math.round(deps.platform.clock.monotonic() - startedAt)
      });
      return {
        result: {
          schemaVersion: 1,
          ok: true,
          scannedAt: new Date(now).toISOString(),
          records: outcome.records,
          failures: outcome.failures,
          sync: { ok: false, pushed: 0, pulled: 0 }
        },
        failuresByAgent: outcome.failuresByAgent
      };
    });
  } finally {
    ledger.close();
  }
}
