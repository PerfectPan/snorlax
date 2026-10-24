import type { Status } from "@rivus/snorlax-protocol";
import { Effect } from "effect";

import { statusFlow } from "./flow.ts";

const humanStatus = (payload: Status): string =>
  [
    `snorlax ${payload.version}`,
    `data directory: ${payload.dataDir}`,
    `device: ${payload.device.name ?? "(unnamed)"} (${payload.device.id ?? "no id yet"})`,
    `last scan: ${payload.lastScanAt ?? "never"}`,
    `sync: ${payload.sync.state}${payload.sync.at === null ? "" : ` at ${payload.sync.at}`}`,
    `decode failures: ${
      Object.keys(payload.failuresByAgent).length === 0
        ? "none"
        : Object.entries(payload.failuresByAgent)
            .map(([agent, count]) => `${agent}=${count}`)
            .join(" ")
    }`,
    `agents: ${payload.agents.map((agent) => `${agent.agent}=${agent.status}`).join(" ")}`
  ].join("\n");

/** `snorlax status` (plan 3.1): version, data directory, device, last scan and sync, detected agents. */
export const statusCommand = {
  name: "status",
  description: "version, data directory, device, last scan and sync, decode failures, detected agents",
  flags: {},
  run: () => Effect.map(statusFlow, (payload) => ({ payload, human: `${humanStatus(payload)}\n` }))
};
