import { join } from "node:path";

import type { Platform } from "@rivus/agent-kit/platform";
import { SnorlaxPlatform } from "../platform.ts";
import { redactText } from "@rivus/agent-kit/redact";
import { Context, Effect, Layer } from "effect";

import { DataDir } from "../data-dir/data-dir.ts";
import { NodeFiles, type NodeFileOps } from "../data-dir/node-fs.ts";

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

/**
 * The rotating append core the eager logger and the `Log` service share: size check, rotation, append.
 * The append never throws — a missing directory or a broken file drops the line, because a log write
 * must never fail a command.
 */
const rotatingAppender = (
  platform: Pick<Platform, "fs" | "clock" | "home">,
  nodeFiles: NodeFileOps,
  logsDir: string,
  maxBytes: number
): ((line: string) => Promise<void>) => {
  const logPath = join(logsDir, "snorlax.log");
  const rotate = async (): Promise<void> => {
    for (let index = LOG_FILES_KEPT - 1; index >= 1; index -= 1) {
      const from = index === 1 ? logPath : join(logsDir, `snorlax.log.${index - 1}`);
      // Older generations need not exist yet; a missing file ends that branch of the chain.
      if ((await platform.fs.stat(from)) !== undefined) {
        await platform.fs.rename(from, join(logsDir, `snorlax.log.${index}`));
      }
    }
  };
  return async (line: string): Promise<void> => {
    try {
      const size = await platform.fs.stat(logPath);
      if ((size?.size ?? 0) + line.length > maxBytes) {
        await rotate();
      }
      await nodeFiles.append(logPath, line);
    } catch {
      // A log write must never fail the command; doctor surfaces log problems.
    }
  };
};

const lineOf = (
  platform: Pick<Platform, "clock" | "home">,
  name: string,
  fields?: Record<string, LogFieldValue>
): string => {
  const timestamp = new Date(platform.clock.now()).toISOString();
  const suffix = fields === undefined ? "" : ` ${JSON.stringify(fields)}`;
  // Every line passes through redactText before it is written (plan 3.8).
  return redactText(`${timestamp} ${name}${suffix}\n`, { home: platform.home });
};

/** Creates a logger that makes sure the `logs` directory exists before appending (the eager form). */
export async function createLogger(
  platform: Pick<Platform, "fs" | "clock" | "home">,
  nodeFiles: NodeFileOps,
  dataDir: string,
  options?: LogOptions
): Promise<Logger> {
  const logsDir = join(dataDir, "logs");
  await platform.fs.mkdir(logsDir);
  const append = rotatingAppender(platform, nodeFiles, logsDir, options?.maxBytes ?? LOG_MAX_BYTES);
  return {
    async event(name, fields) {
      await append(lineOf(platform, name, fields));
    }
  };
}

/**
 * The command log as a service. Building the layer opens nothing; `event` appends only — when the
 * data directory or its `logs` directory does not exist yet, the line is dropped. Commands that write
 * (`refresh`, `rebuild`, `install`, `uninstall`) create the directory through `DataDir.ensure`; the
 * read-only commands log nothing on a fresh machine instead of creating files (plan 3.13).
 */
export class Log extends Context.Service<Log, Logger>()("snorlax/log/Log") {
  static readonly live: Layer.Layer<Log, never, SnorlaxPlatform | NodeFiles | DataDir> = Layer.effect(
    Log,
    Effect.gen(function* () {
      const platform = yield* SnorlaxPlatform;
      const ops = yield* NodeFiles;
      const dataDir = yield* DataDir;
      const append = rotatingAppender(platform, ops, join(dataDir.path, "logs"), LOG_MAX_BYTES);
      return Log.of({
        // The appender above never rejects, so the event stays on the caller's success channel.
        event: (name, fields) => append(lineOf(platform, name, fields))
      });
    })
  );
}
