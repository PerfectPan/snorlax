import { basename, join } from "node:path";

import { acquireProcessLock } from "@rivus/agent-kit-collab/process-lock";
import { Duration, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";

import { ledgerPath, readLedgerStatus } from "../src/modules/ledger/ledger.ts";
import { LOCK_WAIT_MS } from "../src/modules/ledger/lock.ts";
import { listBackups } from "../src/modules/ledger/migrations.ts";
import type { Logger } from "../src/modules/log/log.ts";
import { appendClaudeRequests, quietMtime, writeClaudeSession } from "./fixtures/agents.ts";
import { readLedger, rebuildRun, refreshRun, runRebuild, runRefresh, type RunDeps } from "./fixtures/flows.ts";
import { createRefreshSetup, type RefreshSetup, type TestPlatform } from "./fixtures/platform.ts";

/**
 * One refresh at a time per data directory (plan 3.5): the ledger lock serializes overlapping runs, and
 * the ledger — migration, backup, meta and scan state included — opens only under it. A gate hung inside
 * the first run's scan holds the lock mid-transaction, so the second run provably starts while the lock is
 * held. The same gate holds a run mid-scan while it is interrupted (plan 3.13 rule 6: the lock and the ledger
 * are released with the run's scope), and a waiter's lock timeout runs on `TestClock`; no test sleeps or
 * asserts on real elapsed time. Fixtures are generated under a temporary home and removed afterwards.
 */

const NOW = Date.UTC(2026, 9, 22, 12, 0, 0);
const MTIME = quietMtime(NOW);
const HOUR_9 = Date.UTC(2026, 9, 22, 9) / 1000;
const HOUR_10 = Date.UTC(2026, 9, 22, 10) / 1000;
const TIME_ZONE = "UTC";
const CC_PROJECT = join(".claude", "projects", "-Users-tester-fixture");
const SILENT_LOG: Logger = { event: () => Effect.void };

const cc1Path = (home: string): string => join(home, CC_PROJECT, "cc-1.jsonl");

const writeFixtures = async (home: string): Promise<void> => {
  await writeClaudeSession(home, {
    sessionId: "cc-1",
    mtimeMs: MTIME,
    requests: [
      {
        requestId: "lock-r1",
        model: "claude-opus-5-5",
        timestampMs: (HOUR_9 + 5 * 60) * 1000,
        usage: { inputTokens: 100, outputTokens: 10 }
      },
      {
        requestId: "lock-r2",
        model: "claude-haiku-4-5",
        timestampMs: (HOUR_9 + 10 * 60) * 1000,
        usage: { inputTokens: 50, outputTokens: 5 }
      }
    ]
  });
};

const appendOne = (home: string): Promise<void> =>
  appendClaudeRequests(
    cc1Path(home),
    [
      {
        requestId: "lock-r3",
        model: "claude-opus-5-5",
        timestampMs: (HOUR_10 + 20 * 60) * 1000,
        usage: { inputTokens: 70, outputTokens: 7 }
      }
    ],
    "cc-1",
    MTIME
  );

const refreshOn = (platform: TestPlatform, setup: RefreshSetup): Promise<unknown> =>
  runRefresh({ platform, dataDir: setup.dataDir, log: SILENT_LOG, timeZone: TIME_ZONE });

const rebuildOn = (platform: TestPlatform, setup: RefreshSetup): Promise<unknown> =>
  runRebuild({ platform, dataDir: setup.dataDir, log: SILENT_LOG, timeZone: TIME_ZONE }, 30);

/** The ledger result two runs must land on, whichever order they ran in: buckets and the scan time. */
const stateOf = (setup: RefreshSetup): Promise<unknown> =>
  readLedger(setup.platform, setup.dataDir, (ledger) =>
    Effect.map(ledger.readBuckets(), (buckets) => ({ lastScanCompletedAt: ledger.meta.lastScanCompletedAt, buckets }))
  );

const setUserVersion = (setup: RefreshSetup, version: number): void => {
  const db = setup.platform.sqlite.open(ledgerPath(setup.dataDir));
  try {
    db.exec(`PRAGMA user_version = ${version}`);
  } finally {
    db.close();
  }
};

interface Probe {
  readonly platform: TestPlatform;
  /** Resolves when the gated run reads its gate path for the first time: mid-scan, under the lock. */
  readonly gateReached: Promise<void>;
  releaseGate: () => void;
  readonly events: readonly string[];
  /** Resolves once `event` has been recorded `occurrence` times. */
  waitForEvent: (event: string, occurrence: number) => Promise<void>;
}

/**
 * A platform that records what a run does around the ledger lock — resolving the lock's path, opening the
 * ledger, backing it up — and hangs the first read of `gatePath` on a gate, so a run sits mid-scan holding
 * the lock until `releaseGate`. Events fire before the wrapped call they describe.
 */
const probedPlatform = (setup: RefreshSetup, gatePath: string): Probe => {
  const events: string[] = [];
  const waiters: ((count: number) => void)[] = [];
  const record = (event: string): void => {
    events.push(event);
    for (const waiter of waiters.splice(0)) {
      waiter(events.filter((seen) => seen === event).length);
    }
  };
  const countOf = (event: string): number => events.filter((seen) => seen === event).length;
  const waitForEvent = (event: string, occurrence: number): Promise<void> =>
    countOf(event) >= occurrence
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          waiters.push((count) => {
            if (count >= occurrence) {
              resolve();
            }
          });
        });

  let resolveTripped!: () => void;
  const gateReached = new Promise<void>((resolve) => {
    resolveTripped = resolve;
  });
  let releaseGate!: () => void;
  const gateReleased = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let gateTripped = false;
  const base = setup.platform.fs;

  const platform: TestPlatform = {
    ...setup.platform,
    fs: {
      ...base,
      realpath: async (path) => {
        const resolved = await base.realpath(path);
        if (path.startsWith(setup.dataDir)) {
          record("realpath");
        }
        return resolved;
      },
      stat: async (path, options) => {
        const stat = await base.stat(path, options);
        if (path === ledgerPath(setup.dataDir)) {
          record("open");
        }
        return stat;
      },
      writeAtomic: async (path, data, options) => {
        if (basename(path).startsWith("ledger.db.bak-v")) {
          record("backup");
        }
        await base.writeAtomic(path, data, options);
        if (basename(path) === "snapshot.json") {
          record("snapshot");
        }
      },
      read(path, range) {
        if (path === gatePath && !gateTripped) {
          gateTripped = true;
          record("gate");
          resolveTripped();
          return (async function* () {
            await gateReleased;
            yield* base.read(path, range);
          })();
        }
        return base.read(path, range);
      }
    }
  };
  return { platform, gateReached, releaseGate, events, waitForEvent };
};

