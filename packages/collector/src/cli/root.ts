import { Command } from "effect/cli";
import { Effect } from "effect";

import { UsageError } from "../modules/errors/errors.ts";
import { JsonFlag } from "../commands/flags.ts";
import { doctorCommand } from "../commands/doctor/command.ts";
import { installCommand } from "../commands/install/command.ts";
import { pairCommand } from "../commands/pair/command.ts";
import { rebuildCommand } from "../commands/rebuild/command.ts";
import { refreshCommand } from "../commands/refresh/command.ts";
import { snapshotCommand } from "../commands/snapshot/command.ts";
import { statusCommand } from "../commands/status/command.ts";
import { uninstallCommand } from "../commands/uninstall/command.ts";
import { unpairCommand } from "../commands/unpair/command.ts";

/**
 * The root command (plan 3.13): the global `--json` flag is an effect/cli Setting, so it is accepted
 * both before and after the command name and its parsed value reaches the handler. The root's own handler only runs when no command was named and
 * fails as a usage error; every other parse failure (unknown command, unknown option, a missing or
 * malformed flag value) surfaces through `effect/cli` as a `ShowHelp` error, which `cli/run` maps to
 * exit 2 with the `invalid-arguments` code.
 */
export const rootCommand = Command.make("snorlax", {}, () =>
  Effect.fail(new UsageError({ message: "a command is required; run `snorlax --help` for the command list" }))
).pipe(
  Command.withGlobalFlags([JsonFlag]),
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
