import type { DoctorCheck } from "@rivus/snorlax-protocol";

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

/** The whole `doctor` verdict from the per-check results (plan 3.2.1: the command still exits 0). */
export const doctorPayload = (checks: readonly DoctorCheck[]): { healthy: boolean; checks: DoctorCheck[] } => ({
  healthy: checks.every((check) => check.status !== "error"),
  checks: [...checks]
});
