import { basename } from "node:path";

import { Effect } from "effect";

import { rebuildScan } from "../../src/commands/rebuild/flow.ts";
import {
  openLedger,
  refreshScan,
  scanAndCommit,
  type Ledger,
  type LedgerPlatform,
  type ScanAndCommitDeps
} from "../../src/modules/ledger/ledger.ts";
import type { TestPlatform } from "./platform.ts";

/**
 * The refresh and rebuild runs on a test bed: the commands' scan-and-commit runs over `deps` in place of what the
 * flows read from the environment, and nothing prepares the data directory because the test bed has created it.
 */
export interface RunDeps extends ScanAndCommitDeps {
  readonly platform: TestPlatform;
}

/** Spec S3's killed run: it dies with the whole scan decoded, before its transaction commits. */
export interface RunHooks {
  readonly failBeforeCommit?: boolean;
}

export const refreshRun = (deps: RunDeps) => scanAndCommit(deps, refreshScan);

export const rebuildRun = (deps: RunDeps, days: number) => scanAndCommit(deps, rebuildScan(days));

/**
 * Fails the run's last ledger write before the commit — `last_scan_completed_at` — through the platform's SQLite,
 * so the run dies the way a killed process would, after the scan and before the commit.
 */
const crashingBeforeCommit = (platform: TestPlatform): TestPlatform => ({
  ...platform,
  sqlite: {
    open: (path, options) => {
      const db = platform.sqlite.open(path, options);
      if (basename(path) !== "ledger.db") {
        return db;
      }
      return {
        exec: (sql) => db.exec(sql),
        close: () => db.close(),
        prepare: (sql) => {
          const statement = db.prepare(sql);
          return sql.startsWith("UPDATE meta SET last_scan_completed_at")
            ? {
                run: () => {
                  throw new Error("simulated crash between decode and commit (Spec S3)");
                },
                get: (...params) => statement.get(...params),
                all: (...params) => statement.all(...params)
              }
            : statement;
        }
      };
    }
  }
});

const withHooks = (deps: RunDeps, hooks: RunHooks | undefined): RunDeps =>
  hooks?.failBeforeCommit === true ? { ...deps, platform: crashingBeforeCommit(deps.platform) } : deps;

export const runRefresh = (deps: RunDeps, hooks?: RunHooks) => Effect.runPromise(refreshRun(withHooks(deps, hooks)));

export const runRebuild = (deps: RunDeps, days: number, hooks?: RunHooks) =>
  Effect.runPromise(rebuildRun(withHooks(deps, hooks), days));

/** Opens the ledger for one read and closes it again, as a separate run would. */
export const readLedger = <A, E>(
  platform: LedgerPlatform,
  dataDir: string,
  read: (ledger: Ledger) => Effect.Effect<A, E>
): Promise<A> => Effect.runPromise(Effect.scoped(Effect.flatMap(openLedger(platform, dataDir), read)));
