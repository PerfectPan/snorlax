import type { Snapshot } from "@rivus/snorlax-protocol";
import { SnorlaxPlatform } from "../../modules/platform/platform.ts";
import { Context, Effect, Layer } from "effect";

import { DataDir } from "../../modules/data-dir/data-dir.ts";
import { CommandError } from "../../modules/errors/errors.ts";
import { errorMessage } from "../../core/error-message/error-message.ts";
import { readSnapshotFile } from "../../modules/snapshot-file/snapshot-file.ts";

/**
 * The current snapshot, read on every call and never written here — the snapshot file is written by
 * `refresh`. A missing or unreadable snapshot is a `data-dir` failure; reading creates nothing
 * (plan 3.13), so a fresh machine can answer `snapshot` without gaining a data directory.
 */
export class SnapshotStore extends Context.Service<
  SnapshotStore,
  {
    readonly current: Effect.Effect<Snapshot, CommandError>;
  }
>()("snorlax/snapshot/SnapshotStore") {
  static readonly live = Layer.effect(
    SnapshotStore,
    Effect.gen(function* () {
      const platform = yield* SnorlaxPlatform;
      const dataDir = yield* DataDir;
      return SnapshotStore.of({
        current: Effect.tryPromise({
          try: async () => {
            const read = await readSnapshotFile(platform, dataDir.path);
            if (read.kind === "missing") {
              throw new CommandError({
                code: "data-dir",
                message: `no snapshot exists yet in ${dataDir.path}; snorlax refresh writes it`
              });
            }
            if (read.kind === "invalid") {
              throw new CommandError({
                code: "data-dir",
                message: `snapshot.json in ${dataDir.path} is not a valid snapshot: ${read.reason}`
              });
            }
            return read.snapshot;
          },
          catch: (error) =>
            error instanceof CommandError ? error : new CommandError({ code: "data-dir", message: errorMessage(error) })
        })
      });
    })
  );
}
