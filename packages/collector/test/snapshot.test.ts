import { buildSnapshot } from "../src/snapshot/build.ts";
import type { BucketRow } from "../src/ledger/ledger.ts";
import { describe, expect, it } from "vite-plus/test";

/**
 * Spec S10 and the snapshot's windows and series (plan 3.2.2): days follow the viewer's time zone, a
 * bucket belongs to the local day and hour that contain its UTC start hour, `daily` covers the last 30
 * local days including today and `hourlyToday` today's local hours. Built directly from ledger rows with a
 * fixed clock, so every boundary is exact.
 */

const utc = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

const bucket = (hourUtc: string, overrides: Partial<BucketRow> = {}): BucketRow => ({
  hour: utc(hourUtc),
  agent: "claude-code",
  model: "claude-opus-5-5",
  inputTokens: 1000,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 100,
  reasoningTokens: 0,
  requests: 1,
  sessionsStarted: 0,
  costUsd: 0.25,
  unpricedRequests: 0,
  dirty: false,
  ...overrides
});

const build = (options: { now: number; timeZone: string; buckets: readonly BucketRow[] }) =>
  buildSnapshot({
    now: options.now,
    timeZone: options.timeZone,
    thisDevice: { id: "11111111-2222-4333-8444-555555555555", name: "Test Mac" },
    buckets: options.buckets,
    remoteBuckets: [],
    remoteDevices: [],
    lastScanAt: options.now - 60_000,
    failuresByAgent: {},
    paired: false
  });

describe("S10: days follow the viewer's time zone", () => {
  it("puts the 15:00Z bucket on 2026-10-22 and the 16:00Z and 17:00Z buckets on 2026-10-23 in Asia/Shanghai", () => {
    const snapshot = build({
      now: Date.UTC(2026, 9, 23, 4, 0, 0),
      timeZone: "Asia/Shanghai",
      buckets: [bucket("2026-10-22T15:00:00Z"), bucket("2026-10-22T16:00:00Z"), bucket("2026-10-22T17:00:00Z")]
    });

    const byDate = new Map(snapshot.daily.map((day) => [day.date, day]));
    expect(byDate.get("2026-10-22")).toMatchObject({ tokens: 1100, costUsd: 0.25 });
    expect(byDate.get("2026-10-23")).toMatchObject({ tokens: 2200, costUsd: 0.5 });
  });

  it("assigns the same UTC hours to the days of a zone behind UTC", () => {
    const snapshot = build({
      now: Date.UTC(2026, 9, 23, 4, 0, 0),
      timeZone: "America/New_York",
      buckets: [bucket("2026-10-22T15:00:00Z"), bucket("2026-10-22T16:00:00Z")]
    });
    // 15:00Z and 16:00Z are 11:00 and 12:00 on 2026-10-22 in New York.
    const byDate = new Map(snapshot.daily.map((day) => [day.date, day]));
    expect(byDate.get("2026-10-22")).toMatchObject({ tokens: 2200 });
    expect(byDate.has("2026-10-23")).toBe(true);
    expect(byDate.get("2026-10-23")?.tokens).toBe(0);
  });
});

