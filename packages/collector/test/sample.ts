import type { Snapshot, WindowTotal } from "@rivus/snorlax-protocol";

export const zeroTotal: WindowTotal = {
  tokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  costUsd: 0,
  requests: 0,
  sessions: 0,
  unpricedRequests: 0
};

/** A minimal snapshot that satisfies the protocol schema; tests override what they care about. */
export const makeSnapshot = (overrides?: Partial<Snapshot>): Snapshot => ({
  schemaVersion: 1,
  generatedAt: "2026-10-22T12:00:00.000Z",
  timeZone: "Asia/Shanghai",
  totals: { today: zeroTotal, last7d: zeroTotal, last30d: zeroTotal },
  byAgent: [],
  byModel: [],
  byDevice: [
    {
      deviceId: "11111111-2222-4333-8444-555555555555",
      name: "Test Mac",
      isThisDevice: true,
      lastPushAt: null,
      today: zeroTotal,
      last7d: zeroTotal,
      last30d: zeroTotal
    }
  ],
  daily: [],
  hourlyToday: [],
  status: {
    lastScanAt: "2026-10-22T11:59:00.000Z",
    sync: { state: "ok", at: "2026-10-22T12:00:00.000Z" },
    failuresByAgent: {},
    paired: true
  },
  ...overrides
});
