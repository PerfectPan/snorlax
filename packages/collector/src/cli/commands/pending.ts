import { CliError } from "../errors.ts";
import type { Command } from "../command.ts";

/**
 * The commands later milestones own are registered so that calling one returns the standard failure shape
 * instead of "unknown command"; each is replaced by its real implementation in the batch named in its
 * message. Arguments are not validated while a command is a stub.
 */
const pending = (id: string, owner: string): Command => ({
  id,
  summary: `not implemented yet; arrives with ${owner}`,
  run() {
    throw new CliError("internal", `snorlax ${id} is not implemented in this build; it arrives with ${owner}`);
  }
});

export const pairCommand: Command = pending("pair", "Batch 7");
export const unpairCommand: Command = pending("unpair", "Batch 7");
