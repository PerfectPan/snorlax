import type { Snapshot } from "@rivus/snorlax-protocol";
import { SnorlaxPlatform } from "../../modules/platform/platform.ts";
import { Context, Data, Effect, Layer } from "effect";

import { DataDir } from "../../modules/data-dir/data-dir.ts";
import { errorMessage } from "../../core/error-message/error-message.ts";
import { readSnapshotFile } from "../../modules/snapshot-file/snapshot-file.ts";

/** No `snapshot.json` exists yet: `refresh` has not run in this data directory. */
class SnapshotMissing extends Data.TaggedError("SnapshotMissing")<{ readonly message: string }> {}

/** `snapshot.json` could not be read, or does not parse as a snapshot. */
class SnapshotUnreadable extends Data.TaggedError("SnapshotUnreadable")<{ readonly message: string }> {}

/**
 * The current snapshot, read on every call and never written here — the snapshot file is written by
 * `refresh`. A missing or unreadable snapshot fails the command; reading creates nothing (plan 3.13), so
 * a fresh machine can answer `snapshot` without gaining a data directory.
 */
export class SnapshotStore extends Context.Service<
  SnapshotStore,
  {
    readonly current: Effect.Effect<Snapshot, SnapshotMissing | SnapshotUnreadable>;
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
              throw new SnapshotMissing({
                message: `no snapshot exists yet in ${dataDir.path}; snorlax refresh writes it`
              });
            }
            if (read.kind === "invalid") {
              throw new SnapshotUnreadable({
                message: `snapshot.json in ${dataDir.path} is not a valid snapshot: ${read.reason}`
              });
            }
            return read.snapshot;
          },
          catch: (error) =>
            error instanceof SnapshotMissing || error instanceof SnapshotUnreadable
              ? error
              : new SnapshotUnreadable({ message: errorMessage(error) })
        })
      });
    })
  );
}
