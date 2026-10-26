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

/**
 * The Node binary the CLI's job file names, as the flow found it on disk; `unchecked` carries why the flow could not
 * look, such as EACCES from a directory on the path this user cannot search.
 */
export type NodeBinary = "runnable" | "missing" | "not-executable" | { readonly unchecked: string };

/** What the flow observed about the scheduled refresh; `node` is undefined when no job file names a Node binary. */
export interface ScheduleObservation {
  readonly job: JobInspection;
  readonly node: NodeBinary | undefined;
}

const REINSTALL =
  "run `snorlax install` again with the Node you want it to use, or turn on Launch at login in Snorlax's Settings";

const SYSTEMD_REINSTALL = "run `snorlax install` again with the Node you want it to use";

type InspectedJob = Extract<JobInspection, { kind: "inspected" }>;

const checkOf = (status: DoctorCheck["status"], detail: string): DoctorCheck => ({
  id: "schedule",
  status,
  detail
});

/**
 * launchd's verdict. The CLI's LaunchAgent runs the Node binary `snorlax install` ran on — often a versioned
 * path (nvm, Homebrew Cellar) that an upgrade removes, which silently stops the job — so a missing or
 * non-executable Node is an error. So is a Node path this user cannot check: launchd starts the job as this
 * user, which cannot reach that Node either. Not scheduling at all is a normal way to use the app (it
 * refreshes when asked), so every state that is not broken outright is a warning, never an error.
 */
const launchdSchedule = (job: InspectedJob, node: NodeBinary | undefined): DoctorCheck => {
  const { cliJob, loaded } = job;
  if (loaded.from === "app") {
    return cliJob === undefined
      ? checkOf("ok", `Snorlax.app's Launch at login schedules refresh (${loaded.file})`)
      : checkOf(
          "warn",
          `Snorlax.app's Launch at login schedules refresh, and ${cliJob.file} registers the same job; turn ` +
            "Launch at login off, run `snorlax uninstall`, then turn Launch at login on again"
        );
  }
  if (cliJob === undefined) {
    if (loaded.from === "cli") {
      return checkOf(
        "warn",
        `launchd runs the LaunchAgent, but ${loaded.file} is gone; run \`snorlax install\` to restore it or ` +
          "`snorlax uninstall` to stop it"
      );
    }
    if (loaded.from === "unknown") {
      return checkOf("warn", `a refresh job is loaded, but its owner cannot be confirmed: ${loaded.reason}`);
    }
    return checkOf(
      "warn",
      "refresh is not scheduled: turn on Launch at login in Snorlax's Settings, or run `snorlax install`; until " +
        "then the snapshot changes only when refresh runs"
    );
  }
  if (cliJob.nodePath === undefined || node === undefined) {
    return checkOf("warn", `cannot read the Node path from ${cliJob.file}; run \`snorlax install\` to rewrite it`);
  }
  if (node === "missing" || node === "not-executable") {
    const problem = node === "missing" ? "does not exist" : "is not executable";
    return checkOf(
      "error",
      `${cliJob.file} runs Node at ${cliJob.nodePath}, which ${problem}, so scheduled refresh stops; ${REINSTALL}`
    );
  }
  if (node !== "runnable") {
    return checkOf(
      "error",
      `cannot check the Node at ${cliJob.nodePath} that ${cliJob.file} runs: ${node.unchecked}; ${REINSTALL}`
    );
  }
  if (loaded.from === "cli") {
    return checkOf("ok", `the LaunchAgent ${cliJob.file} is loaded and runs Node at ${cliJob.nodePath}`);
  }
  if (loaded.from === "unknown") {
    return checkOf("warn", `cannot tell whether launchd runs ${cliJob.file}: ${loaded.reason}`);
  }
  return checkOf("warn", `${cliJob.file} exists, but launchd has not loaded it; run \`snorlax install\` to load it`);
};

/**
 * The same decisions as `launchdSchedule`, worded for the systemd user timer. Linux has no app registering
 * the timer, so a job that says it came from the app is treated as an owner that cannot be confirmed.
 */
const systemdSchedule = (job: InspectedJob, node: NodeBinary | undefined): DoctorCheck => {
  const { cliJob, loaded } = job;
  if (loaded.from === "app") {
    return checkOf(
      "warn",
      `a refresh timer is loaded from ${loaded.file}, which is not a unit file snorlax install writes`
    );
  }
  if (cliJob === undefined) {
    if (loaded.from === "cli") {
      return checkOf(
        "warn",
        `systemd runs the user timer ${loaded.file}, but the service unit it starts is gone; run ` +
          "`snorlax install` to restore it or `snorlax uninstall` to stop it"
      );
    }
    if (loaded.from === "unknown") {
      return checkOf("warn", `a refresh job is loaded, but its owner cannot be confirmed: ${loaded.reason}`);
    }
    return checkOf(
      "warn",
      "refresh is not scheduled: run `snorlax install`; until then the snapshot changes only when refresh runs"
    );
  }
  if (cliJob.nodePath === undefined || node === undefined) {
    return checkOf("warn", `cannot read the Node path from ${cliJob.file}; run \`snorlax install\` to rewrite it`);
  }
  if (node === "missing" || node === "not-executable") {
    const problem = node === "missing" ? "does not exist" : "is not executable";
    return checkOf(
      "error",
      `the Node in ${cliJob.file} ${problem} (${cliJob.nodePath}), so scheduled refresh stops; ${SYSTEMD_REINSTALL}`
    );
  }
  if (node !== "runnable") {
    return checkOf(
      "error",
      `cannot check the Node at ${cliJob.nodePath} that ${cliJob.file} runs: ${node.unchecked}; ${SYSTEMD_REINSTALL}`
    );
  }
  if (loaded.from === "cli") {
    return checkOf("ok", `the systemd user timer is running and ${cliJob.file} runs Node at ${cliJob.nodePath}`);
  }
  if (loaded.from === "unknown") {
    return checkOf("warn", `cannot tell whether systemd runs ${cliJob.file}: ${loaded.reason}`);
  }
  return checkOf(
    "warn",
    `${cliJob.file} exists, but the systemd user timer is not running; run \`snorlax install\` to enable it`
  );
};

/**
 * Whether refresh runs on its own. Only a missing, non-executable or uncheckable Node is an error, and only
 * an error turns `healthy` false (`doctorPayload`). Every other state is a warning: not scheduling is a
 * normal way to use the app, which refreshes when asked.
 */
export const scheduleCheck = ({ job, node }: ScheduleObservation): DoctorCheck => {
  if (job.kind === "unsupported") {
    return checkOf("warn", `${job.reason}; refresh runs only when something calls it`);
  }
  return (job.scheduler ?? "launchd") === "systemd" ? systemdSchedule(job, node) : launchdSchedule(job, node);
};

/** The whole `doctor` verdict from the per-check results (plan 3.2.1: the command still exits 0). */
export const doctorPayload = (checks: readonly DoctorCheck[]): { healthy: boolean; checks: DoctorCheck[] } => ({
  healthy: checks.every((check) => check.status !== "error"),
  checks: [...checks]
});
