import type { Doctor as DoctorPayload } from "@rivus/snorlax-protocol";
import { SnorlaxPlatform } from "../../modules/platform/platform.ts";
import { Context, Effect, Layer } from "effect";

import { readConfig } from "../../modules/config/config.ts";
import { DataDir, NodeFiles } from "../../modules/data-dir/data-dir.ts";
import { RuntimeInfo } from "../../modules/version/version.ts";
import { errorMessage } from "../../core/error-message/error-message.ts";
import { configCheck, dataDirCheck, doctorPayload, nodeVersionCheck, type ConfigObservation } from "./checks.ts";

/**
 * Local diagnostics only in this milestone (plan 3.1, 3.13): Node version, data directory and config.
 * The service only observes — `stat`, the mode read and the config read; it creates nothing and
 * repairs nothing, so a missing data directory is a failed check in the payload, not something the
 * command fixes on the way in. Keychain, backend and scheduling checks arrive with the batches that
 * own them. The command exits 0 whenever it completes; `healthy` reports whether any check failed.
 */
export class Doctor extends Context.Service<
  Doctor,
  {
    readonly run: Effect.Effect<DoctorPayload>;
  }
>()("snorlax/doctor/Doctor") {
  static readonly live = Layer.effect(
    Doctor,
    Effect.gen(function* () {
      const platform = yield* SnorlaxPlatform;
      const dataDir = yield* DataDir;
      const ops = yield* NodeFiles;
      const info = yield* RuntimeInfo;
      return Doctor.of({
        // The config read is a check of its own; any other rejection is a defect.
        run: Effect.promise(async () => {
          const stat = await platform.fs.stat(dataDir.path);
          const observed =
            stat === undefined
              ? { path: dataDir.path, kind: "missing" as const, mode: undefined }
              : {
                  path: dataDir.path,
                  kind:
                    stat.kind === "dir"
                      ? ("dir" as const)
                      : stat.kind === "file"
                        ? ("file" as const)
                        : ("other" as const),
                  mode: await ops.mode(dataDir.path)
                };
          let config: ConfigObservation;
          try {
            await Effect.runPromise(readConfig(platform, dataDir.path));
            config = { ok: true };
          } catch (error) {
            config = { ok: false, message: errorMessage(error) };
          }
          const payload = doctorPayload([
            nodeVersionCheck(info.nodeVersion),
            dataDirCheck(observed),
            configCheck(config)
          ]);
          return {
            schemaVersion: 1,
            ok: true,
            healthy: payload.healthy,
            checks: payload.checks
          } satisfies DoctorPayload;
        })
      });
    })
  );
}
