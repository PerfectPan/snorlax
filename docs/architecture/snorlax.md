# snorlax architecture

This guide describes the shipped source architecture for maintainers. The behavioral contract remains in
[Spec 0001](../specs/0001-snorlax.md). Protocol schemas and tests are the source of truth for exact fields.

## Boundaries

| Component | Responsibility |
| --- | --- |
| `packages/protocol` | Strict `zod/mini` schemas for CLI, snapshots and HTTP; generated JSON Schema and Swift types |
| `packages/collector` | Node CLI: scan, price, persist, sync, schedule and produce snapshots |
| `packages/worker` | Hono HTTP API, device authentication and D1 bucket storage |
| `apps/macos` | Swift menu bar app, WidgetKit extension and shared `SnorlaxKit` models |
| agent-kit | Read-only agent decoding, incremental scan state, pricing and platform adapters |

Each machine owns its local usage partition. A generated device id, not a host name, identifies it. The local
SQLite ledger is authoritative; the backend is a replaceable synchronized copy. Uploads contain absolute bucket
totals, not increments. Repeating a push must not double count usage.

The app reads `snapshot.json` and invokes one-shot CLI commands. It never reads or changes the ledger or config
directly; its only data-directory write besides publishing the widget snapshot is the discovered `node-path`.
There is no app-to-collector server, socket or resident RPC process.

## Collector layers

Imports flow from `cli` to `commands`, `capabilities`, `modules`, and `core`. A command does not import another
command. Shared pure rules live in `core`; IO with one implementation lives in `modules`; replaceable systems
(scheduler, secrets and backend) live in `capabilities`. Each module exposes its named entry file, not barrels.

Command flows use Effect scopes for database, lock and process lifetimes. Pure rules do not depend on Effect.
Capabilities provide `Context.Service` interfaces and Layers; constructing a Layer has no side effects. The CLI
selects implementations and owns the exhaustive error-tag-to-exit-code mapping. Lower layers define their own
errors without knowing CLI failure codes. These boundaries are enforced by
[`structure.test.ts`](../../packages/collector/test/structure.test.ts).

`status`, `doctor` and `snapshot` are read-only: no repairs, directory creation or credential probes. Diagnostics
report failed checks rather than repairing them. `doctor` exits 1 when unhealthy and 0 when healthy.

With `--json`, commands emit one versioned JSON object on stdout. Diagnostics and human messages stay off that
stream. Invalid arguments exit 2; failures exit 1. A refresh that committed its scan but failed to sync still
returns a successful scan with the sync failure reported. Closing stdout early (EPIPE) preserves the command's
own exit status. Signal interruption releases resources and retains the signal's exit semantics.

## Ledger and refresh

The data directory is `SNORLAX_HOME`, or the platform default (Application Support on macOS; the XDG data home
on Linux). It has mode 0700. `ledger.db` uses SQLite's rollback journal, not WAL, so read-only commands do not
create WAL sidecars and migration backups can copy one database file. Connections have a 5-second busy timeout.
Migrations are forward-only; backups are made before migration and the latest two are retained.

The ledger stores local and remote buckets, remote devices, scan state, session-first-seen records and metadata
(device identity, last completed scan, pull cursor and pricing version). A local bucket is keyed by UTC hour,
agent and model; remote buckets add device id. Agent-kit token conventions apply: input includes cache reads and
writes; output includes reasoning. Unknown costs remain unpriced rather than being invented as zero-cost usage.

A refresh performs the following:

1. Acquire the per-data-directory process lock, with an interruptible 60-second wait. Refresh and rebuild share it.
2. Scan from the saved state with a two-hour overlap before the last completed scan. The first scan starts at zero
   with no state. The overlap exceeds the decoder's 30-minute quiet window. Keep decode/source failure counts.
3. Price records using the bundled LiteLLM table through agent-kit, aggregate hourly usage, and mark buckets dirty.
4. Commit buckets, session tracking, scan state and the completed-scan timestamp in one transaction. Interruption
   before commit must not partially count the scan.
5. When paired, push dirty buckets (at most 200 per request), then pull changes and device metadata. Clear dirty
   markers only after a successful push response. Never hold a database transaction across HTTP.
6. Build and atomically replace the snapshot, then release the lock. A failed sync does not discard the local scan.

The scan state holds source cursors and request hashes, not cached full transcripts. Tests use generated fixtures;
agents must not read or scan real session files. Real-log measurements remain owner-run only.

`rebuild --days n` accepts 1–180 days. Under the same lock it zeroes local buckets in that window, clears applicable
session tracking and scan state, and rescans in one transaction. Empty rebuilt buckets are still uploaded as zero
so the backend replaces stale totals. Deleted source logs cannot be recovered: rebuilding zeroes their recorded
usage and propagates that replacement to synced devices. The app requires explicit destructive confirmation;
the CLI status advice also warns about this risk. Rebuilding is never automatic.

