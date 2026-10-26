import type { RefreshResult } from "@rivus/snorlax-protocol";

/** The human sync line refresh and rebuild share (plan 3.13 rule 2). A reason is appended when the report has one. */
export const syncLine = (sync: RefreshResult["sync"]): string => {
  if (sync.state === "unpaired") {
    const text = "sync: not paired";
    return sync.message === undefined || sync.message === "" ? text : `${text} (${sync.message})`;
  }
  const text =
    sync.state === "revoked" ? "sync: revoked" : `sync: ${sync.state}, pushed ${sync.pushed}, pulled ${sync.pulled}`;
  return sync.message === undefined || sync.message === "" ? text : `${text} (${sync.message})`;
};
