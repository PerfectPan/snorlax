import { join } from "node:path";

import type { Platform } from "@rivus/agent-kit/platform";
import { SnorlaxPlatform } from "../platform/platform.ts";
import { Context, Effect, Layer } from "effect";

import { CommandError } from "../errors/errors.ts";
import { errorMessage } from "../../core/error-message/error-message.ts";
import { NodeFiles, type NodeFileOps } from "./node-fs.ts";

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

/**
 * Creates the directory (and parents) and the `logs` subdirectory (plan 3.9), and keeps the data
 * directory at mode 0700; existing wider modes are tightened. Only commands that write call this —
 * `status`, `doctor` and `snapshot` run without it and create nothing (plan 3.13).
 */
export async function ensureDataDir(
  platform: Pick<Platform, "fs">,
  nodeFiles: NodeFileOps,
  path: string
): Promise<void> {
  try {
    await platform.fs.mkdir(path);
    await nodeFiles.chmod(path, DATA_DIR_MODE);
    await platform.fs.mkdir(join(path, "logs"));
  } catch (error) {
    throw new CommandError({
      code: "data-dir",
      message: `cannot create the data directory ${path}: ${errorMessage(error)}`
    });
  }
}

/**
 * The resolved data directory and the one operation that prepares it. Building the layer only
 * resolves the path — no file system access happens until a command calls `ensure`.
 */
export class DataDir extends Context.Service<
  DataDir,
  {
    readonly path: string;
    readonly ensure: Effect.Effect<void, CommandError>;
  }
>()("snorlax/data-dir/DataDir") {
  static readonly live: Layer.Layer<DataDir, never, SnorlaxPlatform | NodeFiles> = Layer.effect(
    DataDir,
    Effect.gen(function* () {
      const platform = yield* SnorlaxPlatform;
      const ops = yield* NodeFiles;
      const path = resolveDataDir(platform);
      return DataDir.of({
        path,
        ensure: Effect.tryPromise({
          try: () => ensureDataDir(platform, ops, path),
          catch: (error) =>
            error instanceof CommandError ? error : new CommandError({ code: "data-dir", message: errorMessage(error) })
        })
      });
    })
  );
}

// The file operations the kit platform does not model; the data directory and the log use them.
export { NodeFiles, nodeFileOps, type NodeFileOps } from "./node-fs.ts";
