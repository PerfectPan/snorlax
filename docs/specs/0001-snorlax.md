# Spec 0001: Cross-Device Agent Usage

## Status

Accepted (owner, 2026-10-22)

Paired Plan: [docs/plans/0001-snorlax.md](../plans/0001-snorlax.md)

## Problem And Scope

A developer who runs several coding agents on more than one machine has no single place to see how many tokens
they used and what it cost. Each agent records its usage only in local logs on the machine that ran it.

snorlax reads those logs on every machine, adds the numbers up across machines, and shows them on the macOS menu
bar and in desktop widgets.

Included:

- Token counts (input with cache reads and writes, output with reasoning), model requests, new sessions and cost
  for Claude Code, Codex, Gemini CLI, Grok, opencode and Pi: the agents whose usage `@rivus/agent-kit` decodes.
- Totals for today, the last 7 days and the last 30 days, by agent, by model and by device, plus a daily series
  and today's hourly series.
- A macOS menu bar app and desktop widgets; a headless collector on Linux.
- Sync through a Worker on the user's own Cloudflare account; single-machine use without any backend.

Excluded:

- Showing which agents are working right now (agent presence). A later Spec covers it.
- Teams, several users per backend, Windows, the Mac App Store.
- Subscription quota and rate-limit status, which agents expose only through hooks or status lines.
- Agents whose usage exists only in a cloud account, such as Cursor.

## Behavioral Requirements

- R1 Non-invasive. The collector must only read files the agents write. It must not install hooks, plugins or
  extensions, and must not change agent configuration. It writes only to its data directory, its own login item
  (launchd or systemd user unit) and its own keychain item.
- R2 Incremental. A collection run must read only content written since the previous run. Files that did not
  change are not read again.
- R3 Count once. Every model request counts once, including requests an agent stores in several files and runs
  that are killed before they finish.
- R4 Retention. Usage that was counted must stay counted after the agent deletes its old logs.
- R5 Local view. Without a backend, the menu bar shows this machine's tokens and cost for today, the last 7 days
  and the last 30 days.
- R6 Cross-device. With a backend, every paired device's usage appears on every paired Mac within two collection
  intervals after it is logged, while both devices are online.
- R7 Offline. While the backend is unreachable, collection continues. Pending usage uploads after the backend is
  reachable again, without double counting.
- R8 Time zones. Days, "today" and the daily series follow the time zone of the device that shows them.
- R9 Cost. A request's cost is the amount the agent logged when it logged one, otherwise its tokens at the pricing
  table's rates. A request whose model has no price adds no cost and is counted as unpriced; the app marks totals
  that include unpriced requests.
- R10 Upload content. Uploads contain only the bucket fields: device id, UTC hour, agent id, model name and numeric
  totals. Prompts, file paths, project names and session ids never leave the machine.
- R11 Device ownership. A device writes only its own usage. Revoking a device rejects its later writes and keeps
  the usage it already uploaded.
- R12 Widget. The desktop widget shows today's and the last 7 days' totals from the latest snapshot. It may lag the
  menu bar by the refresh budget macOS grants widgets.
- R13 Diagnostics. `snorlax status` reports the last scan, the last sync and decode failures per agent.
  `snorlax doctor` reports problems with Node, the data directory, the keychain, the backend and scheduling.
- R14 Uninstall. After the app is removed and `snorlax uninstall` runs (or the login item and the data directory
  are deleted), no snorlax file remains, and no file under any agent directory was ever created or changed.

## Domain Invariants

- A usage bucket is identified by (device id, UTC hour, agent id, model) and holds absolute totals for that key.
- Only the owning device writes its buckets.
- Writing the same bucket again leaves the stored state unchanged.
- The local ledger of each device is authoritative for that device. The backend holds copies and can be rebuilt
  from the ledgers.
- Device ids are generated once per data directory, never derived from the host name.

## Acceptance Examples

### S1: First run counts the history

