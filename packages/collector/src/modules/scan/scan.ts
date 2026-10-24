import { isUsageRecord, scanUsage, type UsageRecord } from "@rivus/agent-kit/transcript/usage";

import type { PersistedScanState } from "../ledger/ledger.ts";

/** What one scan found: the records it yielded, per-agent failure counts, and the state to persist. */
export interface ScanOutcome {
  readonly records: number;
  readonly failures: number;
  readonly failuresByAgent: Record<string, number>;
  readonly state: unknown;
}

export interface ScanOptions {
  /** Epoch milliseconds; records before this are left out (plan 3.4.1 step 3). */
  readonly since: number;
  /** The saved state of the previous scan; absent on the first run. */
  readonly state?: PersistedScanState;
}

/**
 * Runs one `scanUsage` to its end, handing every record to `onRecord` and counting the rest as failures,
 * per agent. A `RootMissing` listing means the agent is not installed on this machine (no source exists to
 * fail), so it is not counted as a failure — `status` reports detection instead; every other source or
 * decode failure is (plan 3.4.1 step 3, 3.6).
 */
export async function collectUsage(
  platform: Parameters<typeof scanUsage>[0],
  options: ScanOptions,
  onRecord: (record: UsageRecord) => void
): Promise<ScanOutcome> {
  const scan = scanUsage(platform, {
    since: options.since,
    ...(options.state === undefined ? {} : { state: options.state })
  });
  let records = 0;
  let failures = 0;
  const failuresByAgent: Record<string, number> = {};
  for await (const item of scan) {
    if (isUsageRecord(item)) {
      records += 1;
      onRecord(item);
      continue;
    }
    if (item.error._tag === "RootMissing") {
      continue;
    }
    failures += 1;
    failuresByAgent[item.agent] = (failuresByAgent[item.agent] ?? 0) + 1;
  }
  return { records, failures, failuresByAgent, state: scan.state };
}
