import type { DoctorCheck } from "@rivus/snorlax-protocol";

import type { JobInspection } from "../../capabilities/scheduler/scheduler.ts";
import { DATA_DIR_MODE } from "../../modules/data-dir/data-dir.ts";

/**
 * Pure verdicts for the `doctor` checks (plan 3.1, 3.13): each takes what the flow observed and
 * decides status and detail. No Effect types and no I/O here, so the verdicts are testable on their
 * own and the flow only gathers the inputs.
 */

/** The oldest Node the collector runs on (plan: "Compatibility And Constraints", Node 22.13). */
export const REQUIRED_NODE = "22.13";

const parseNodeVersion = (version: string): [number, number, number] | null => {
  const match = /^v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(version);
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
};

const satisfiesRequired = ([major, minor]: [number, number, number]): boolean =>
  major > 22 || (major === 22 && minor >= 13);

export const nodeVersionCheck = (nodeVersion: string): DoctorCheck => {
  const parts = parseNodeVersion(nodeVersion);
  if (parts === null) {
    return { id: "node-version", status: "error", detail: `cannot read the Node version from "${nodeVersion}"` };
  }
  const detail = `Node ${nodeVersion} satisfies >= ${REQUIRED_NODE}`;
  return { id: "node-version", status: satisfiesRequired(parts) ? "ok" : "error", detail };
};

/** What the flow observed about the data directory, before any verdict. */
export interface DataDirObservation {
  readonly path: string;
  readonly kind: "dir" | "file" | "other" | "missing";
  /** The permission bits, when the path exists. */
  readonly mode: number | undefined;
}

/**
 * The data directory must exist as a directory at mode 0700. A missing directory, a regular file in
 * its place or a wider mode are failed checks — `doctor` reports them and repairs nothing (plan 3.13:
 * the command must not create or change any file).
 */
export const dataDirCheck = (observed: DataDirObservation): DoctorCheck => {
  const { path } = observed;
  if (observed.kind === "missing") {
    return { id: "data-dir", status: "error", detail: `${path} does not exist` };
  }
  if (observed.kind !== "dir") {
    return { id: "data-dir", status: "error", detail: `${path} is not a directory` };
  }
  if (observed.mode !== undefined && observed.mode !== DATA_DIR_MODE) {
    return {
      id: "data-dir",
      status: "error",
      detail: `${path} has mode ${observed.mode.toString(8)}; expected ${DATA_DIR_MODE.toString(8)}`
    };
  }
  return { id: "data-dir", status: "ok", detail: `${path} is a directory with mode 0700` };
};

/** The outcome of reading `config.json`, as the flow observed it. */
export type ConfigObservation = { readonly ok: true } | { readonly ok: false; readonly message: string };

export const configCheck = (observed: ConfigObservation): DoctorCheck =>
  observed.ok
    ? { id: "config", status: "ok", detail: "config.json parses; missing sections default" }
    : { id: "config", status: "error", detail: observed.message };

/** The Node binary the CLI's job file names, as the flow found it on disk. */
export type NodeBinary = "runnable" | "missing" | "not-executable";

/** What the flow observed about the scheduled refresh; `node` is undefined when no job file names a Node binary. */
export interface ScheduleObservation {
  readonly job: JobInspection;
  readonly node: NodeBinary | undefined;
}

const REINSTALL =
  "run `snorlax install` again with the Node you want it to use, or turn on Launch at login in Snorlax's Settings";

/**
 * Whether refresh runs on its own. The CLI's LaunchAgent runs the Node binary `snorlax install` ran on — often a
 * versioned path (nvm, Homebrew Cellar) that an upgrade removes, which silently stops the job — so a missing or
 * non-executable Node is an error. Not scheduling at all is a normal way to use the app (it refreshes when
 * asked), so every state that is not broken outright is a warning, never an error that would turn `healthy` false.
 */
export const scheduleCheck = ({ job, node }: ScheduleObservation): DoctorCheck => {
  const check = (status: DoctorCheck["status"], detail: string): DoctorCheck => ({ id: "schedule", status, detail });
  if (job.kind === "unsupported") {
    return check("warn", `${job.reason}; refresh runs only when something calls it`);
  }
  const { cliJob, loaded } = job;
  if (loaded.from === "app") {
    return cliJob === undefined
      ? check("ok", `Snorlax.app's Launch at login schedules refresh (${loaded.file})`)
      : check(
          "warn",
          `Snorlax.app's Launch at login schedules refresh, and ${cliJob.file} registers the same job; turn ` +
            "Launch at login off, run `snorlax uninstall`, then turn Launch at login on again"
        );
  }
  if (cliJob === undefined) {
    if (loaded.from === "cli") {
      return check(
        "warn",
        `launchd runs the LaunchAgent, but ${loaded.file} is gone; run \`snorlax install\` to restore it or ` +
          "`snorlax uninstall` to stop it"
      );
    }
    if (loaded.from === "unknown") {
      return check("warn", `a refresh job is loaded, but its owner cannot be confirmed: ${loaded.reason}`);
    }
    return check(
      "warn",
      "refresh is not scheduled: turn on Launch at login in Snorlax's Settings, or run `snorlax install`; until " +
        "then the snapshot changes only when refresh runs"
    );
  }
  if (cliJob.nodePath === undefined || node === undefined) {
    return check("warn", `cannot read the Node path from ${cliJob.file}; run \`snorlax install\` to rewrite it`);
  }
  if (node !== "runnable") {
    const problem = node === "missing" ? "does not exist" : "is not executable";
    return check(
      "error",
      `${cliJob.file} runs Node at ${cliJob.nodePath}, which ${problem}, so scheduled refresh stops; ${REINSTALL}`
    );
  }
  if (loaded.from === "cli") {
    return check("ok", `the LaunchAgent ${cliJob.file} is loaded and runs Node at ${cliJob.nodePath}`);
  }
  if (loaded.from === "unknown") {
    return check("warn", `cannot tell whether launchd runs ${cliJob.file}: ${loaded.reason}`);
  }
  return check("warn", `${cliJob.file} exists, but launchd has not loaded it; run \`snorlax install\` to load it`);
};

/** The whole `doctor` verdict from the per-check results (plan 3.2.1: the command still exits 0). */
export const doctorPayload = (checks: readonly DoctorCheck[]): { healthy: boolean; checks: DoctorCheck[] } => ({
  healthy: checks.every((check) => check.status !== "error"),
  checks: [...checks]
});
