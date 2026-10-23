import { join } from "node:path";

import type { Platform } from "@rivus/agent-kit/platform";

import { CliError } from "../cli/errors.ts";
import { errorMessage } from "../util/error-message.ts";
import type { NodeFileOps } from "./node-fs.ts";

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

/** Creates the directory (and parents) and keeps it at mode 0700; existing wider modes are tightened. */
export async function ensureDataDir(
  platform: Pick<Platform, "fs">,
  nodeFiles: NodeFileOps,
  path: string
): Promise<void> {
  try {
    await platform.fs.mkdir(path);
    await nodeFiles.chmod(path, DATA_DIR_MODE);
  } catch (error) {
    throw new CliError("data-dir", `cannot create the data directory ${path}: ${errorMessage(error)}`);
  }
}
