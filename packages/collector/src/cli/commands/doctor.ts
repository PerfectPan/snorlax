import { join } from "node:path";

import { redactText } from "@rivus/agent-kit/redact";
import { type Doctor, type DoctorCheck } from "@rivus/snorlax-protocol";

import { readConfig } from "../../config/config.ts";
import { DATA_DIR_MODE } from "../../data-dir/data-dir.ts";
import { errorMessage } from "../../util/error-message.ts";
import { parseCommandArgs } from "../args.ts";
import type { Command, CommandOutcome } from "../command.ts";
import type { CliContext } from "../context.ts";

/** The oldest Node the collector runs on (plan: "Compatibility And Constraints", Node 22.13). */
const REQUIRED_NODE = "22.13";

const parseNodeVersion = (version: string): [number, number, number] | null => {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
};

const satisfiesRequired = ([major, minor]: [number, number, number]): boolean =>
  major > 22 || (major === 22 && minor >= 13);

const nodeVersionCheck = (nodeVersion: string): DoctorCheck => {
  const parts = parseNodeVersion(nodeVersion);
  if (parts === null) {
    return { id: "node-version", status: "error", detail: `cannot read the Node version from "${nodeVersion}"` };
  }
  const detail = `Node ${nodeVersion} satisfies >= ${REQUIRED_NODE}`;
  return { id: "node-version", status: satisfiesRequired(parts) ? "ok" : "error", detail };
};

const dataDirCheck = async (ctx: CliContext): Promise<DoctorCheck> => {
  const stat = await ctx.platform.fs.stat(ctx.dataDir);
  if (stat === undefined) {
    return { id: "data-dir", status: "error", detail: `${ctx.dataDir} does not exist` };
  }
  if (stat.kind !== "dir") {
    return { id: "data-dir", status: "error", detail: `${ctx.dataDir} is not a directory` };
  }
  const mode = await ctx.nodeFiles.mode(ctx.dataDir);
  if (mode !== undefined && mode !== DATA_DIR_MODE) {
    return {
      id: "data-dir",
      status: "error",
      detail: `${ctx.dataDir} has mode ${mode.toString(8)}; expected ${DATA_DIR_MODE.toString(8)}`
    };
  }
  const probe = join(ctx.dataDir, ".doctor-write-probe");
  try {
    // Clear any leftover probe first, so the exclusive create is the real writability test.
    await ctx.platform.fs.remove(probe);
    await ctx.platform.fs.createExclusive(probe);
    await ctx.platform.fs.remove(probe);
  } catch (error) {
    return {
      id: "data-dir",
      status: "error",
      detail: `${ctx.dataDir} is not writable: ${errorMessage(error)}`
    };
  }
  return { id: "data-dir", status: "ok", detail: `${ctx.dataDir} is a writable directory with mode 0700` };
};

const configCheck = async (ctx: CliContext): Promise<DoctorCheck> => {
  try {
    await readConfig(ctx.platform, ctx.dataDir);
    return { id: "config", status: "ok", detail: "config.json parses; missing sections default" };
  } catch (error) {
    return { id: "config", status: "error", detail: errorMessage(error) };
  }
};

/**
 * Local diagnostics only in this milestone (plan 3.1): Node version, data directory and config. Keychain,
 * backend and scheduling checks arrive with the batches that own them. The command exits 0 whenever it
 * completes; `healthy` reports whether any check failed.
 */
export const doctorCommand: Command = {
  id: "doctor",
  summary: "local checks: node version, data directory, config",
  async run(args, ctx: CliContext): Promise<CommandOutcome> {
    const { values } = parseCommandArgs(args, { json: { type: "boolean" } });

    const checks = [nodeVersionCheck(ctx.nodeVersion), await dataDirCheck(ctx), await configCheck(ctx)];
    const payload: Doctor = {
      schemaVersion: 1,
      ok: true,
      healthy: checks.every((check) => check.status !== "error"),
      checks: checks.map((check) => ({ ...check, detail: redactText(check.detail, { home: ctx.platform.home }) }))
    };

    const human = checks.map((check) => `${check.id}: ${check.status} — ${check.detail}`).join("\n");
    return { json: values.json === true, payload, human: `${human}\n` };
  }
};
