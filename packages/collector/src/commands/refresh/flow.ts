import { Effect } from "effect";

import { pairedSync } from "../../capabilities/backend/backend.ts";
import { ensureDataDir, resolveDataDir } from "../../modules/data-dir/data-dir.ts";
import { refreshScan, scanAndCommit } from "../../modules/ledger/ledger.ts";
import { appendingLogger } from "../../modules/log/log.ts";
import { NodeFiles, SnorlaxPlatform } from "../../modules/platform/platform.ts";
import { TimeZone } from "../../modules/time-zone/time-zone.ts";

/**
 * One `snorlax refresh` (plan 3.4.1): prepares the data directory (creating it and its `logs` directory on
 * first use — this is a command that owns that side effect), then scans incrementally from the saved scan
 * state through the ledger's scan-and-commit.
 */
export const refreshFlow = Effect.gen(function* () {
  const platform = yield* SnorlaxPlatform;
  const nodeFiles = yield* NodeFiles;
  const dataDir = resolveDataDir(platform);
  yield* ensureDataDir(platform, nodeFiles, dataDir);
  const log = appendingLogger(platform, nodeFiles, dataDir);
  const sync = yield* pairedSync({ platform, dataDir });
  return yield* scanAndCommit({ platform, dataDir, log, timeZone: yield* TimeZone, sync }, refreshScan);
});
