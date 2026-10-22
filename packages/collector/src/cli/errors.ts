/**
 * The CLI's two failure classes (plan 3.2.1): a `UsageError` maps to exit 2 with the `invalid-arguments`
 * code, a `CliError` maps to exit 1 with its own code from the protocol's `FailureCode` set. Anything else
 * escapes as an `internal` failure.
 */

/** Invalid arguments: exit 2. */
export class UsageError extends Error {}

/** A command failed: exit 1, carrying one of the protocol's failure codes. */
export class CliError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
