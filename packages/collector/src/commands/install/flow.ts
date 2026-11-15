import { Effect } from "effect";

import { Scheduler } from "../../capabilities/scheduler/scheduler.ts";
import { ensureDataDir, resolveDataDir } from "../../modules/data-dir/data-dir.ts";
import { NodeFiles, SnorlaxPlatform } from "../../modules/platform/platform.ts";

/**
 * One `snorlax install`: schedules refresh over the data directory and returns the file the
 * job was written to. The data directory is prepared only once the scheduler has accepted the job as the
 * CLI's own, so a refused install builds nothing.
 */
export const installFlow = Effect.gen(function* () {
  const platform = yield* SnorlaxPlatform;
  const nodeFiles = yield* NodeFiles;
  const dataDir = resolveDataDir(platform);
  return yield* (yield* Scheduler).install({ dataDir }, ensureDataDir(platform, nodeFiles, dataDir));
});
