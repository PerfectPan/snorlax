import type { Platform } from "@rivus/agent-kit/platform";
import type { Doctor } from "@rivus/snorlax-protocol";
import { Effect } from "effect";

import { Scheduler } from "../../capabilities/scheduler/scheduler.ts";
import { errorMessage } from "../../core/error-message/error-message.ts";
import { readConfig } from "../../modules/config/config.ts";
import { resolveDataDir } from "../../modules/data-dir/data-dir.ts";
import { NodeFiles, SnorlaxPlatform, type NodeFileOps } from "../../modules/platform/platform.ts";
import { RuntimeInfo } from "../../modules/version/version.ts";
import {
  configCheck,
  dataDirCheck,
  doctorPayload,
  nodeVersionCheck,
  scheduleCheck,
  type ConfigObservation,
  type DataDirObservation,
  type NodeBinary
} from "./checks.ts";

/** Runnable means a regular file, symlinks followed, with an execute bit set. */
const nodeBinaryAt = (
  platform: Pick<Platform, "fs">,
  nodeFiles: NodeFileOps,
  path: string
): Effect.Effect<NodeBinary> =>
  Effect.gen(function* () {
    const found = yield* Effect.promise(() => platform.fs.stat(path, { followSymlinks: true }));
    if (found === undefined) {
      return "missing";
    }
    const mode = yield* Effect.promise(() => nodeFiles.mode(path));
    return found.kind === "file" && mode !== undefined && (mode & 0o111) !== 0 ? "runnable" : "not-executable";
  });

/**
 * Local diagnostics (plan 3.1, 3.13): Node version, data directory, config and the scheduled refresh.
 * The flow only observes — `stat`, the mode read, the config read and the scheduler's `inspect`; it
 * creates nothing and repairs nothing, so a missing data directory is a failed check in the payload, not
 * something the command fixes on the way in. Keychain and backend checks arrive with the batches that own
 * them. The command exits 0 whenever it completes; `healthy` reports whether any check failed, and a
 * failing `stat` or mode read is a defect.
 */
export const doctorFlow = Effect.gen(function* () {
  const platform = yield* SnorlaxPlatform;
  const nodeFiles = yield* NodeFiles;
  const info = yield* RuntimeInfo;
  const path = resolveDataDir(platform);
  const stat = yield* Effect.promise(() => platform.fs.stat(path));
  const observed: DataDirObservation =
    stat === undefined
      ? { path, kind: "missing", mode: undefined }
      : {
          path,
          kind: stat.kind === "dir" ? "dir" : stat.kind === "file" ? "file" : "other",
          mode: yield* Effect.promise(() => nodeFiles.mode(path))
        };
  // The config read is a check of its own: a config that does not parse and a read that throws both fail it.
  const config: ConfigObservation = yield* readConfig(platform, path).pipe(
    Effect.as({ ok: true } as const),
    Effect.catch((error) => Effect.succeed({ ok: false, message: error.message } as const)),
    Effect.catchDefect((defect) => Effect.succeed({ ok: false, message: errorMessage(defect) } as const))
  );
  const job = yield* (yield* Scheduler).inspect;
  const nodePath = job.kind === "inspected" ? job.cliJob?.nodePath : undefined;
  const node = nodePath === undefined ? undefined : yield* nodeBinaryAt(platform, nodeFiles, nodePath);
  const payload = doctorPayload([
    nodeVersionCheck(info.nodeVersion),
    dataDirCheck(observed),
    configCheck(config),
    scheduleCheck({ job, node })
  ]);
  return { schemaVersion: 1, ok: true, healthy: payload.healthy, checks: payload.checks } satisfies Doctor;
});
