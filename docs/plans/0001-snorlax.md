# Plan 0001: snorlax

- Status: accepted (owner decisions recorded 2026-10-22). Milestone 1, local use on one Mac (Batches 0–4), is
  executable now; Milestone 2 waits for agent-kit K1 and K2; Milestone 3 needs the owner's Cloudflare account (6.1)
- Owner: PerfectPan
- Reviewer: unconfirmed
- Last updated: 2026-10-22
- Paired Spec: [docs/specs/0001-snorlax.md](../specs/0001-snorlax.md)

## Contents

1. Background and goals
2. Outline
3. Detailed design
4. Rollout and stability
5. Verification
6. Execution plan
7. Risks, open questions, and follow-up
8. Appendix

## 1. Background and goals

### 1.1 Current behavior and constraints

- Coding agents record token usage only in local logs: Claude Code in `~/.claude/projects/**/*.jsonl`, Codex in
  `~/.codex/sessions`, Gemini CLI under `~/.gemini/tmp`, Grok under `~/.grok/sessions`, opencode in
  `opencode.db` under its data home, Pi under `~/.pi/agent/sessions`.
- [`@rivus/agent-kit`](https://github.com/PerfectPan/agent-kit) 0.20.0 decodes usage for those six agents into one
  `UsageRecord` model. `scanUsage` continues from a saved state and reads only what was written since; it counts a
  request once by the agent's request key, and reports a source's last requests once the source has been quiet for
  30 minutes. The state holds a cursor per source and a hash per request counted since `since`, about 1 MB for a
  busy month.
- agent-kit's `/cost` prices records with a table the caller passes in. **The kit ships no prices.**
  [agent-presence](https://github.com/PerfectPan/agent-presence) keeps its own LiteLLM snapshot
  (`scripts/update-pricing.mjs`, a weekly workflow, family fallbacks).
- Claude Code deletes transcripts older than `cleanupPeriodDays` (30 by default).
- agent-presence publishes how many agents are working to a Feishu signature using agent hooks. It is out of scope
  here; section 8.3 records how it can later move to this design.

### 1.2 Problem

There is no single place that shows one person's agent usage across machines. Existing trackers either need hooks
or plugins inside the agents, identify machines by host name (and then need tools to merge duplicates), keep scan
caches that grow to gigabytes, or report to a backend the user does not control. Section 8.1 lists the lessons.

### 1.3 Goals and success criteria

- Every requirement and scenario of Spec 0001 holds (6.2 maps them to tests).
- An incremental `snorlax refresh` on a machine with a month of history finishes in seconds; the number is set from
  the Batch 0 measurement (S2 in 6.4) and recorded in section 7.
- Three devices syncing every 5 minutes stay within the Cloudflare Workers Free plan (estimate in 8.2).
- Removing snorlax leaves agent directories byte-for-byte unchanged (Spec S14).

### 1.4 Non-goals

- Agent presence (who is working now); see 8.3.
- Teams, several users per backend, Windows, Mac App Store distribution.
- Quota or rate-limit display, Cursor usage, agents agent-kit does not decode (they can be added through the kit's
  `providers` option without changing snorlax; see 3.10).

## 2. Outline

### 2.1 Design principles

- **One writer per partition.** Only the device that read a log writes the usage derived from it.
- **Absolute values, not increments.** A device uploads the current totals of a bucket; the backend replaces the
  row. Retries and repeated uploads are harmless.
- **The local ledger is authoritative.** The backend can be emptied and rebuilt by re-uploading.
- **Read-only towards agents.** Nothing is written into an agent's home, configuration or process.
- **Numbers only leave the machine.** See Spec R10.
- **Two channels between Swift and TypeScript.** The app reads a snapshot file and runs one-shot CLI commands.
  No ports, sockets or long-lived RPC.

### 2.2 Boundaries and responsibilities

| Component | Language | Owns |
| --- | --- | --- |
| `packages/protocol` (`@rivus/snorlax-protocol`, private, bundled into its users) | TS | zod definitions of buckets, snapshot, CLI outputs, HTTP bodies; JSON Schema export |
| `packages/collector` (`@rivus/snorlax`, published) | TS, Node | the `snorlax` CLI: scanning, ledger, sync client, snapshot, scheduling on Linux and fallback macOS |
| `packages/worker` (`@rivus/snorlax-worker`, private) | TS, Workers | HTTP API, device tokens, D1 schema and migrations |
| `apps/macos` | Swift | menu bar app, desktop widget, `SnorlaxKit` (generated types and view models), login item registration |
| agent-kit | TS (dependency) | decoding agent logs, scan state, pricing computation, Node platform, process lock |

### 2.3 Main path

```text
this Mac
  agent logs (read only)
     | scanUsage, only new content
     v
  collector `snorlax refresh`  (launchd, every 300 s; or the app's "Refresh now")
     | one SQLite transaction: scan state + hourly buckets
     v
  ledger.db --push dirty buckets--> Worker --upsert--> D1
     ^                              |
     +----pull buckets after seq----+   (other devices push and pull the same way)
     |
     v
  snapshot.json --watched by--> menu bar app --copies to App Group--> desktop widget
                                     |
                                     +--runs `snorlax <command> --json`--> collector
```

### 2.4 Design decisions

| # | Decision | Alternatives considered | Why |
| --- | --- | --- | --- |
| D1 | Native Swift app (SwiftUI `MenuBarExtra` + WidgetKit) | Tauri, Electron, Go systray with a web popover | Desktop widgets exist only through WidgetKit. Owner decision. |
| D2 | Collector is a separate Node process; the app reads `snapshot.json` and runs one-shot CLI commands | Run kit inside the app with JavaScriptCore and a Swift `Platform`; child process with stdio JSON-RPC; collector serving HTTP on 127.0.0.1 | JavaScriptCore needs a Swift rewrite of the whole platform port and puts log scans in the UI process. A child process stops collecting when the app quits. A local port needs its own authentication and can collide. The chosen form keeps collecting with the app closed, and every app call can be repeated in a terminal. |
| D3 | Absolute hourly buckets keyed by (device, UTC hour, agent, model), single writer per device | Append-only increments or a request event log | Increments make retries double count and need server-side de-duplication; an event log uploads far more and leaks more detail. |
| D4 | Server assigns a sequence number per write; clients pull changes after a cursor and aggregate locally | Server computes the 7-day totals on each request | D1 bills rows scanned. Server-side 7-day sums for three devices refreshing every 5 minutes use about half of the free read quota; cursor pulls use under 1% (8.2). Clients need the buckets anyway to cut days in their own time zone. |
| D5 | Cost is computed at collection time and stored in the bucket | Store tokens only and price when displaying | Per-request detail (1-hour cache writes, Codex priority multiplier, agent-logged amounts) is lost once records are summed into buckets. A pricing change applies to new usage; `snorlax rebuild --days N` reprices logs that still exist. |
| D6 | Cloudflare Worker + D1 on the owner's account | Shared folder (iCloud Drive, Syncthing), object storage | Owner decision. Works on machines without iCloud, and later from an iPhone widget. Replaceability is at the HTTP interface (3.2.4). |
| D7 | Random device id created on first run | Host name | Host names change and repeat; a tracker keyed by host name needs merge tooling. |
| D8 | v1 collector runs once per launchd interval and exits | Resident daemon | Nothing to keep in memory between runs; launchd runs a missed interval after wake. A resident watcher arrives only with presence (8.3). |
| D9 | v1 app bundles one JS file and runs it with the Node already installed; Node SEA later | Node SEA from the start | Keeps the bundle around 2 MB and avoids hardened-runtime JIT entitlements until distribution needs them. |
| D10 | New repository, not part of agent-presence | Grow agent-presence | Owner decision. Presence can later become an output of this collector (8.3). |
| D11 | GPL-3.0-only | MIT | Repository convention for applications. |

## 3. Detailed design

### 3.1 Entry points

| Command | Caller | Does | `--json` output |
| --- | --- | --- | --- |
| `snorlax refresh` | launchd / systemd timer, app | waits up to 60 s for the ledger lock, scans, syncs when paired, writes the snapshot | `RefreshResult` |
| `snorlax status` | app settings, terminal | version, data directory, device, last scan and sync, decode failures per agent, detected agents | `Status` |
| `snorlax pair --url <url> --name <name>` | app settings, terminal | reads the admin token from stdin, registers the device, stores the device token in the keychain | `PairResult` |
| `snorlax unpair` | app settings, terminal | deletes the device token; local data stays | `Ok` |
| `snorlax rebuild --days <n>` | owner, after a pricing change or for repair | 1 ≤ n ≤ 30: zeroes the last n days of local buckets, rescans them and marks them for upload | `RefreshResult` |
| `snorlax doctor` | app diagnostics, terminal | checks Node version, data directory permissions, keychain access, backend reachability, scheduling | `Doctor` |
| `snorlax install` / `uninstall` | Linux; macOS without the app | writes or removes the systemd user timer or `~/Library/LaunchAgents` plist; `uninstall --data` also deletes the data directory and keychain item | `Ok` |
| `snorlax snapshot` | terminal | prints the current snapshot | `Snapshot` |

Argument parsing uses `node:util` `parseArgs`. There is no interactive prompt in any command.

### 3.2 Interfaces

#### 3.2.1 CLI calling convention

- With `--json`, stdout carries exactly one JSON object with `schemaVersion: 1` and `ok`. Human-readable output and
  diagnostics go to stderr and the log file.
- Exit code 0: success (a refresh whose sync failed still exits 0 and reports `sync.ok: false`). Exit 1: failure,
  stdout is `{"schemaVersion":1,"ok":false,"error":{"code":"…","message":"…"}}`. Exit 2: invalid arguments.
- Error codes: `locked` (lock not acquired in 60 s), `node-version`, `data-dir`, `keychain`, `network`,
  `unauthorized`, `forbidden`, `invalid-response`, `pricing`, `internal`.
- Every command can be repeated safely. `refresh` and `rebuild` hold the same lock.
- The app never reads or writes `ledger.db` or `config.json`; configuration changes go through commands. The only
  file the app writes in the data directory is `node-path` (3.11).

Example:

```text
$ snorlax refresh --json
{"schemaVersion":1,"ok":true,"scannedAt":"2026-10-22T12:35:10Z","records":412,"failures":0,"sync":{"ok":true,"pushed":9,"pulled":23}}
```

#### 3.2.2 Snapshot file

`<data>/snapshot.json`, rewritten whole after every refresh (write `snapshot.json.tmp`, then rename). Shape
(illustrative numbers):

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-10-22T12:35:12Z",
  "timeZone": "Asia/Shanghai",
  "totals": {
    "today": { "tokens": 812345678, "inputTokens": 801000000, "outputTokens": 11345678, "cacheReadTokens": 760000000, "costUsd": 312.4, "requests": 2210, "sessions": 41, "unpricedRequests": 0 },
    "last7d": { "…": "same fields" },
    "last30d": { "…": "same fields" }
  },
  "byAgent": [{ "agent": "claude-code", "today": {}, "last7d": {}, "last30d": {} }],
  "byModel": [{ "model": "claude-opus-5-5", "today": {}, "last7d": {}, "last30d": {} }],
  "byDevice": [{ "deviceId": "6f1c…", "name": "MacBook Pro", "isThisDevice": true, "lastPushAt": "…", "today": {}, "last7d": {}, "last30d": {} }],
  "daily": [{ "date": "2026-10-22", "tokens": 812345678, "costUsd": 312.4 }],
  "hourlyToday": [{ "hour": "2026-10-22T09:00:00+08:00", "tokens": 9812345 }],
  "status": {
    "lastScanAt": "2026-10-22T12:35:10Z",
    "sync": { "state": "ok", "at": "2026-10-22T12:35:11Z" },
    "failuresByAgent": {},
    "paired": true
  }
}
```

`tokens` is `inputTokens + outputTokens` in the kit convention (input includes cache reads and writes). `daily`
covers the last 30 local days including today; `hourlyToday` covers local hours of today. A bucket belongs to the
local day and hour that contain its UTC start hour (for zones with non-whole-hour offsets this is an
approximation, stated in the app's help). Day boundaries use `date-fns` with `@date-fns/tz`.

#### 3.2.3 Shared types

1. `packages/protocol` defines every interface above and in 3.2.4 with `zod/mini`. The collector and the Worker
   parse with these schemas at their boundaries; object schemas reject unknown keys on HTTP request bodies.
2. Its build exports JSON Schema files with `z.toJSONSchema` to `packages/protocol/schema/*.json` (committed).
3. `quicktype` (a devDependency of `packages/protocol`) generates Swift `Codable` types from those files into
   `apps/macos/SnorlaxKit/Sources/SnorlaxKit/Generated/` (committed).
4. CI fails when regeneration changes either output. Swift tests decode the sample snapshot and CLI outputs that the
   TypeScript tests write to `packages/protocol/fixtures/`.

#### 3.2.4 HTTP API

All bodies are JSON. Authentication is `Authorization: Bearer <token>`.

| Endpoint | Token | Request | Response |
| --- | --- | --- | --- |
| `GET /v1/health` | none | none | `200 { ok: true }` |
| `POST /v1/devices` | admin | `{ deviceId, name }` | `201 { deviceToken }`; `409` if the id exists and is not revoked |
| `PUT /v1/devices/:id/buckets` | that device | `{ buckets: Bucket[] }`, 1–200 rows, every row's `deviceId` equals `:id` | `200 { seq }` (highest seq written) |
| `GET /v1/buckets?after=<seq>&limit=<n>` | any device | n ≤ 1000, default 1000 | `200 { buckets, next }`; `next` is the last seq returned, or null when fewer than n rows |
| `GET /v1/devices` | any device | none | `200 { devices: [{ id, name, lastPushAt, revoked }] }` |
| `DELETE /v1/devices/:id` | admin | none | `204`; marks the device revoked, keeps its buckets |

Errors: `400` invalid body, `401` missing, unknown or revoked token, `403` device token used for another device's
path, `404` unknown route. Error bodies are `{ "error": { "code", "message" } }`.

Any backend that implements these endpoints with the same token rules and sequence semantics (3.5) can replace the
Worker; the collector only needs its URL. Inside the collector, `SyncBackend` has two implementations: the HTTP
client and an in-memory one for tests.

### 3.3 Data model

#### 3.3.1 Bucket

| Field | Type | Meaning |
| --- | --- | --- |
| `deviceId` | string (UUID) | created on first run, stored in the ledger |
| `hour` | integer | UTC hour start, epoch seconds |
| `agent` | string | agent-kit `CodingAgentId` (`claude-code`, `codex`, …) |
| `model` | string | model id as logged; empty string when the record names none |
| `inputTokens` | integer | includes cache reads and writes |
| `cacheReadTokens`, `cacheWriteTokens` | integer | subsets of `inputTokens` |
| `outputTokens` | integer | includes reasoning |
| `reasoningTokens` | integer | subset of `outputTokens` |
| `requests` | integer | model calls |
| `sessionsStarted` | integer | sessions first seen in this hour |
| `costUsd` | number | sum of known costs |
| `unpricedRequests` | integer | requests whose cost is unknown |

A count the log does not record adds 0 to a bucket.

#### 3.3.2 Ledger (`<data>/ledger.db`, SQLite through the kit platform's `sqlite`)

| Table | Content |
| --- | --- |
| `meta` | `device_id`, `device_name`, `last_scan_completed_at`, `pull_cursor`, `pricing_version` |
| `scan_state` | one row: the kit `UsageScanState` as JSON |
| `buckets` | the bucket fields + `dirty` (0/1); primary key (hour, agent, model) |
| `remote_buckets` | other devices' buckets as pulled, with `seq`; primary key (device_id, hour, agent, model) |
| `remote_devices` | id, name, last_push_at, revoked |
| `sessions_seen` | (agent, session_id) primary key, `first_hour` |

Schema version is `PRAGMA user_version`. Migrations are forward-only; before migrating, the collector copies
`ledger.db` to `ledger.db.bak-v<old>` and keeps the latest two backups.

#### 3.3.3 D1 schema (`packages/worker/migrations/0001_init.sql`)

```sql
CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_push_at INTEGER,
  revoked_at   INTEGER
);

CREATE TABLE buckets (
  device_id          TEXT    NOT NULL,
  hour               INTEGER NOT NULL,
  agent              TEXT    NOT NULL,
  model              TEXT    NOT NULL,
  input_tokens       INTEGER NOT NULL,
  cache_read_tokens  INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  output_tokens      INTEGER NOT NULL,
  reasoning_tokens   INTEGER NOT NULL,
  requests           INTEGER NOT NULL,
  sessions_started   INTEGER NOT NULL,
  cost_usd           REAL    NOT NULL,
  unpriced_requests  INTEGER NOT NULL,
  seq                INTEGER NOT NULL,
  PRIMARY KEY (device_id, hour, agent, model)
);
CREATE INDEX buckets_by_seq ON buckets (seq);
```

Write, one statement per row, all rows of a request in one `db.batch()`:

```sql
INSERT INTO buckets (device_id, hour, agent, model, input_tokens, cache_read_tokens, cache_write_tokens,
                     output_tokens, reasoning_tokens, requests, sessions_started, cost_usd, unpriced_requests, seq)
VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
        (SELECT COALESCE(MAX(seq), 0) + 1 FROM buckets))
ON CONFLICT (device_id, hour, agent, model) DO UPDATE SET
  input_tokens = excluded.input_tokens, cache_read_tokens = excluded.cache_read_tokens,
  cache_write_tokens = excluded.cache_write_tokens, output_tokens = excluded.output_tokens,
  reasoning_tokens = excluded.reasoning_tokens, requests = excluded.requests,
  sessions_started = excluded.sessions_started, cost_usd = excluded.cost_usd,
  unpriced_requests = excluded.unpriced_requests, seq = excluded.seq;
```

The same batch ends with `UPDATE devices SET last_push_at = ? WHERE id = ?`. Pull:
`SELECT … FROM buckets WHERE seq > ?1 ORDER BY seq LIMIT ?2`. D1 read replication stays off.

### 3.4 Lifecycle

#### 3.4.1 One refresh

1. Resolve the data directory (`SNORLAX_HOME`, else `~/Library/Application Support/snorlax` on macOS,
   `${XDG_DATA_HOME:-~/.local/share}/snorlax` on Linux; mode 0700). Create the ledger and device id on first run.
2. Take the ledger lock: `acquireProcessLock(platform, "<data>/ledger.lock", { wait: true, signal:
   AbortSignal.timeout(60_000) })` from `@rivus/agent-kit-collab/process-lock`. On timeout exit with `locked`.
3. `scanUsage(platform, { since, state })` from `@rivus/agent-kit/transcript/usage`, with `since` =
   `last_scan_completed_at − 2 h` and the saved state; on the first run, `since = 0` and no state. The 2-hour margin
   is larger than the kit's 30-minute quiet window, so late records are inside the scan. Count decode and source
   failures per agent.
4. For each `UsageRecord`, split it into one portion per model with the kit's per-record pricing (K2 in 3.10; until
   Batch 5, the local `splitByModel` described in Batch 2). For
   each portion: bucket key = (floor(timestamp / 3600 s), agent, model or ""); add tokens; add requests
   (1 for a `request` record; for `turn`/`session` records the model's `modelCalls`, else the record's
   `modelCalls`, else 1); add the cost when known, else add the portion's requests to `unpricedRequests`; set
   `dirty = 1`. A new (agent, sessionId) adds 1 to `sessionsStarted` of the hour it was first seen.
5. In one SQLite transaction: write the buckets, `sessions_seen`, the new `scan_state` (`scan.state` after the loop
   ran to its end) and `last_scan_completed_at = now`. A run killed before this commit leaves the ledger as it was.
6. If paired and sync is enabled: push dirty buckets in batches of 200; clear `dirty` for a batch after a 200
   response. Then pull from `pull_cursor` until `next` is null, upsert into `remote_buckets` (skipping this
   device's id), store the cursor, and refresh `remote_devices`. A network or HTTP failure stops the sync, keeps
   `dirty`, and is reported; the scan result stays.
7. Build the snapshot from `buckets` and `remote_buckets` and write it atomically.
8. Release the lock. Print the result.

#### 3.4.2 Pairing

`snorlax pair --url https://snorlax.example.com --name "MacBook Pro"` reads the admin token from stdin, calls
`POST /v1/devices`, stores the returned token in the keychain, saves the URL and name in `config.json`, marks every
local bucket dirty, resets `pull_cursor` to 0, and runs a refresh. The admin token is never written anywhere.

Keychain: macOS uses `/usr/bin/security -i` with the `add-generic-password -U -s snorlax -a <deviceId> -w <token>`
command written to its stdin, so the token never appears in a process argument list; Linux uses
`secret-tool store --label=snorlax service snorlax account <deviceId>` with the token on stdin.
`SNORLAX_DEVICE_TOKEN` overrides both (tests and CI).

#### 3.4.3 Rebuild

`snorlax rebuild --days n`: under the lock and in one transaction, set every local bucket with `hour ≥ start` to
zero and dirty, delete `sessions_seen` rows with `first_hour ≥ start`, and clear `scan_state`; then run steps 3–8
with `since = start` and no state. Zeroed buckets that receive no usage are uploaded as zero, which replaces the
backend rows. `n` is capped at 30 because Claude Code deletes older logs by default.

### 3.5 Concurrency, idempotency, and retries

- One refresh at a time per data directory (the ledger lock). The app's "Refresh now" waits for a scheduled run.
- Steps 3–5 commit atomically, so a killed run neither loses nor double counts (Spec S3).
- Uploads are absolute and replace rows, so retries and duplicate pushes are harmless (S8).
- D1 runs a batch as one transaction in order; each row gets `MAX(seq) + 1`, so sequence numbers only grow and a
  pull with `seq > cursor` never skips a committed row. A replaced row gets a new seq and is pulled again with the
  same values.
- No retry loops inside a run. The next scheduled run retries.

### 3.6 Failures and recovery

| Failure | Behavior |
| --- | --- |
| A source cannot be read or decoded | counted in `failuresByAgent`; other sources continue |
| Backend unreachable, 5xx, timeout (15 s per request) | sync reported failed; dirty buckets stay; next run retries |
| 401 | sync stops; status says the device is unpaired or revoked; `snorlax pair` again |
| D1 daily limit reached | the Worker returns 5xx; same as unreachable until 00:00 UTC |
| Ledger migration fails | the backup stays; exit `data-dir`; `doctor` names the backup path |
| Node missing or too old for the app | app shows the install hint; launchd runs fail fast with `node-version` in the log |
| Snapshot write fails | previous snapshot stays; error in the result |

### 3.7 Compatibility and migration

- Snapshot, CLI outputs and HTTP bodies are versioned. The app refuses a newer `schemaVersion` with "The collector
  is newer than the app; update the app." v1 bundles the collector in the app, so both match by construction.
- Ledger and D1 migrations are forward-only and additive. A new bucket metric is a new column with default 0 in the
  ledger, D1 and protocol; old collectors keep writing rows without it.
- Repricing: new pricing applies to new usage. `pricing_version` in `meta` records the snapshot version used;
  `status` reports `pricingChanged: true` when the bundled version differs from the one that priced the latest
  buckets, and suggests `snorlax rebuild --days 30`.

### 3.8 Security and privacy

- Uploads contain only bucket fields (R10); the protocol schemas are strict, and S15 checks it.
- Device tokens: 32 random bytes, base64url; D1 stores SHA-256 hex; lookup by hash. The admin token is the Worker
  secret `ADMIN_TOKEN`, compared with `crypto.subtle.timingSafeEqual`, and is only sent by `pair` and revocation.
- The data directory is mode 0700; `config.json` holds no secrets.
- Logs and `doctor` output pass through `redactText` from `@rivus/agent-kit/redact` so home paths and secret-shaped
  strings are hidden.
- The main app is not sandboxed (it starts Node and reads the data directory). The widget extension is sandboxed and
  reads only the App Group container.

### 3.9 Logs

`<data>/logs/snorlax.log`, one line per event, rotated at 5 MB with three files kept. Each refresh logs one summary
line (records, failures, pushed, pulled, duration).

### 3.10 agent-kit: what is used and what must be added

Used (pin `@rivus/agent-kit` and `@rivus/agent-kit-collab` to the same version; 0.20.0 when this plan was written):

| Capability | Entry | Used for |
| --- | --- | --- |
| `scanUsage`, `isUsageRecord`, `UsageRecord`, `UsageScanState` | `@rivus/agent-kit/transcript/usage` | incremental decoding of six agents, de-duplication, scan state |
| `createPricing` | `@rivus/agent-kit/cost` | pricing table with overrides and family fallbacks |
| `createNodePlatform` (with `sqlite`) | `@rivus/agent-kit/node` | file access for the kit, and the ledger database |
| `builtinProviders`, `Provider` | `@rivus/agent-kit/providers` | the agent list for `status`; custom providers later |
| `detectAgents` | `@rivus/agent-kit/discovery` | detected agents in `status`, stat-only: `versionProbe: false` and empty `auth` probes so no credential file is read |
| `redactText` | `@rivus/agent-kit/redact` | logs and diagnostics |
| `acquireProcessLock` | `@rivus/agent-kit-collab/process-lock` | the ledger lock |
| `createMemoryPlatform` | `@rivus/agent-kit/testing` | tests with generated agent logs |

Additions to agent-kit:

| ID | Addition | Needed by | Notes |
| --- | --- | --- | --- |
| K1 | A pricing snapshot shipped by the kit: an entry such as `@rivus/agent-kit/cost/prices` that exports a generated LiteLLM table (with 1-hour cache-write rates and family fallbacks) ready for `createPricing`, plus the weekly update workflow, and a version string | Batch 5 (M2) | Issue not opened yet. agent-presence maintains the same snapshot today; with snorlax there are two users, so it moves into the kit and presence switches to it |
| K2 | Export per-record pricing from `@rivus/agent-kit/cost`: the existing internal `portionsOf(record, pricing)` (or `costOf`), which splits a record by model and prices each part with the same rules as `summarize` | Batch 5 (M2) | `summarize` groups only by agent and model over a window; buckets also need the hour. Tracked in [agent-kit#190](https://github.com/PerfectPan/agent-kit/issues/190) |
| K3 | Session activity for presence: per provider, derive working / idle / ended from the tail of a session log, and list the directories to watch | presence plan (8.3) | not part of this plan |

Not added: Cursor (usage is in its cloud account); agents the kit does not decode can be supplied later through the
kit's `providers` option from a separate package, with no change to snorlax's data model. Model-name normalization
across agents is not added unless Batch 2 fixtures or the owner's data show the same model under different
spellings.

### 3.11 macOS app

- Targets (XcodeGen `apps/macos/project.yml`; the generated `.xcodeproj` is not committed): `Snorlax` (app,
  macOS 14+, `LSUIElement`), `SnorlaxWidget` (WidgetKit extension), local Swift package `SnorlaxKit` (generated
  types, snapshot loading, formatting, view models). Bundle id `io.github.perfectpan.snorlax`; App Group
  `$(TeamIdentifierPrefix)io.github.perfectpan.snorlax`.
- Bundle contents: `Contents/Resources/collector/snorlax.mjs` (the collector built as one ESM file with every
  dependency inlined), `Contents/Helpers/snorlax` (a `/bin/sh` launcher), and
  `Contents/Library/LaunchAgents/io.github.perfectpan.snorlax.refresh.plist`.
- Launcher: reads the Node path from `<data>/node-path`; if missing, uses `node` from
  `/opt/homebrew/bin:/usr/local/bin:/usr/bin`; then `exec "$NODE" "<bundle>/Contents/Resources/collector/snorlax.mjs" "$@"`.
- Node discovery: on launch, when `node-path` is missing or its Node fails `--version` ≥ 22.13, run
  `/bin/zsh -lc 'command -v node'` (5 s timeout), check the version and write `node-path`. When none is found,
  the menu shows "Install Node.js 22.13 or later".
- Scheduling: `SMAppService.agent(plistName:)` registers the plist (`BundleProgram` = `Contents/Helpers/snorlax`,
  `ProgramArguments` = `snorlax refresh`, `StartInterval` 300, `RunAtLoad`). Settings shows its status and a
  toggle. If Batch 0 S1 shows registration fails with the owner's signing, the app calls `snorlax install`
  instead, which writes `~/Library/LaunchAgents/io.github.perfectpan.snorlax.refresh.plist` with absolute paths.
- `CollectorClient`: runs the launcher with `Process`, arguments plus `--json`, optional stdin (the admin token for
  `pair`), 120 s timeout; decodes stdout into the generated type, or into the failure shape when the exit code is not
  0.
- Snapshot updates: a `DispatchSource` file-system object source on the data directory (rename replaces the file,
  so the directory is watched), debounced 200 ms, plus a 60 s timer as a fallback. On a new snapshot the app writes a
  copy to the App Group container and calls `WidgetCenter.shared.reloadAllTimelines()`.
- Menu bar: title is today's tokens in short form (`812M`). The popover shows today / 7 days / 30 days (tokens and
  cost), top agents, top models, devices, a 30-day bar chart (Swift Charts), status line, and buttons Refresh now,
  Settings, Quit.
- Settings: device name; backend URL and admin token with Pair and Unpair; launch at login; Diagnostics (runs
  `doctor`).
- Widget: small (today's tokens and cost) and medium (today, 7 days, top three agents); one timeline entry with
  policy `.after(now + 15 min)`. If Batch 0 S1 shows the App Group is unusable with the owner's signing, the widget
  instead reads `<data>/snapshot.json` through the
  `com.apple.security.temporary-exception.files.home-relative-path.read-only` entitlement.
- Artwork is original; no official Pokémon artwork.

### 3.12 Worker

- `packages/worker`: a plain `fetch` handler with `URLPattern` routes, no framework. The handler takes
  `{ db, adminToken }` where `db` is the subset of `D1Database` it uses (`prepare`, `bind`, `first`, `all`, `run`,
  `batch`).
- Tests run the handler against an adapter that implements that subset over `node:sqlite` (a `batch` is one
  `BEGIN … COMMIT`). A manual `wrangler dev` smoke test is in the validation ledger.
- Request bodies over 1 MB are rejected with 413. A push validates every row with the protocol schema before any
  write.

## 4. Rollout and stability

### 4.1 Gates and rollout stages

1. Batch 0 results recorded in section 7 (signing path, scan numbers).
2. M1 (Batches 1–4): the owner uses the app on one Mac for three days; token totals match
   `agent-presence usage --json` for the same windows, or each difference is explained.
3. M2 (Batch 5): cost totals match `agent-presence usage --json`.
4. M3 (Batches 6–8): the owner deploys the Worker, pairs two Macs and one Linux machine, and runs 5.4.

### 4.2 Signals

`snorlax status` and the menu bar status line: last scan, last sync, failures per agent. The owner checks D1 usage
in the Cloudflare dashboard during the first week of P2 against 8.2.

### 4.3 Rollback

Collector and app: install the previous build; ledger backups allow returning to an older schema. Worker: redeploy
the previous version; D1 migrations are additive, so older Workers keep working. The backend can be emptied and
refilled by `snorlax rebuild --days 30` plus a re-pair on each device.

## 5. Verification

### 5.1 Functional checks

Fixture logs for each of the six agents, generated under a temporary `HOME` by test helpers (never copied from a
real machine), with known per-model totals. Tests cover Spec S1, S2, S4, S5, S10, S11, S12, S15.

### 5.2 Failure and retry checks

Killed run (S3) by throwing between decode and commit; offline backend (S7) with the in-memory `SyncBackend`
switched to failing; token rules (S9) against the Worker handler.

### 5.3 Compatibility checks

Generated Swift types decode the protocol fixtures; a ledger created by the previous schema version migrates (from
Batch 2 on); the Worker accepts pushes from the previous protocol version.

### 5.4 End-to-end acceptance (owner)

Two Macs and one Linux machine paired to the deployed Worker: each device's totals appear on both Macs within
10 minutes; take one Mac offline for an hour of agent use, reconnect, and confirm the totals converge; run
`snorlax rebuild --days 3` on one device and confirm other devices show the same totals as before.

## 6. Execution plan

The plan ships in three milestones. Finish Milestone 1 before starting Milestone 2 or 3.

| Milestone | Result | Batches |
| --- | --- | --- |
| M1 Local | On one Mac, the menu bar app and the desktop widget show this machine's tokens, requests and sessions for today, the last 7 and the last 30 days, refreshed every 5 minutes. Cost shows the amounts agents logged themselves; other requests are marked unpriced. | 0–4 |
| M2 Pricing | Every request whose model is in the pricing table is priced. | 5 |
| M3 Cross-device | Several Macs and Linux machines show the same totals through the owner's Worker. | 6–8 |

### 6.1 Preconditions

- Read `AGENTS.md`, including its Project Rules: never read real agent session files, zod at boundaries, no
  hand-written shape guards, injected clocks in tests, temporary `HOME` cleanup, owner-only steps.
- Toolchains: Node 24 and pnpm from the repository pins; Xcode with the macOS 14 SDK or later and XcodeGen for
  Batches 0 and 4. The lockfile must resolve from `https://registry.npmjs.org/` only; on a machine whose default
  registry is a mirror, pass `--registry https://registry.npmjs.org/` to pnpm commands that resolve versions.
- M1 needs no Cloudflare account, no second machine and no agent-kit change.
- M2 needs an agent-kit release that contains K1 and K2 (3.10; K2 is
  [agent-kit#190](https://github.com/PerfectPan/agent-kit/issues/190)).
- M3 needs the owner's Cloudflare account, a domain whose DNS is on Cloudflare (`*.workers.dev` often does not
  resolve from mainland China), and a second Mac.

### 6.2 Working agreement

- One PR per batch; Batch 0 is one PR per spike. Titles, descriptions and checks follow `AGENTS.md`. The owner
  reviews and merges.
- Every batch PR updates 6.8 Progress: status, decisions taken within this plan's limits, open problems. 6.8 is the
  handoff to the next session or agent; there is no separate handoff file.
- Steps marked "owner" are prepared in the PR (exact commands) and run by the owner.
- When a batch needs a decision this plan does not make, stop that batch, add the question to section 7, and
  continue with a batch that does not depend on it.

### 6.3 Completion contract

| Spec | Proven by | Milestone |
| --- | --- | --- |
| R1, S14 (install, refresh, uninstall) | Batch 3 `install-uninstall.test.ts` tree-hash test | M1 |
| R2, S2 | Batch 2 `refresh.test.ts` (decoder read counts) | M1 |
| R3, S3, S4 | Batch 2 `refresh.test.ts` | M1 |
| R4, S5 | Batch 2 `refresh.test.ts` | M1 |
| R5, R8, S10 | Batch 2 `snapshot.test.ts` | M1 |
| R12, S13 | Batch 4 `SnorlaxKitTests` (snapshot copy and reload call) and the owner's M1 check | M1 |
| R13 | Batch 1 `status-doctor.test.ts` (backend checks added in Batch 7) | M1 |
| S12 | Batch 2 `buckets.test.ts` (agent-logged cost) | M1 |
| R9, S11 | Batch 5 `buckets.test.ts` (table prices, unpriced models) | M2 |
| R10, S15 | Batch 6 `protocol.test.ts` (strict HTTP schemas) and Batch 7 `sync.test.ts` | M3 |
| R11, S9 | Batch 6 Worker `devices.test.ts` | M3 |
| R6, S6 | Batch 7 `sync.test.ts` and 5.4 | M3 |
| R7, S7, S8 | Batch 7 `sync.test.ts` | M3 |
| S14 (with `pair`) | Batch 7 extends `install-uninstall.test.ts` | M3 |

### 6.4 Execution order

Each batch leaves `pnpm run check` green.

#### Batch 0 (M1): verification spikes

- **S1 Swift shell and signing, on this Mac.** Minimal `apps/macos` (XcodeGen) with a `MenuBarExtra` that shows a
  value from a JSON file in the App Group container, a widget that shows the same value, and an `SMAppService` agent
  that runs the bundled launcher with Node (a one-line `node -e` script that writes a file stands in for the
  collector). Build with a free Personal Team. Record in section 7: whether the App Group works, whether
  `SMAppService` registration works, whether the widget appears in the gallery. Exit: the record is merged; the
  spike code becomes the start of Batch 4 or is deleted.
- **S2 Scan cost.** `scripts/measure-scan.ts` runs `scanUsage` over the current user's agent homes, full and then
  incremental, and prints only numbers (records, sources, duration, peak RSS, state JSON size). The implementer
  tests it against generated fixtures only; the owner runs it on real machines (owner). Exit: numbers recorded in
  section 7; refresh interval confirmed (default 300 s).

#### Batch 1 (M1): protocol and collector skeleton

- Files: `packages/protocol/**`, `packages/collector/**` (`src/cli/`, `src/config/`, `src/data-dir/`, `src/log/`),
  `pnpm-workspace.yaml` (catalog: `@rivus/agent-kit`, `@rivus/agent-kit-collab`, `zod`, `date-fns`,
  `@date-fns/tz`, `quicktype`), `.changeset/`.
- Change: zod definitions of the bucket, ledger-independent snapshot and CLI outputs (3.2.1–3.2.3, 3.3.1); JSON
  Schema export and protocol fixtures; collector CLI with `parseArgs` and the calling convention (3.2.1); data
  directory, `config.json`, logging with rotation; `status`, `doctor` (local checks only) and `snapshot`; one bundled
  ESM file `dist/snorlax.mjs` with the `snorlax` bin; `engines.node >= 22.13`. `@rivus/snorlax` is already in the
  `versioning.fixed` group.
- Tests: `protocol.test.ts`, `cli.test.ts` (exit codes, one JSON object on stdout), `status-doctor.test.ts`.
- Exit: `pnpm run check` passes; `node packages/collector/dist/snorlax.mjs status --json` prints a valid `Status`.

#### Batch 2 (M1): ledger, scanning, buckets, snapshot, refresh

- Files: `packages/collector/src/{ledger,scan,buckets,snapshot,refresh,rebuild}/**`, generated-fixture helpers
  under `packages/collector/test/fixtures/`.
- Change: the ledger (3.3.2) with migrations and backups; 3.4.1 steps 1–5, 7 and 8; `rebuild` (3.4.3). Until
  Batch 5, records are split by model with a local `splitByModel` that follows the kit's rule (split by
  `usageByModel`, except when the agent logged a record amount that the split does not divide among every model);
  a portion's cost is the agent-logged amount when present, otherwise its requests count as unpriced;
  `pricing_version` stays null.
- Tests: `refresh.test.ts` (S1–S5), `buckets.test.ts` (S12, splitting, unpriced counts), `snapshot.test.ts` (S10,
  windows, daily and hourly series), `rebuild.test.ts`, `ledger-migration.test.ts`. Time comes from the injected
  platform clock.
- Exit: all pass; a refresh over the generated month-of-history fixture completes, with its duration in the PR.

#### Batch 3 (M1): scheduling without the app, uninstall

- Files: `packages/collector/src/schedule/**`.
- Change: `install`/`uninstall` for macOS: `~/Library/LaunchAgents/io.github.perfectpan.snorlax.refresh.plist`
  with absolute Node and CLI paths, `StartInterval` 300, loaded with `launchctl bootstrap gui/<uid>`;
  `uninstall --data` also deletes the data directory. This is the fallback when `SMAppService` is unusable and the
  way to run the collector without the app.
- Tests: `install-uninstall.test.ts` with a stubbed `launchctl` and a temporary `HOME`, including S14 for install,
  refresh and uninstall.
- Exit: tests pass; the generated plist is shown in the PR.

#### Batch 4 (M1): macOS app and widget

- Files: `apps/macos/**`, the Swift generation script in `packages/protocol`, CI job `macos` on `macos-latest`.
- Change: 3.11 without pairing (Settings has device name, launch at login and Diagnostics), using the S1 results;
  an Xcode build phase that runs `pnpm --filter @rivus/snorlax run build` and copies `dist/snorlax.mjs` into the
  bundle.
- Tests: `SnorlaxKitTests` (decode protocol fixtures, formatting, day windows, App Group copy and reload call
  through a protocol seam); CI regeneration check.
- Exit: `xcodebuild test` passes in CI. M1 acceptance (owner): the app runs on the owner's Mac for three days;
  token totals match `agent-presence usage --json` for the same windows, or each difference is explained in 6.8.

#### Batch 5 (M2): pricing

- Precondition: agent-kit with K1 and K2 released; the catalog pins it.
- Change: replace `splitByModel` with the kit's `portionsOf`; load the kit's pricing table (K1) and record
  `pricing_version`; `status` reports `pricingChanged` and suggests `snorlax rebuild --days 30` (3.7).
- Tests: `buckets.test.ts` (S11 with a table, S12 unchanged, multiplier and 1-hour cache writes through the kit).
- Exit: tests pass; M2 acceptance (owner): cost totals match `agent-presence usage --json` for the same windows.

#### Batch 6 (M3): Worker

- Files: `packages/worker/**` (`wrangler.jsonc`, `migrations/0001_init.sql`, `src/**`), HTTP schemas in
  `packages/protocol`.
- Change: 3.2.4 including `GET /v1/health`, 3.3.3, the token rules in 3.8, 3.12.
- Tests: `devices.test.ts` (S9, revoke), `buckets.test.ts` (upsert, seq order, pagination, 200-row limit, strict
  body, 413), `protocol.test.ts` (S15 schemas).
- Exit: tests pass; `wrangler dev` smoke steps in the PR. Owner: deploy to `snorlax.<domain>` and record in section
  7 that `GET /v1/health` answers from every network the devices use.

#### Batch 7 (M3): sync in the collector

- Files: `packages/collector/src/{sync,keychain,pair}/**`.
- Change: 3.4.1 step 6, 3.4.2, `unpair`, backend checks in `doctor`, `byDevice` in the snapshot.
- Tests: `sync.test.ts` (S6–S8, S15, failure codes; two collectors against the Worker handler on in-memory
  `node:sqlite`), `install-uninstall.test.ts` extended with `pair` (S14), `keychain.test.ts` with stubbed
  `security` and `secret-tool` that checks the token is passed on stdin only, `pair.test.ts`.
- Exit: tests pass; two local collectors against `wrangler dev` converge (steps in the PR).

#### Batch 8 (M3): pairing in the app, Linux, release setup

- Files: `apps/macos/**` (Settings: backend URL, admin token, Pair, Unpair), `packages/collector/src/schedule/**`
  (systemd user timer `snorlax-refresh.service` and `.timer`, `OnBootSec=1min`, `OnUnitActiveSec=5min`),
  `docs/development/` (Linux install, pairing, Worker deployment), `docs/development/release.md` (Trusted
  Publishing for `@rivus/snorlax`).
- Tests: the systemd part of `install-uninstall.test.ts` with a stubbed `systemctl`.
- Exit: owner installs the app on a second Mac (the S1 signing result applies), sets up one Linux machine, and
  completes 5.4.

### 6.5 Validation ledger

| Batch | Command or evidence | Expected result |
| --- | --- | --- |
| all TS batches | `pnpm run check` | pass |
| 1 | `node packages/collector/dist/snorlax.mjs status --json` | valid `Status`, exit 0 |
| 2, 5, 7 | `pnpm --filter @rivus/snorlax run test` | the batch's scenarios pass |
| 4, 8 | `xcodebuild -scheme Snorlax test` (CI `macos`) | pass; regeneration leaves no diff |
| 6 | `pnpm --filter @rivus/snorlax-worker run test`; `wrangler dev` smoke | pass |
| M1 | owner, three days on one Mac | token totals match `agent-presence usage --json` or differences explained |
| M2 | owner | cost totals match `agent-presence usage --json` |
| M3 | owner, 5.4 | converged totals on all devices |

### 6.6 Rollback per batch

Every batch reverts with its PR. Batch 2 introduces the ledger: a later revert leaves `ledger.db` in place and a
re-applied build migrates it again. Batch 6 adds D1 tables that later Workers keep using.

### 6.7 Work split

| Work | Who |
| --- | --- |
| Batches 0–8 code, tests, docs, PRs | implementing agent |
| S2 run on real logs, M1/M2/M3 acceptance, deploys, signing, npm Trusted Publishing, branch protection, merges | owner |
| K1, K2 in agent-kit | agent-kit maintainer |

### 6.8 Progress

| Batch | Status | PR | Decisions taken | Open problems |
| --- | --- | --- | --- | --- |
| 0 S1 | in review | | Automatic signing with an empty team in `project.yml`; the local `xcodebuild` disables signing. `register()` is only the menu action and was not called. The launcher `node -e` writes `spike-run.json` and does not search `PATH`. SnorlaxKit reads `spike-value.json` from the expanded App Group id. | App Group, `SMAppService`, and the widget gallery need the owner's Personal Team. See section 7. |
| 0 S2 | in review | | Incremental scan uses `since` = clock now − 2 h (3.4.1); full scan uses `since` 0 and no state. `RootMissing` counts as a source failure; every other scan failure counts as a decode failure, because the scan stream does not label a listing `ReadFailed` apart from a decode `ReadFailed`. | Owner paste of `node scripts/measure-scan.ts` is not in section 7 yet, so the refresh interval stays 300 s. |
| 1 | in review | | `invalid-arguments` added as the failure code for exit 2 (the plan lists codes only for runtime failures); later-batch commands (`refresh`, `rebuild`, `pair`, `unpair`, `install`, `uninstall`) are registered as `internal` stubs instead of omitted; `doctor` checks `config.json` in addition to node-version and data-dir (all local, keychain/backend/scheduling wait); status device id and scan/sync fields come from `snapshot.json` until the ledger exists (Batch 2 replaces the source, not the output); protocol `PairResult`/`Doctor` field sets are provisional pending Batches 4/7 review; `minimumReleaseAgeExclude` in pnpm-workspace.yaml for the owner's agent-kit 0.20.0 (published the same day the catalog pinned it) | Bucket and output schemas drop unknown keys on parse (forward compatibility, plan 3.7); the strict unknown-key rejection required for HTTP bodies (3.2.3) lands with Batch 6's schemas; agent-kit 0.20.0 pinned via catalog — remember to drop the exclude entry after it ages past `minimumReleaseAge` |
| 2 | not started | | | |
| 3 | not started | | | |
| 4 | not started | | | |
| 5 | waiting for agent-kit K1, K2 | | | |
| 6 | not started | | | |
| 7 | not started | | | |
| 8 | not started | | | |

## 7. Risks, open questions, and follow-up

| Item | Type | Impact | Owner | Next step |
| --- | --- | --- | --- | --- |
| App Group or `SMAppService` unusable with free signing | risk | widget or scheduling fails | owner | Batch 0 S1; fallbacks in 3.11; a Developer ID if both fail |
| Agents change their log formats | risk | usage under-counted | maintainer | decoders live in agent-kit; `failuresByAgent` surfaces it |
| D1 free limits exceeded | risk | writes fail until 00:00 UTC | owner | 8.2 estimate; dirty buckets wait for the next day |
| Node path changes (version managers) | risk | collection stops | maintainer | app rediscovers Node; `doctor`; Node SEA later |
| Logs older than 30 days are gone | constraint | `rebuild` beyond 30 days would lose usage | — | `rebuild` capped at 30 |
| Snorlax is a trademark | risk | rename request | owner | original artwork, disclaimer in README |
| S1 results | pending owner run | signing path | owner | Local `xcodegen generate` and signing-disabled `xcodebuild` succeed on Xcode 27. The bundle contains the helper, the LaunchAgents plist, and the widget. The helper writes `spike-run.json` under a temporary HOME when `node-path` names an executable. The binary is linker-signed only (no team, no entitlements); the App Group id expanded with an empty prefix. Not run: App Group container, `SMAppService` registration, widget gallery. Owner steps are in `apps/macos/README.md`. The second-Mac install is checked in Batch 8. |
| S2 results | pending owner run | refresh interval and performance target | owner | On each machine, run `node scripts/measure-scan.ts`. It reads local agent homes (full: `since` 0 and no state; incremental: the saved state and `since` = now − 2 h) and prints one JSON object of counts only. Paste that JSON here. The refresh interval stays 300 s until the numbers are recorded. |
| Worker reachability | open | domain | owner | record here after Batch 6 |
| K1, K2 in agent-kit | follow-up | M2 blocked | agent-kit maintainer | K2: agent-kit#190; K1: issue not opened yet |
| Presence on this collector | follow-up | — | owner | separate Spec and Plan (8.3) |

## 8. Appendix

### 8.1 Lessons from other usage trackers

- A periodic job that reads local logs, plus a separate menu bar process, works and needs no hooks. Keep it.
- Keying machines by host name produced duplicates that needed a dedicated repair command. Use generated ids.
- Full-scan caches that store per-file parse results grew to several gigabytes and runs took over 30 seconds. Keep
  only cursors and request hashes (the kit's scan state).
- Unrotated logs grew without bound. Rotate.
- Showing the last good snapshot when the backend is unreachable is worth copying.
- Reading subscription quota required installing a status-line command into an agent's settings. That is invasive;
  it is out of scope here.
- A web-view popover cannot provide macOS desktop widgets.

### 8.2 Cloudflare Free plan estimate

Three devices, a refresh every 5 minutes, at most 10 changed buckets per refresh (high estimate):

| Quota | Estimate per day | Free limit | Share |
| --- | --- | --- | --- |
| D1 rows written (row + seq index) | 3 × 288 × 10 × 2 ≈ 17,000 | 100,000 | 17% |
| D1 rows read, cursor pulls (chosen) | upserts ≈ 17,000 + pulls ≈ 17,000 ≈ 35,000 | 5,000,000 | 0.7% |
| D1 rows read, server-side 7-day sums (rejected) | ≈ 2,500 rows × ≈ 1,000 refreshes ≈ 2,500,000 | 5,000,000 | 50% |
| Worker requests | 3 × 288 × 2 ≈ 1,700 | 100,000 | 1.7% |
| D1 storage after one year | ≈ 18,000 rows × 3 devices × 200 B ≈ 11 MB | 5 GB | 0.2% |

Each Worker request has 10 ms of CPU on the Free plan; the 200-row push limit keeps parsing and validation inside it.

### 8.3 Presence later

agent-presence counts working agents from hooks. On this collector it can instead read the tail of each session
log: the last record being a user prompt or a tool call without a result means working; an end-of-turn record
(`end_turn`, `task_complete`) means idle; a dead process or no write for 3 minutes ends the session. That needs a
resident `snorlax watch` (launchd `KeepAlive`, file-system events on the session directories), kit K3, and a
`presence` table in D1 (one row per device and agent with `expires_at`, refreshed every 60 s while active, at most
about 1,440 writes per device per day). Hooks, the hook shim and the installed runtime would then be removed from
presence; agents that write no local log are not covered. This needs its own Spec and Plan.
