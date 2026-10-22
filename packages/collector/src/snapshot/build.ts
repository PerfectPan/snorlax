import { addDays, format, startOfDay, subDays } from "date-fns";
import { tz, TZDate } from "@date-fns/tz";

import type {
  ByAgentEntry,
  ByDeviceEntry,
  ByModelEntry,
  DailyEntry,
  HourlyEntry,
  Snapshot,
  WindowTotal
} from "@rivus/snorlax-protocol";

import type { BucketRow, RemoteBucketRow, RemoteDeviceRow } from "../ledger/ledger.ts";

/** A local or remote bucket as one flat row for the windows and series. */
export interface SnapshotBucket {
  readonly deviceId: string;
  readonly hour: number;
  readonly agent: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly requests: number;
  readonly sessionsStarted: number;
  readonly costUsd: number;
  readonly unpricedRequests: number;
}

export interface BuildSnapshotInput {
  readonly now: number;
  /** IANA time zone of the device that shows the snapshot; days follow it (Spec R8). */
  readonly timeZone: string;
  readonly thisDevice: { readonly id: string; readonly name: string | null };
  readonly buckets: readonly BucketRow[];
  readonly remoteBuckets: readonly RemoteBucketRow[];
  readonly remoteDevices: readonly RemoteDeviceRow[];
  readonly lastScanAt: number | null;
  readonly failuresByAgent: Record<string, number>;
  readonly paired: boolean;
}

const emptyTotal = (): WindowTotal => ({
  tokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0,
  requests: 0,
  sessions: 0,
  unpricedRequests: 0
});

interface Windows {
  readonly dayStart: number;
  readonly dayEnd: number;
  readonly last7dStart: number;
  readonly last30dStart: number;
}

const windowsOf = (now: number, timeZone: string): Windows => {
  const inZone = tz(timeZone);
  const today = startOfDay(now, { in: inZone });
  return {
    dayStart: +today,
    dayEnd: +addDays(today, 1),
    last7dStart: +subDays(today, 6),
    last30dStart: +subDays(today, 29)
  };
};

/** `tokens` is `inputTokens + outputTokens` in the kit convention (plan 3.2.2). */
const tokensOf = (bucket: SnapshotBucket): number => bucket.inputTokens + bucket.outputTokens;

const addBucket = (total: WindowTotal, bucket: SnapshotBucket): void => {
  total.tokens += tokensOf(bucket);
  total.inputTokens += bucket.inputTokens;
  total.outputTokens += bucket.outputTokens;
  total.cacheReadTokens += bucket.cacheReadTokens;
  total.costUsd += bucket.costUsd;
  total.requests += bucket.requests;
  total.sessions += bucket.sessionsStarted;
  total.unpricedRequests += bucket.unpricedRequests;
};

const sumWindows = (
  buckets: readonly SnapshotBucket[],
  windows: Windows
): { today: WindowTotal; last7d: WindowTotal; last30d: WindowTotal } => {
  const today = emptyTotal();
  const last7d = emptyTotal();
  const last30d = emptyTotal();
  for (const bucket of buckets) {
    const at = bucket.hour * 1000;
    if (at >= windows.dayStart && at < windows.dayEnd) {
      addBucket(today, bucket);
    }
    if (at >= windows.last7dStart && at < windows.dayEnd) {
      addBucket(last7d, bucket);
    }
    if (at >= windows.last30dStart && at < windows.dayEnd) {
      addBucket(last30d, bucket);
    }
  }
  return { today, last7d, last30d };
};

const seriesOf = (
  buckets: readonly SnapshotBucket[],
  windows: Windows,
  timeZone: string
): { daily: DailyEntry[]; hourlyToday: HourlyEntry[] } => {
  const inZone = tz(timeZone);
  const today = startOfDay(windows.dayStart, { in: inZone });
  const byDay = new Map<number, { tokens: number; costUsd: number }>();
  const byHour = new Map<number, number>();
  for (const bucket of buckets) {
    const at = bucket.hour * 1000;
    const day = +startOfDay(at, { in: inZone });
    if (day >= windows.last30dStart && day < windows.dayEnd) {
      const daily = byDay.get(day) ?? { tokens: 0, costUsd: 0 };
      daily.tokens += tokensOf(bucket);
      daily.costUsd += bucket.costUsd;
      byDay.set(day, daily);
    }
    if (day === windows.dayStart) {
      byHour.set(bucket.hour, (byHour.get(bucket.hour) ?? 0) + tokensOf(bucket));
    }
  }
  const daily: DailyEntry[] = [];
  for (let back = 29; back >= 0; back -= 1) {
    const day = +subDays(today, back);
    const entry = byDay.get(day) ?? { tokens: 0, costUsd: 0 };
    daily.push({ date: format(new TZDate(day, timeZone), "yyyy-MM-dd"), tokens: entry.tokens, costUsd: entry.costUsd });
  }
  const hourlyToday = [...byHour.entries()]
    .map((hour): HourlyEntry => ({
      hour: format(new TZDate(hour[0] * 1000, timeZone), "yyyy-MM-dd'T'HH:mm:ssXXX"),
      tokens: hour[1]
    }))
    .sort((a, b) => a.hour.localeCompare(b.hour));
  return { daily, hourlyToday };
};

