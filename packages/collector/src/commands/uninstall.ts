import { Command, Flag } from "effect/cli";
import { Effect } from "effect";

import { DataDir } from "../data-dir/data-dir.ts";
import { Schedule } from "../schedule/service.ts";
import { JsonFlag } from "./flags.ts";
import { CommandOutput } from "./output.ts";

/**
 * Removes the LaunchAgent. `--data` also deletes the data directory. The keychain item is removed
 * from the same path once Batch 7 fills in `removeKeychainItem`.
 */
export const uninstallCommand = Command.make(
  "uninstall",
  {
    data: Flag.Boolean("data").pipe(Flag.withDefault(false), Flag.withDescription("also delete the data directory"))
  },
  ({ data }) =>
    Effect.gen(function* () {
      const json = yield* JsonFlag;
      const dataDir = yield* DataDir;
      const { dataLeftovers } = yield* (yield* Schedule).uninstall({ deleteData: data });
      let human = data ? "LaunchAgent removed and data directory deleted\n" : "LaunchAgent removed\n";
      if (dataLeftovers.length > 0) {
        human =
          `LaunchAgent removed\n` +
          `the data directory ${dataDir.path} is kept; entries snorlax did not write remain: ` +
          `${dataLeftovers.join(", ")}\n`;
      }
      yield* (yield* CommandOutput).render({ payload: { schemaVersion: 1, ok: true }, human, json });
    })
).pipe(Command.withDescription("remove the LaunchAgent; --data deletes the data directory"));
