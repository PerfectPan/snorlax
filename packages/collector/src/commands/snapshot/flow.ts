import { Data, Effect } from "effect";

import { errorMessage } from "../../core/error-message/error-message.ts";
import { resolveDataDir } from "../../modules/data-dir/data-dir.ts";
import { SnorlaxPlatform } from "../../modules/platform/platform.ts";
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
export const snapshotFlow = Effect.gen(function* () {
  const platform = yield* SnorlaxPlatform;
  const dataDir = resolveDataDir(platform);
  const read = yield* Effect.tryPromise({
    try: () => readSnapshotFile(platform, dataDir),
    catch: (error) => new SnapshotUnreadable({ message: errorMessage(error) })
  });
  if (read.kind === "missing") {
    return yield* new SnapshotMissing({ message: `no snapshot exists yet in ${dataDir}; snorlax refresh writes it` });
  }
  if (read.kind === "invalid") {
    return yield* new SnapshotUnreadable({
      message: `snapshot.json in ${dataDir} is not a valid snapshot: ${read.reason}`
    });
  }
  return read.snapshot;
});
