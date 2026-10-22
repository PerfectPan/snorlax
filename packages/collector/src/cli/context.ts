import type { Platform } from "@rivus/agent-kit/platform";

import { ensureDataDir, resolveDataDir } from "../data-dir/data-dir.ts";
import type { NodeFileOps } from "../data-dir/node-fs.ts";
import { createLogger, type Logger } from "../log/logger.ts";

/** A byte sink; `process.stdout` and `process.stderr` satisfy it, tests capture it. */
export interface Sink {
  write(text: string): void;
}

/**
 * The platform surface the collector uses: everything except `process` is the full kit interface, and only
 * `run` is needed from `process`, so `createMemoryPlatform` from `@rivus/agent-kit/testing` satisfies this
 * type in tests. `sqlite` (the ledger) and the process identity members (the ledger lock) exist on the Node
 * platform; tests that never lock or open the ledger leave them out, as the memory platform does.
 */
export type CollectorPlatform = Pick<Platform, "env" | "home" | "os" | "fs" | "clock"> & {
  readonly sqlite?: Platform["sqlite"];
  readonly process: Pick<Platform["process"], "run"> &
    Partial<Pick<Platform["process"], "self" | "identify" | "spawn">>;
};

/** Everything a command runs against; assembled once per process from injected dependencies. */
export interface CliContext {
  readonly platform: CollectorPlatform;
  readonly nodeFiles: NodeFileOps;
  readonly version: string;
  /** The running Node's version string, e.g. `v24.11.0`; checked by `doctor`. */
  readonly nodeVersion: string;
  readonly stdout: Sink;
  readonly stderr: Sink;
  readonly dataDir: string;
  readonly log: Logger;
  /** The device's IANA time zone; the snapshot's day windows follow it (plan 3.2.2). */
  readonly timeZone: string;
}

export interface CliDeps {
  readonly platform: CollectorPlatform;
  readonly nodeFiles: NodeFileOps;
  readonly version: string;
  readonly nodeVersion: string;
  readonly stdout: Sink;
  readonly stderr: Sink;
  /** Test hook: shrink the log rotation threshold (plan 3.9). */
  readonly logMaxBytes?: number;
  /** The device's time zone; defaults to the runtime's, so tests can pin it. */
  readonly timeZone?: string;
}

/**
 * Resolves and prepares the data directory and the logger before any command runs, so every command sees the
 * same environment. Preparation failures surface as `data-dir` (exit 1).
 */
export async function createContext(deps: CliDeps): Promise<CliContext> {
  const dataDir = resolveDataDir(deps.platform);
  await ensureDataDir(deps.platform, deps.nodeFiles, dataDir);
  const log = await createLogger(deps.platform, deps.nodeFiles, dataDir, { maxBytes: deps.logMaxBytes });
  return {
    platform: deps.platform,
    nodeFiles: deps.nodeFiles,
    version: deps.version,
    nodeVersion: deps.nodeVersion,
    stdout: deps.stdout,
    stderr: deps.stderr,
    dataDir,
    log,
    timeZone: deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  };
}
