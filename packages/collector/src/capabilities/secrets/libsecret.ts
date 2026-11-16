import type { Platform } from "@rivus/agent-kit/platform";
import type { Context } from "effect";
import { Effect } from "effect";

import {
  commandFailureFor,
  commandPath,
  readThroughCommand,
  runStdinCommand,
  storeThroughCommand,
  type CommandResult
} from "./command.ts";
import type { Secrets } from "./secrets.ts";

/**
 * Linux secret service through `secret-tool`. `store` reads stdin through EOF and keeps a
 * trailing newline as part of the password, so the token is written with no newline. `lookup` prints the
 * token. Exit 1 with an empty stderr means the item is absent; exit 1 with stderr (the service or D-Bus
 * could not be reached) is `KeychainUnavailable`, and `clear` uses the same split. The token is never a
 * process argument. A missing `secret-tool` program (`ENOENT`) is `StoreBinaryMissing` for `read` and
 * `delete`: an item stored earlier may still be in the secret service. `store` still fails.
 * `SNORLAX_SECRET_TOOL` replaces `secret-tool`; tests point it at a stub and never start the real binary.
 */

const LABEL = "--label=snorlax";
const NOT_FOUND = 1;

const attributes = (deviceId: string): readonly string[] => ["service", "snorlax", "account", deviceId];

/** Exit 1 with empty stderr is "no such item". A connection failure also exits 1, and its stderr is not empty. */
const absent = (result: CommandResult): boolean => result.code === NOT_FOUND && result.stderr === "";

const failed = commandFailureFor("secret-tool");

/** The Linux implementation over `platform`. The env override of `read` is applied by `Secrets`. */
export const libsecretSecrets = (
  platform: Pick<Platform, "env" | "home" | "process">
): Context.Service.Shape<typeof Secrets> => {
  const binary = commandPath(platform.env, "SNORLAX_SECRET_TOOL", "secret-tool");
  const run = (args: readonly string[], stdin: string) => runStdinCommand(platform, binary, args, stdin);
  return {
    read: readThroughCommand({
      binary: "secret-tool",
      absent,
      failed,
      run: (deviceId) => run(["lookup", ...attributes(deviceId)], "")
    }),
    store: storeThroughCommand({
      failed,
      run: (deviceId, token) => run(["store", LABEL, ...attributes(deviceId)], token)
    }),
    delete: (deviceId) =>
      Effect.gen(function* () {
        const result = yield* run(["clear", ...attributes(deviceId)], "");
        // Clearing an item that is already gone is the state `delete` promises. A non-empty stderr is not that.
        if (!absent(result) && result.code !== 0) {
          return yield* failed(result.stderr, result.stdout, result.code);
        }
      })
  };
};