describe("overlapping runs count every request once", () => {
  it("lands a refresh pair where the same runs in sequence land", async () => {
    const sequential = await createRefreshSetup({ now: NOW });
    const parallel = await createRefreshSetup({ now: NOW });
    try {
      for (const setup of [sequential, parallel]) {
        await writeFixtures(setup.home);
        await refreshOn(setup.platform, setup);
        await appendOne(setup.home);
      }
      await refreshOn(sequential.platform, sequential);
      await refreshOn(sequential.platform, sequential);

      const probe = probedPlatform(parallel, cc1Path(parallel.home));
      const first = refreshOn(probe.platform, parallel);
      await probe.gateReached;
      const second = refreshOn(probe.platform, parallel);
      probe.releaseGate();
      const outcomes = await Promise.all([first, second]);
      for (const outcome of outcomes) {
        expect((outcome as { result: { ok: boolean } }).result.ok).toBe(true);
      }

      expect(await stateOf(parallel)).toEqual(await stateOf(sequential));
    } finally {
      await parallel.remove();
      await sequential.remove();
    }
  });

  it("lands a refresh plus rebuild where the same runs in sequence land", async () => {
    const sequential = await createRefreshSetup({ now: NOW });
    const parallel = await createRefreshSetup({ now: NOW });
    try {
      for (const setup of [sequential, parallel]) {
        await writeFixtures(setup.home);
        await refreshOn(setup.platform, setup);
        await appendOne(setup.home);
      }
      await refreshOn(sequential.platform, sequential);
      await rebuildOn(sequential.platform, sequential);

      const probe = probedPlatform(parallel, cc1Path(parallel.home));
      const first = refreshOn(probe.platform, parallel);
      await probe.gateReached;
      const second = rebuildOn(probe.platform, parallel);
      probe.releaseGate();
      const outcomes = await Promise.all([first, second]);
      for (const outcome of outcomes) {
        expect((outcome as { result: { ok: boolean } }).result.ok).toBe(true);
      }

      expect(await stateOf(parallel)).toEqual(await stateOf(sequential));
    } finally {
      await parallel.remove();
      await sequential.remove();
    }
  });
});