describe("windows", () => {
  // Local midnight in Asia/Shanghai is 16:00Z of the previous UTC day.
  const now = Date.UTC(2026, 9, 22, 12, 0, 0);

  it("today covers the local day, not the UTC one", () => {
    const snapshot = build({
      now,
      timeZone: "Asia/Shanghai",
      buckets: [bucket("2026-10-21T15:00:00Z"), bucket("2026-10-21T16:00:00Z"), bucket("2026-10-22T02:00:00Z")]
    });
    // 2026-10-21T16:00Z is midnight of the local 22nd; 15:00Z is still the local 21st.
    expect(snapshot.totals.today.tokens).toBe(1100 + 1100);
    expect(snapshot.totals.last7d.tokens).toBe(1100 + 1100 + 1100);
  });

  it("last7d covers the last seven local days including today", () => {
    const snapshot = build({
      now,
      timeZone: "Asia/Shanghai",
      buckets: [bucket("2026-10-15T15:00:00Z"), bucket("2026-10-15T16:00:00Z"), bucket("2026-10-21T15:00:00Z")]
    });
    // The window starts at local midnight of 2026-10-16 (2026-10-15T16:00Z); the 15:00Z bucket is the 15th.
    expect(snapshot.totals.last7d.tokens).toBe(1100 + 1100);
    expect(snapshot.totals.last30d.tokens).toBe(1100 + 1100 + 1100);
  });

  it("last30d covers the last thirty local days including today", () => {
    const snapshot = build({
      now,
      timeZone: "Asia/Shanghai",
      buckets: [bucket("2026-09-22T15:00:00Z"), bucket("2026-09-22T16:00:00Z")]
    });
    // Local midnight of 2026-09-23 is 2026-09-22T16:00Z; the 15:00Z bucket is 31 local days back.
    expect(snapshot.totals.last30d.tokens).toBe(1100);
  });

  it("sums sessions, requests, unpriced and cost per window", () => {
    const snapshot = build({
      now,
      timeZone: "Asia/Shanghai",
      buckets: [
        bucket("2026-10-22T02:00:00Z", {
          requests: 4,
          sessionsStarted: 2,
          unpricedRequests: 3,
          costUsd: 1.5
        }),
        bucket("2026-10-18T02:00:00Z", { requests: 10, sessionsStarted: 1, unpricedRequests: 10, costUsd: 0 })
      ]
    });
    expect(snapshot.totals.today).toMatchObject({ requests: 4, sessions: 2, unpricedRequests: 3, costUsd: 1.5 });
    expect(snapshot.totals.last7d).toMatchObject({ requests: 14, sessions: 3, unpricedRequests: 13 });
    expect(snapshot.totals.last30d.requests).toBe(14);
  });
});

describe("daily and hourlyToday", () => {
  const now = Date.UTC(2026, 9, 22, 12, 0, 0);

  it("lists the last 30 local days including today, oldest first, zeros included", () => {
    const snapshot = build({ now, timeZone: "Asia/Shanghai", buckets: [bucket("2026-10-22T02:00:00Z")] });
    expect(snapshot.daily).toHaveLength(30);
    expect(snapshot.daily[0]?.date).toBe("2026-09-23");
    expect(snapshot.daily.at(-1)).toMatchObject({ date: "2026-10-22", tokens: 1100, costUsd: 0.25 });
    const zeros = snapshot.daily.filter((day) => day.tokens === 0);
    expect(zeros).toHaveLength(29);
  });

  it("labels today's local hours with their numeric offset, earliest first", () => {
    const snapshot = build({
      now,
      timeZone: "Asia/Shanghai",
      buckets: [bucket("2026-10-22T02:00:00Z"), bucket("2026-10-21T16:00:00Z")]
    });
    expect(snapshot.hourlyToday).toEqual([
      { hour: "2026-10-22T00:00:00+08:00", tokens: 1100 },
      { hour: "2026-10-22T10:00:00+08:00", tokens: 1100 }
    ]);
  });
});

describe("shape", () => {
  it("carries the device entry and the unpaired status of this milestone", () => {
    const now = Date.UTC(2026, 9, 22, 12, 0, 0);
    const snapshot = build({ now, timeZone: "Asia/Shanghai", buckets: [bucket("2026-10-22T02:00:00Z")] });
    expect(snapshot.byDevice).toEqual([
      {
        deviceId: "11111111-2222-4333-8444-555555555555",
        name: "Test Mac",
        isThisDevice: true,
        lastPushAt: null,
        today: snapshot.totals.today,
        last7d: snapshot.totals.last7d,
        last30d: snapshot.totals.last30d
      }
    ]);
    expect(snapshot.status).toEqual({
      lastScanAt: new Date(now - 60_000).toISOString(),
      sync: { state: "unpaired", at: null },
      failuresByAgent: {},
      paired: false
    });
    expect(snapshot.generatedAt).toBe(new Date(now).toISOString());
  });
});
