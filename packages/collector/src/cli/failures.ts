import type { FailureCode } from "@rivus/snorlax-protocol";
import type { Command } from "effect/cli";

import type { rootCommand } from "./root.ts";

/**
 * Every error a command can fail with, read off the root command's error channel: the root handler's
 * usage error and the typed failures of every subcommand handler. effect/cli's own `CliError` is not in it.
 */
type CommandFailure = Command.Error<typeof rootCommand>;

export interface FailureExit {
  readonly code: FailureCode;
  readonly exit: 1 | 2;
  /**
   * The failure rejects the data directory itself, so the run writes nothing into it, not even the command log
   * line `cli/` otherwise appends to `<data>/logs/snorlax.log`.
   */
  readonly refusesDataDir?: true;
}

/**
 * The failure code and exit code each command failure reports (plan 3.2.1, 3.13 rule 7). The keys are
 * exactly the `_tag`s of `CommandFailure`, so a failure without an entry, or an entry for a failure that
 * no longer exists, does not compile.
 */
export const FAILURES = {
  UsageError: { code: "invalid-arguments", exit: 2 },
  RebuildDaysOutOfRange: { code: "invalid-arguments", exit: 2 },
  PairNotImplemented: { code: "internal", exit: 1 },
  UnpairNotImplemented: { code: "internal", exit: 1 },
  SnapshotMissing: { code: "data-dir", exit: 1 },
  SnapshotUnreadable: { code: "data-dir", exit: 1 },
  StatusReadFailed: { code: "data-dir", exit: 1 },
  ConfigInvalid: { code: "data-dir", exit: 1 },
  DataDirCreateFailed: { code: "data-dir", exit: 1 },
  SnapshotWriteFailed: { code: "data-dir", exit: 1 },
  LedgerLockHeld: { code: "locked", exit: 1 },
  LedgerUnreadable: { code: "data-dir", exit: 1 },
  LedgerSchemaTooNew: { code: "data-dir", exit: 1 },
  LedgerBackupFailed: { code: "data-dir", exit: 1 },
  LedgerPlatformUnsupported: { code: "internal", exit: 1 },
  SchedulerOsOverrideInvalid: { code: "internal", exit: 1 },
  // Plan 3.2.1 has no code for an unsupported platform; the message names the batch that adds one.
  SchedulerUnsupportedOs: { code: "internal", exit: 1 },
  DataDirNotAbsolute: { code: "data-dir", exit: 1, refusesDataDir: true },
  DataDirNotDeletable: { code: "data-dir", exit: 1, refusesDataDir: true },
  DataDirNotSnorlax: { code: "data-dir", exit: 1, refusesDataDir: true },
  DataDirDeleteFailed: { code: "data-dir", exit: 1 },
  CollectorPathUnresolved: { code: "internal", exit: 1 },
  UserIdUnavailable: { code: "internal", exit: 1 },
  LaunchctlFailed: { code: "internal", exit: 1 },
  ForeignServiceLoaded: { code: "internal", exit: 1 },
  PlistWriteFailed: { code: "internal", exit: 1 },
  PlistRemoveFailed: { code: "internal", exit: 1 }
} as const satisfies { readonly [Tag in CommandFailure["_tag"]]: FailureExit };

/** Defects and errors outside `FAILURES` (effect/cli's own besides `ShowHelp`). */
export const UNMAPPED: FailureExit = { code: "internal", exit: 1 };