describe("the ledger opens under the lock", () => {
  it("migrates and backs up only while holding the lock, and a waiter opens nothing before it", async () => {
    const setup = await createRefreshSetup({ now: NOW });
    try {
      await writeFixtures(setup.home);
      await refreshOn(setup.platform, setup);
      setUserVersion(setup, 0);

      const probe = probedPlatform(setup, cc1Path(setup.home));
      const first = refreshOn(probe.platform, setup);
      await probe.gateReached;
      // The holder resolved the lock's path before its backup, and the backup precedes its mid-scan gate:
      // the migration ran under the lock it holds here.
      expect(probe.events.indexOf("realpath")).toBeGreaterThanOrEqual(0);
      expect(probe.events.indexOf("realpath")).toBeLessThan(probe.events.indexOf("backup"));
      expect(probe.events.indexOf("backup")).toBeLessThan(probe.events.indexOf("gate"));

      const second = refreshOn(probe.platform, setup);
      await probe.waitForEvent("realpath", 2);
      // The second run reached the lock and is waiting: it has opened no ledger and written no backup.
      expect(probe.events.filter((event) => event === "open")).toHaveLength(1);
      expect(probe.events.filter((event) => event === "backup")).toHaveLength(1);

      probe.releaseGate();
      const outcomes = await Promise.all([first, second]);
      for (const outcome of outcomes) {
        expect((outcome as { result: { ok: boolean } }).result.ok).toBe(true);
      }
      expect(probe.events.filter((event) => event === "open")).toHaveLength(2);
      expect(probe.events.filter((event) => event === "backup")).toHaveLength(1);
      expect((await listBackups(setup.platform.fs, setup.dataDir)).map((backup) => backup.version)).toEqual([0]);
    } finally {
      await setup.remove();
    }
  });

  it("serves the read-only status while a run holds the lock", async () => {
    const setup = await createRefreshSetup({ now: NOW });
    try {
      await writeFixtures(setup.home);
      await refreshOn(setup.platform, setup);

      const probe = probedPlatform(setup, cc1Path(setup.home));
      const run = refreshOn(probe.platform, setup);
      await probe.gateReached;

      const status = await Effect.runPromise(readLedgerStatus(setup.platform, setup.dataDir));
      expect(status?.deviceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(status?.lastScanCompletedAt).toBe(NOW);

      probe.releaseGate();
      await run;
    } finally {
      await setup.remove();
    }
  });
});

/** Counts the ledger connections a run opens and closes, through the platform's SQLite. */
const countingLedgerConnections = (
  platform: TestPlatform,
  setup: RefreshSetup
): { readonly platform: TestPlatform; readonly connections: { opened: number; closed: number } } => {
  const connections = { opened: 0, closed: 0 };
  return {
    connections,
    platform: {
      ...platform,
      sqlite: {
        open: (path, options) => {
          const db = platform.sqlite.open(path, options);
          if (path !== ledgerPath(setup.dataDir)) {
            return db;
          }
          connections.opened += 1;
          return {
            exec: (sql) => db.exec(sql),
            prepare: (sql) => db.prepare(sql),
            close: () => {
              connections.closed += 1;
              db.close();
            }
          };
        }
      }
    }
  };
};

describe("an interrupted run", () => {
  const runs = [
    ["refresh", (deps: RunDeps) => refreshRun(deps)],
    ["rebuild", (deps: RunDeps) => rebuildRun(deps, 30)]
  ] as const;
  for (const [name, run] of runs) {
    it(`${name} releases the ledger lock, closes the ledger and leaves it as it was`, async () => {
      const setup = await createRefreshSetup({ now: NOW });
      try {
        await writeFixtures(setup.home);
        await refreshOn(setup.platform, setup);
        await appendOne(setup.home);
        const before = await stateOf(setup);

        const probe = probedPlatform(setup, cc1Path(setup.home));
        const counted = countingLedgerConnections(probe.platform, setup);
        const fiber = Effect.runFork(
          run({ platform: counted.platform, dataDir: setup.dataDir, log: SILENT_LOG, timeZone: TIME_ZONE })
        );
        await probe.gateReached;
        // Mid-scan, inside the transaction (a rebuild has zeroed its window by now), holding the lock.
        expect(counted.connections).toEqual({ opened: 1, closed: 0 });

        await Effect.runPromise(Fiber.interrupt(fiber));
        probe.releaseGate();

        expect(counted.connections).toEqual({ opened: 1, closed: 1 });
        // The lock is free in this process and in SQLite: an attempt that does not wait takes it.
        const relock = await acquireProcessLock(setup.platform, join(setup.dataDir, "ledger.lock"));
        expect(relock.ok).toBe(true);
        if (relock.ok) {
          await relock.value.release();
        }
        expect(await stateOf(setup)).toEqual(before);
      } finally {
        await setup.remove();
      }
    });
  }
});

describe("a held lock", () => {
  it("fails a waiting refresh as locked once the injected clock passes the wait", async () => {
    const setup = await createRefreshSetup({ now: NOW });
    try {
      await writeFixtures(setup.home);
      await refreshOn(setup.platform, setup);
      await appendOne(setup.home);

      const probe = probedPlatform(setup, cc1Path(setup.home));
      const holder = refreshOn(probe.platform, setup);
      await probe.gateReached;

      const deps = { platform: probe.platform, dataDir: setup.dataDir, log: SILENT_LOG, timeZone: TIME_ZONE };
      const failure = await Effect.runPromise(
        Effect.gen(function* () {
          const waiter = yield* Effect.forkChild(Effect.flip(refreshRun(deps)));
          // The waiter has reached the lock, so its wait is on the test clock.
          yield* Effect.promise(() => probe.waitForEvent("realpath", 2));
          yield* TestClock.adjust(Duration.millis(LOCK_WAIT_MS));
          return yield* Fiber.join(waiter);
        }).pipe(Effect.provide(TestClock.layer()))
      );
      expect(failure._tag).toBe("LedgerLockHeld");
      expect(failure.message).toMatch(/^waited 60s for the ledger lock .*ledger\.lock: /);

      probe.releaseGate();
      expect(((await holder) as { result: { ok: boolean } }).result.ok).toBe(true);
    } finally {
      await setup.remove();
    }
  });
});
