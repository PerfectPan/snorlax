import process from "node:process";

import { isUsageRecord, scanUsage } from "@rivus/agent-kit/transcript/usage";

/** Platform `scanUsage` reads: files, home, environment and clock. */
export type ScanPlatform = Parameters<typeof scanUsage>[0];

type ScanState = ReturnType<typeof scanUsage>["state"];

/**
 * Two hours, the margin a refresh keeps behind `last_scan_completed_at` (plan 3.4.1). The incremental phase uses
 * that margin, so its duration is the refresh this measurement is for.
 */
const INCREMENTAL_SINCE_MARGIN_MS = 2 * 60 * 60 * 1000;

/**
 * Listing a missing agent home yields `RootMissing`. A `ReadFailed` while walking a directory is the same shape as
 * a decode `ReadFailed` on the scan stream, so those walks are counted with decode failures.
 */
const SOURCE_FAILURE_TAGS: ReadonlySet<string> = new Set(["RootMissing"]);

/** Counts from one phase. Agent ids are the only strings: state and records carry paths, models and session ids. */
export interface PhaseMeasurement {
  readonly phase: "full" | "incremental";
  readonly records: number;
  readonly sources: number;
  readonly decodeFailures: Readonly<Record<string, number>>;
  readonly sourceFailures: Readonly<Record<string, number>>;
  readonly durationMs: number;
  readonly peakRssBytes: number;
  readonly stateBytes: number;
}

export interface ScanMeasurement {
  readonly phases: readonly [PhaseMeasurement, PhaseMeasurement];
}

export interface MeasureScanOptions {
  /** Runs after the full scan has kept its state and before the incremental scan. The owner command leaves it unset. */
  readonly betweenPhases?: () => Promise<void> | void;
}

function counted(counts: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...counts.entries()].filter((entry) => entry[1] > 0).sort((left, right) => left[0].localeCompare(right[0]))
  );
}

function rssBytes(): number {
  return process.memoryUsage().rss;
}

async function runPhase(
  platform: ScanPlatform,
  phase: PhaseMeasurement["phase"],
  since: number,
  state: ScanState | undefined
): Promise<{ measurement: PhaseMeasurement; state: ScanState }> {
  const started = platform.clock.monotonic();
  let peakRssBytes = rssBytes();
  const decodeFailures = new Map<string, number>();
  const sourceFailures = new Map<string, number>();
  let records = 0;

  const scan = scanUsage(platform, state === undefined ? { since } : { since, state });
  for await (const item of scan) {
    peakRssBytes = Math.max(peakRssBytes, rssBytes());
    if (isUsageRecord(item)) {
      records += 1;
      continue;
    }
    const counts = SOURCE_FAILURE_TAGS.has(item.error._tag) ? sourceFailures : decodeFailures;
    counts.set(item.agent, (counts.get(item.agent) ?? 0) + 1);
  }
  peakRssBytes = Math.max(peakRssBytes, rssBytes());

  const saved = scan.state;
  return {
    state: saved,
    measurement: {
      phase,
      records,
      sources: Object.keys(saved.sources).length,
      decodeFailures: counted(decodeFailures),
      sourceFailures: counted(sourceFailures),
      durationMs: Math.max(0, Math.round(platform.clock.monotonic() - started)),
      peakRssBytes,
      stateBytes: Buffer.byteLength(JSON.stringify(saved))
    }
  };
}

/** One full scan (`since` 0, no state), then one incremental scan of the same homes with the saved state. */
export async function measureScan(platform: ScanPlatform, options: MeasureScanOptions = {}): Promise<ScanMeasurement> {
  const full = await runPhase(platform, "full", 0, undefined);
  await options.betweenPhases?.();
  const incrementalSince = Math.max(0, platform.clock.now() - INCREMENTAL_SINCE_MARGIN_MS);
  const incremental = await runPhase(platform, "incremental", incrementalSince, full.state);
  return { phases: [full.measurement, incremental.measurement] };
}
