import type { FailureCode } from "@rivus/snorlax-protocol";
import { Data } from "effect";

/**
 * The CLI's two failure classes (plan 3.2.1, 3.13): a `UsageError` maps to exit 2 with the
 * `invalid-arguments` code; a `CommandError` maps to exit 1 carrying its own code. Feature modules
 * fail with these tagged errors — nothing else; only `cli/` maps them to exit codes and the failure
 * shape, so a code typo is a type error here and not a wrong exit payload at runtime.
 */

/** Invalid arguments: exit 2. */
export class UsageError extends Data.TaggedError("UsageError")<{
  readonly message: string;
}> {}

/** A command failed: exit 1, carrying one of the protocol's failure codes. */
export class CommandError extends Data.TaggedError("CommandError")<{
  readonly code: FailureCode;
  readonly message: string;
}> {}