- Given fixture logs for Claude Code and Codex with known per-model totals
- When `snorlax refresh` runs with an empty data directory
- Then the snapshot's totals by agent and by model equal the fixture totals

### S2: Later runs read only new content

- Given a completed run
- When three requests are appended to one fixture file and `snorlax refresh` runs again
- Then the totals grow by exactly those three requests, and no other source is decoded again

### S3: A killed run does not double count

- Given a run that is stopped after decoding records and before its ledger transaction commits
- When `snorlax refresh` runs again
- Then the totals equal those of one uninterrupted run

### S4: Repeated records count once

- Given a Claude Code subagent file that starts with copies of its parent's records
- When `snorlax refresh` runs
- Then each request id counts once

### S5: Deleted logs keep their usage

- Given counted usage for a session
- When the session's file is deleted and `snorlax refresh` runs
- Then every bucket keeps its totals

### S6: Two devices see the same totals

- Given devices A and B paired to one backend, each with its own fixture usage
- When each refreshes twice
- Then both snapshots list both devices, and each total equals the sum of A's and B's ledgers

### S7: Offline usage uploads later

- Given device A offline for three refreshes that record new usage
- When the backend becomes reachable and A refreshes
- Then the backend's buckets for A equal A's ledger, and B shows them after its next refresh

### S8: Uploading again changes nothing

- Given device A uploads every bucket a second time
- When B refreshes
- Then the backend rows and B's totals are unchanged

### S9: A device writes only its own usage

- Given device A's token
- When it writes buckets under device B's id
- Then the request is rejected with 403 and B's buckets are unchanged
- And after A is revoked, A's writes are rejected with 401 and A's earlier buckets remain

### S10: Days follow the viewer's time zone

- Given buckets for 15:00–17:00 UTC on 2026-10-22
- When the snapshot is built in `Asia/Shanghai`
- Then the 15:00 bucket belongs to 2026-10-22 and the 16:00 and 17:00 buckets to 2026-10-23

### S11: Unpriced models are marked

- Given requests for a model that the pricing table does not list
- When `snorlax refresh` runs
- Then their tokens are counted, the cost excludes them, and the snapshot reports their count as unpriced

### S12: Logged cost wins

- Given Pi or opencode records that carry the agent's own cost
- When `snorlax refresh` runs
- Then the bucket cost equals the logged amounts

### S13: The widget follows the snapshot

- Given the app is running
- When the collector writes a new snapshot
- Then the app copies it to the shared container and the widget shows the new totals at its next timeline reload

### S14: Agent directories stay untouched

- Given a temporary `HOME` with fixture agent directories
- When `snorlax install`, `snorlax refresh`, `snorlax pair` and `snorlax uninstall` run
- Then a content hash of every agent directory is the same before and after

### S15: Uploads carry only bucket fields

- Given a sync with fixture usage that includes project paths and prompts
- When the collector uploads
- Then every request body validates against the strict bucket schema and contains none of those strings

## Compatibility And Constraints

- Public API: the `snorlax` CLI commands and their `--json` outputs, the snapshot file and the HTTP API, each
  versioned (`schemaVersion` 1 for outputs and snapshot, `/v1` for HTTP).
- Persisted data: the local ledger (SQLite, forward-only migrations) and the D1 database (forward-only migrations).
- Configuration: the data directory (`SNORLAX_HOME` overrides it), device name, backend URL.
- Runtime: Node.js 22.13 or later on each machine for the collector; macOS 14 or later for the app and widgets.
- Operational bounds: the Cloudflare Workers Free plan (100,000 requests and, for D1, 5 million rows read and
  100,000 rows written per day) must cover three devices syncing every 5 minutes.

## Acceptance Evidence

- Scenario IDs and corresponding tests: filled in by the implementing PRs, one row per scenario, in the Plan's
  validation ledger.
- Runtime or package evidence: the owner's two-device and one-Linux-machine check (Plan, section 5.4).
