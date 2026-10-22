import type { Ok } from "@rivus/snorlax-protocol";

import { uninstallLaunchAgent } from "../../schedule/launchd.ts";
import { parseCommandArgs } from "../args.ts";
import type { Command, CommandOutcome } from "../command.ts";
import type { CliContext } from "../context.ts";

const ok = (): Ok => ({ schemaVersion: 1, ok: true });

/**
 * Removes the LaunchAgent. `--data` also deletes the data directory. The keychain item is removed
 * from the same path once Batch 7 fills in `removeKeychainItem`.
 */
export const uninstallCommand: Command = {
  id: "uninstall",
  summary: "remove the LaunchAgent; --data deletes the data directory",
  async run(args, ctx: CliContext): Promise<CommandOutcome> {
    const { values } = parseCommandArgs(args, {
      json: { type: "boolean" },
      data: { type: "boolean" }
    });
    const deleteData = values.data === true;
    await uninstallLaunchAgent(ctx.platform, ctx.dataDir, { deleteData });
    const human = deleteData ? "LaunchAgent removed and data directory deleted\n" : "LaunchAgent removed\n";
    return { json: values.json === true, payload: ok(), human };
  }
};
