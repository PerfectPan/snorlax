import { join } from "node:path";

import type { Platform } from "@rivus/agent-kit/platform";
import { Data, Effect } from "effect";

import { errorMessage } from "../../core/error-message/error-message.ts";
import type { NodeFileOps } from "../platform/platform.ts";

/** The data directory is private to the user (plan 3.4.1, Spec 3.8). */
export const DATA_DIR_MODE = 0o700;

/**
 * Where the collector keeps everything it writes: `SNORLAX_HOME` when set, else the platform default —
 * `~/Library/Application Support/snorlax` on macOS, `${XDG_DATA_HOME:-~/.local/share}/snorlax` elsewhere
 * (plan 3.4.1 step 1). `SNORLAX_HOME` is used as given; an absolute path is expected.
 */
export function resolveDataDir(platform: Pick<Platform, "env" | "home" | "os">): string {
  const override = platform.env.SNORLAX_HOME;
  if (override !== undefined && override !== "") {
    return override;
  }
  if (platform.os === "darwin") {
    return join(platform.home, "Library", "Application Support", "snorlax");
  }
  const xdg = platform.env.XDG_DATA_HOME;
  const dataHome = xdg !== undefined && xdg !== "" ? xdg : join(platform.home, ".local", "share");
  return join(dataHome, "snorlax");
}

/** The data directory or its `logs` subdirectory could not be created or given mode 0700. */
export class DataDirCreateFailed extends Data.TaggedError("DataDirCreateFailed")<{ readonly message: string }> {}

/**
 * Creates the directory (and parents) and the `logs` subdirectory (plan 3.9), and keeps the data
 * directory at mode 0700; existing wider modes are tightened. Only commands that write call this —
 * `status`, `doctor` and `snapshot` run without it and create nothing (plan 3.13).
 */
export const ensureDataDir = (
  platform: Pick<Platform, "fs">,
  nodeFiles: NodeFileOps,
  path: string
): Effect.Effect<void, DataDirCreateFailed> =>
  Effect.tryPromise({
    try: async () => {
      await platform.fs.mkdir(path);
      await nodeFiles.chmod(path, DATA_DIR_MODE);
      await platform.fs.mkdir(join(path, "logs"));
    },
    catch: (error) =>
      new DataDirCreateFailed({ message: `cannot create the data directory ${path}: ${errorMessage(error)}` })
  });
