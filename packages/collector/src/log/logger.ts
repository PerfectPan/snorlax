import { join } from "node:path";

import type { Platform } from "@rivus/agent-kit/platform";
import { redactText } from "@rivus/agent-kit/redact";

import type { NodeFileOps } from "../data-dir/node-fs.ts";

/** Rotate at 5 MB, keep three files: `snorlax.log`, `snorlax.log.1`, `snorlax.log.2` (plan 3.9). */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_FILES_KEPT = 3;

export type LogFieldValue = string | number | boolean | null;

export interface Logger {
  /**
   * Appends one line: `<utc timestamp> <event>[ <json fields>]`, rotated as needed. The line passes through
   * `redactText` before it is written (plan 3.8). Logging never fails the command: a broken log file is
   * reported by `doctor`, not by throwing here.
   */
  event(name: string, fields?: Record<string, LogFieldValue>): Promise<void>;
}

export interface LogOptions {
  /** Test hook: shrink the rotation threshold without writing megabytes. */
  readonly maxBytes?: number;
}

export async function createLogger(
  platform: Pick<Platform, "fs" | "clock" | "home">,
  nodeFiles: NodeFileOps,
  dataDir: string,
  options?: LogOptions
): Promise<Logger> {
  const dir = join(dataDir, "logs");
  await platform.fs.mkdir(dir);
  const logPath = join(dir, "snorlax.log");
  const maxBytes = options?.maxBytes ?? LOG_MAX_BYTES;

  const rotate = async (): Promise<void> => {
    for (let index = LOG_FILES_KEPT - 1; index >= 1; index -= 1) {
      const from = index === 1 ? logPath : join(dir, `snorlax.log.${index - 1}`);
      // Older generations need not exist yet; a missing file ends that branch of the chain.
      if ((await platform.fs.stat(from)) !== undefined) {
        await platform.fs.rename(from, join(dir, `snorlax.log.${index}`));
      }
    }
  };

  const append = async (line: string): Promise<void> => {
    const size = await platform.fs.stat(logPath);
    if ((size?.size ?? 0) + line.length > maxBytes) {
      await rotate();
    }
    await nodeFiles.append(logPath, line);
  };

  return {
    async event(name, fields) {
      const timestamp = new Date(platform.clock.now()).toISOString();
      const suffix = fields === undefined ? "" : ` ${JSON.stringify(fields)}`;
      const line = redactText(`${timestamp} ${name}${suffix}\n`, { home: platform.home });
      try {
        await append(line);
      } catch {
        // A log write must never fail the command; doctor surfaces log problems.
      }
    }
  };
}
