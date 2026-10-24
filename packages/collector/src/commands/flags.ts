import { Flag, GlobalFlag } from "effect/cli";

/**
 * The global `--json` flag as an effect/cli Setting: effect/cli parses it once per invocation and
 * provides the parsed value to the command handler as this service, so the output mode follows what
 * was actually parsed — `--json=false`, `--json no`, `--json --no-json` and `--no-json --json` all
 * mean human output — not what an argv scan guesses. Commands hand the value to their render;
 * `cli/` falls back to scanning the tokens before `--` only where no handler ran.
 */
export const JsonFlag = GlobalFlag.Setting("json")({
  flag: Flag.Boolean("json").pipe(
    Flag.withDefault(false),
    Flag.withDescription("print one JSON object on stdout instead of human-readable text")
  )
});
