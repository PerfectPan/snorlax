import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

import { errorMessage } from "../util/error-message.ts";
import { UsageError } from "./errors.ts";

/**
 * `parseArgs` with the collector's conventions: strict options, no positionals, and parse failures raised as
 * `UsageError` so `main` maps them to exit 2. Every command accepts `--json`.
 */
export function parseCommandArgs<T extends ParseArgsOptionsConfig>(args: readonly string[], options: T) {
  try {
    return parseArgs({ args: [...args], options, strict: true, allowPositionals: false });
  } catch (error) {
    throw new UsageError(errorMessage(error));
  }
}