const groupEntries = <K extends string>(
  buckets: readonly SnapshotBucket[],
  windows: Windows,
  keyOf: (bucket: SnapshotBucket) => K
): { key: K; today: WindowTotal; last7d: WindowTotal; last30d: WindowTotal }[] => {
  const groups = new Map<K, { today: WindowTotal; last7d: WindowTotal; last30d: WindowTotal }>();
  for (const bucket of buckets) {
    if (bucket.hour * 1000 < windows.last30dStart) {
      continue;
    }
    const key = keyOf(bucket);
    const entry = groups.get(key) ?? { today: emptyTotal(), last7d: emptyTotal(), last30d: emptyTotal() };
    groups.set(key, entry);
    const at = bucket.hour * 1000;
    if (at >= windows.dayStart && at < windows.dayEnd) {
      addBucket(entry.today, bucket);
    }
    if (at >= windows.last7dStart && at < windows.dayEnd) {
      addBucket(entry.last7d, bucket);
    }
    addBucket(entry.last30d, bucket);
  }
  return [...groups.entries()].map(([key, entry]) => ({ key, ...entry }));
};

/**
 * Builds the snapshot from the ledger's rows (plan 3.2.2, 3.4.1 step 7). A bucket belongs to the local day
 * and hour that contain its UTC start hour; `daily` covers the last 30 local days including today and
 * `hourlyToday` the local hours of today, both in `timeZone`. Entries appear only for agents, models and
 * devices with usage inside the 30-day window.
 */
export function buildSnapshot(input: BuildSnapshotInput): Snapshot {
  const windows = windowsOf(input.now, input.timeZone);
  const all: SnapshotBucket[] = [
    ...input.buckets.map((bucket): SnapshotBucket => ({ ...bucket, deviceId: input.thisDevice.id })),
    ...input.remoteBuckets.map((bucket): SnapshotBucket => ({
      deviceId: bucket.deviceId,
      hour: bucket.hour,
      agent: bucket.agent,
      model: bucket.model,
      inputTokens: bucket.inputTokens,
      cacheReadTokens: bucket.cacheReadTokens,
      cacheWriteTokens: bucket.cacheWriteTokens,
      outputTokens: bucket.outputTokens,
      reasoningTokens: bucket.reasoningTokens,
      requests: bucket.requests,
      sessionsStarted: bucket.sessionsStarted,
      costUsd: bucket.costUsd,
      unpricedRequests: bucket.unpricedRequests
    }))
  ];
  const inWindow = all.filter((bucket) => bucket.hour * 1000 >= windows.last30dStart);
  const totals = sumWindows(inWindow, windows);
  const byAgent: ByAgentEntry[] = groupEntries(inWindow, windows, (bucket) => bucket.agent).map((group) => ({
    agent: group.key,
    today: group.today,
    last7d: group.last7d,
    last30d: group.last30d
  }));
  const byModel: ByModelEntry[] = groupEntries(inWindow, windows, (bucket) => bucket.model).map((group) => ({
    model: group.key,
    today: group.today,
    last7d: group.last7d,
    last30d: group.last30d
  }));
  const byDevice: ByDeviceEntry[] = [
    {
      deviceId: input.thisDevice.id,
      name: input.thisDevice.name,
      isThisDevice: true,
      lastPushAt: null,
      ...(() => {
        const own = inWindow.filter((bucket) => bucket.deviceId === input.thisDevice.id);
        return sumWindows(own, windows);
      })()
    },
    ...input.remoteDevices
      .filter((device) => !device.revoked)
      .map((device): ByDeviceEntry => {
        const own = inWindow.filter((bucket) => bucket.deviceId === device.id);
        return {
          deviceId: device.id,
          name: device.name,
          isThisDevice: false,
          lastPushAt: device.lastPushAt === null ? null : new Date(device.lastPushAt).toISOString(),
          ...sumWindows(own, windows)
        };
      })
  ];
  const { daily, hourlyToday } = seriesOf(inWindow, windows, input.timeZone);
  return {
    schemaVersion: 1,
    generatedAt: new Date(input.now).toISOString(),
    timeZone: input.timeZone,
    totals,
    byAgent,
    byModel,
    byDevice,
    daily,
    hourlyToday,
    status: {
      lastScanAt: input.lastScanAt === null ? null : new Date(input.lastScanAt).toISOString(),
      // Batch 2 has no sync: the snapshot reports the device as not paired (plan 6.4 Batch 2).
      sync: { state: "unpaired", at: null },
      failuresByAgent: input.failuresByAgent,
      paired: input.paired
    }
  };
}