New table prices apply to new usage. Ordinary refreshes preserve the ledger's historical pricing version. Only a
full `rebuild --days 180` records the new version for an already scanned ledger; a shorter rebuild does not.
`status.pricingChanged` compares the ledger version to the bundled version, including a missing historic version.
Custom model overrides are tracked separately in [#23](https://github.com/PerfectPan/snorlax/issues/23).

## Snapshot and compatibility

The snapshot combines local and remote buckets into today, 7-day and 30-day totals, per-agent/model/device rows,
a 180-local-day daily series and today's hourly series. Dates follow the viewing device's time zone. A UTC-hour bucket belongs
to the local day/hour containing its start; non-whole-hour-offset zones therefore use an approximation.

Write a temporary snapshot and rename it, preserving the last good snapshot on failure. The app watches the data
directory because replacement changes the file, with a 60-second fallback timer. It publishes the widget's copy
in the App Group container and requests timeline reloads.

Schemas are versioned. The app rejects an unsupported newer schema with an update instruction. Generated Swift
models and protocol JSON schemas are committed and regeneration is checked in CI. Bucket schema additions need
compatible defaults in the protocol, local ledger and D1; migrations remain additive.

## Sync and backend

The API is defined in [`http.ts`](../../packages/protocol/src/http.ts) and
[`app.ts`](../../packages/worker/src/http/app.ts). Device registration and revocation require the admin token.
A device may upload only its own buckets; authenticated devices may pull the shared bucket stream and device list.
Revocation keeps historic buckets. D1 read replication stays disabled.

Each push validates all rows before writing, and applies the bucket replacements and device timestamp in one
batch transaction. Each replaced row gets a new monotonically increasing sequence. Pulls request rows after a
cursor, ordered by sequence. A nonempty page returns its last sequence; only an empty page returns `next: null`.
The collector rejects a non-advancing cursor and commits each page with its cursor before requesting the next.

Requests have a 15-second timeout and bodies are capped at 1 MB. HTTP bodies reject unknown fields and require
JSON Content-Type; duplicate query parameters are rejected. Bearer token syntax follows RFC 6750. Device tokens
are random base64url values stored as SHA-256 hashes by the Worker. HTTP concerns stay in `http/`; domain use
cases own their errors, stores own SQL, and HTTP mapping is centralized. Atomic invariants stay in SQL/batches,
not read-then-write application sequences. Worker structure tests enforce these boundaries.

There is no retry loop inside one refresh. Network, timeout and backend quota failures leave dirty data for the
next scheduled run. The snapshot remains usable offline. Re-pairing replaces a device registration/token, resets
remote state and marks every local bucket dirty, including buckets older than the displayed 180-day heatmap.
Unpairing deletes the device token before clearing the backend URL and regenerates a local-only snapshot.
See [pairing](../development/pairing.md) for partial failures, revocation and moving the backend origin.

Backend deployments, secrets, account setup and npm publishing are owner operations. See the
[Worker runbook](../development/worker.md) and [release runbook](../development/release.md).
The single-user Workers/D1 deployment is current scope; presence tracking, several users and a self-hosted Node
server require separate design work.

## macOS and scheduling

The app requires macOS 14 or later. It bundles the collector and a compiled Swift launcher; Node remains a runtime
prerequisite. Discovery validates Node 22.13 or later, records `node-path`, and the launcher uses that path or fixed
fallback locations, never an uncontrolled PATH. The CLI-installed schedule uses its generated `refresh.sh` so a
Node upgrade need not leave a stale executable path in the schedule. `doctor` validates the launcher and Node.

The app's `SMAppService` registration and the CLI LaunchAgent fallback share one label and are mutually exclusive.
Turn off the app-owned job before installing/uninstalling the CLI fallback. Linux uses a systemd user timer.
Refresh stays every 300 seconds. Interrupted installation stops child processes and cleans up its own partial job.
The collector's rotating log is capped at 5 MB with three files kept; launchd must not create unbounded redirects.

The popover places a 180-day token-intensity heatmap below today's, 7-day and 30-day totals. It shows date,
tokens and estimated cost on hover, and distinguishes missing daily history from zero usage. The pricing-change
notice offers an explicit asynchronous 180-day rebuild, with duplicate-click protection and no automatic retry.

The main app is not sandboxed because it invokes Node. The widget is sandboxed and reads the App Group snapshot.
An ad-hoc build is not proof that Personal Team signing, App Group access or widget registration works. A second
Apple ID's bundle-id/signing validation is deferred to [#50](https://github.com/PerfectPan/snorlax/issues/50).
See the [macOS guide](../../apps/macos/README.md) for the signed owner-run procedure.

## Privacy and operational limits

- Agent directories are strictly read-only; no hooks or agent configuration changes.
- Only defined bucket metrics and device/agent/model identifiers leave the machine: no prompts, local paths,
  project names or session ids. Keep protocol schemas strict and preserve the privacy tests.
- Config stores no tokens. Device credentials belong in Keychain/libsecret; the pairing admin token is stdin-only
  and is not persisted. Logs and diagnostics are redacted.
- Uninstall removes only snorlax-owned data. It preserves unrelated files and refuses unsafe directory ownership;
  a credential-removal failure retains the data needed to recover.
- Restore an older app/collector only with a compatible ledger or its migration backup. Do not assume an expired
  transcript can reconstruct historic usage. Re-pairing uploads only that device's own retained local buckets,
  not its cached copies of other devices' buckets. It clears `remote_buckets`, `remote_devices` and the pull
  cursor before syncing. Before backend recovery or re-pairing, preserve a consistent, verified backup of each
  device's ledger. Full recovery needs every device's own data or a verified backup of that data. If a device is
  unavailable, preserve any surviving cached remote history before re-pairing; do not clear it and assume another
  device can automatically upload it. See [the recovery warning](../development/pairing.md#backend-recovery-warning).
- Monitor the actual Cloudflare quotas rather than treating a capacity estimate as a guarantee. At three devices,
  300-second refreshes and ten changed buckets per refresh, the original estimate was about 17,000 D1 row writes,
  35,000 reads and 3,500 Worker requests per day; workload and provider limits can change.

For acceptance scope, synthetic performance results and deferred follow-ups, see
[validation](../development/validation.md). The completed execution plan is retained by Git history, not a second
archive. Historical numeric plan references in code comments refer to that retired design.
