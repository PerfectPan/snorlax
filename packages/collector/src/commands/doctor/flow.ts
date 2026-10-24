import type { Doctor } from "@rivus/snorlax-protocol";
import { Effect } from "effect";

import { errorMessage } from "../../core/error-message/error-message.ts";
import { readConfig } from "../../modules/config/config.ts";
import { resolveDataDir } from "../../modules/data-dir/data-dir.ts";
import { NodeFiles, SnorlaxPlatform } from "../../modules/platform/platform.ts";
import { RuntimeInfo } from "../../modules/version/version.ts";
import {
  configCheck,
  dataDirCheck,
  doctorPayload,
  nodeVersionCheck,
  type ConfigObservation,
  type DataDirObservation
} from "./checks.ts";

/**
 * Local diagnostics only in this milestone (plan 3.1, 3.13): Node version, data directory and config.
 * The flow only observes — `stat`, the mode read and the config read; it creates nothing and repairs
 * nothing, so a missing data directory is a failed check in the payload, not something the command
 * fixes on the way in. Keychain, backend and scheduling checks arrive with the batches that own them.
 * The command exits 0 whenever it completes; `healthy` reports whether any check failed, and a failing
 * `stat` or mode read is a defect.
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
  const payload = doctorPayload([nodeVersionCheck(info.nodeVersion), dataDirCheck(observed), configCheck(config)]);
  return { schemaVersion: 1, ok: true, healthy: payload.healthy, checks: payload.checks } satisfies Doctor;
});
