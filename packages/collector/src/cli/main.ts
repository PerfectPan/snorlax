import { redactText } from "@rivus/agent-kit/redact";
import { type Failure } from "@rivus/snorlax-protocol";

import { errorMessage } from "../util/error-message.ts";
import type { Command } from "./command.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { installCommand, pairCommand, uninstallCommand, unpairCommand } from "./commands/pending.ts";
import { rebuildCommand } from "./commands/rebuild.ts";
import { refreshCommand } from "./commands/refresh.ts";
import { snapshotCommand } from "./commands/snapshot.ts";
import { statusCommand } from "./commands/status.ts";
import { createContext, type CliDeps } from "./context.ts";
import { CliError, UsageError } from "./errors.ts";

const commands: readonly Command[] = [
  statusCommand,
  doctorCommand,
  snapshotCommand,
  refreshCommand,
  rebuildCommand,
  pairCommand,
  unpairCommand,
  installCommand,
  uninstallCommand
];

const usage = (): string =>
  [
    "usage: snorlax <command> [--json]",
    "",
    "commands:",
    ...commands.map((command) => `  ${command.id.padEnd(10)} ${command.summary}`)
  ].join("\n");

/**
 * Runs one CLI invocation and returns its exit code (plan 3.2.1): 0 on success, 1 on failure with the
 * failure shape on stdout, 2 on invalid arguments. With `--json`, stdout carries exactly one JSON object in
 * every case; human-readable output and diagnostics go to stderr and the log file, redacted.
 */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const startedAt = deps.platform.clock.monotonic();
  const [commandId, ...rest] = argv;
  // Checked on the whole argv: an argument error can then still report the failure shape as JSON.
  const json = argv.includes("--json");

  const failure = (code: string, message: string): Failure => ({
    schemaVersion: 1,
    ok: false,
    error: { code, message }
  });
  const emitFailure = (code: string, message: string, options?: { readonly withUsage?: boolean }): void => {
    const redacted = redactText(message, { home: deps.platform.home });
    if (json) {
      deps.stdout.write(`${JSON.stringify(failure(code, redacted))}\n`);
    } else {
      deps.stderr.write(options?.withUsage === true ? `${redacted}\n\n${usage()}\n` : `${redacted}\n`);
    }
  };
  const emitUsage = (message: string): number => {
    if (json) {
      deps.stdout.write(`${JSON.stringify(failure("invalid-arguments", message))}\n`);
    } else {
      deps.stderr.write(`${message}\n\n${usage()}\n`);
    }
    return 2;
  };

  if (commandId === undefined) {
    return emitUsage("a command is required");
  }
  if (commandId.startsWith("-")) {
    return emitUsage(`expected a command before "${commandId}"`);
  }
  const command = commands.find((candidate) => candidate.id === commandId);
  if (command === undefined) {
    return emitUsage(`unknown command "${commandId}"`);
  }

  let context;
  try {
    context = await createContext(deps);
  } catch (error) {
    const code = error instanceof CliError ? error.code : "data-dir";
    emitFailure(code, errorMessage(error));
    deps.stderr.write(`${usage()}\n`);
    return 1;
  }

  try {
    const outcome = await command.run(rest, context);
    if (outcome.json) {
      deps.stdout.write(`${JSON.stringify(outcome.payload)}\n`);
    } else {
      deps.stdout.write(outcome.human);
    }
    await context.log.event("command", {
      name: commandId,
      exitCode: 0,
      durationMs: Math.round(deps.platform.clock.monotonic() - startedAt)
    });
    return 0;
  } catch (error) {
    const exitCode = error instanceof UsageError ? 2 : 1;
    const code =
      error instanceof UsageError ? "invalid-arguments" : error instanceof CliError ? error.code : "internal";
    emitFailure(code, errorMessage(error), { withUsage: error instanceof UsageError });
    await context.log.event("command", {
      name: commandId,
      exitCode,
      error: code,
      durationMs: Math.round(deps.platform.clock.monotonic() - startedAt)
    });
    return exitCode;
  }
}
