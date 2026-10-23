import type { Ok } from "@rivus/snorlax-protocol";

import { installLaunchAgent } from "../../schedule/launchd.ts";
import { parseCommandArgs } from "../args.ts";
import type { Command, CommandOutcome } from "../command.ts";
import type { CliContext } from "../context.ts";

const ok = (): Ok => ({ schemaVersion: 1, ok: true });

/** Registers `~/Library/LaunchAgents/io.github.perfectpan.snorlax.refresh.plist` and loads it. */
export const installCommand: Command = {
  id: "install",
  summary: "register the macOS LaunchAgent for refresh",
  async run(args, ctx: CliContext): Promise<CommandOutcome> {
    const { values } = parseCommandArgs(args, { json: { type: "boolean" } });
    const plistPath = await installLaunchAgent(ctx.platform, ctx.dataDir);
    return {
      json: values.json === true,
      payload: ok(),
      human: `LaunchAgent installed at ${plistPath}\n`
    };
  }
};
