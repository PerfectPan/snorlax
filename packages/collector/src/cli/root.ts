import { Command, Flag } from "effect/cli";
import { Effect } from "effect";

import { UsageError } from "../errors.ts";
import { doctorCommand } from "../commands/doctor.ts";
import { installCommand } from "../commands/install.ts";
import { pairCommand } from "../commands/pair.ts";
import { rebuildCommand } from "../commands/rebuild.ts";
import { refreshCommand } from "../commands/refresh.ts";
import { snapshotCommand } from "../commands/snapshot.ts";
import { statusCommand } from "../commands/status.ts";
import { uninstallCommand } from "../commands/uninstall.ts";
import { unpairCommand } from "../commands/unpair.ts";

/**
 * The root command (plan 3.13): the global `--json` flag is a shared flag, so it is accepted both
 * before and after the command name. The root's own handler only runs when no command was named and
 * fails as a usage error; every other parse failure (unknown command, unknown option, a missing or
 * malformed flag value) surfaces through `effect/cli` as a `ShowHelp` error, which `cli/run` maps to
 * exit 2 with the `invalid-arguments` code.
 */
export const rootCommand = Command.make("snorlax", {}, () =>
  Effect.fail(new UsageError({ message: "a command is required; run `snorlax --help` for the command list" }))
).pipe(
  Command.withSharedFlags({
    json: Flag.Boolean("json").pipe(
      Flag.withDefault(false),
      Flag.withDescription("print one JSON object on stdout instead of human-readable text")
    )
  }),
  Command.withDescription("read coding-agent usage logs and report tokens, requests, sessions and cost"),
  Command.withSubcommands([
    statusCommand,
    doctorCommand,
    snapshotCommand,
    refreshCommand,
    rebuildCommand,
    pairCommand,
    unpairCommand,
    installCommand,
    uninstallCommand
  ])
);
