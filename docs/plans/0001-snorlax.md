# Plan 0001: snorlax

- Status: accepted (owner decisions recorded 2026-10-22 to 2026-10-26). Milestones 1 and 2 are merged and
  accepted. Milestone 3 starts with Batch 6 on Cloudflare's `cf` CLI (D13); Batch 6b reworks that Worker on Hono
  in layers (D14, 3.12.1) on the same PR before it merges. Milestone 3 needs the owner's Cloudflare account (6.1)
- Owner: PerfectPan
- Reviewer: unconfirmed
- Last updated: 2026-10-26
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
| D12 | The collector CLI is built on `effect/cli` (Effect 4); flows are written in Effect and external capabilities are Effect services; pure rules stay plain TypeScript (3.13) | An own `node:util` `parseArgs` dispatcher; citty | Layers build a service only when a command uses it, so read-only commands such as `doctor` cause no side effects; the typed error channel ties every failure to a `FailureCode`; test layers and `TestClock` cover the injected-clock rule; agent-kit already ships Effect 4 entries (`PlatformService`, `NodePlatformLive`). `effect/cli` is marked unstable, so `effect` is pinned to the exact version agent-kit's peer names and both are upgraded together. Owner decision. |
| D13 | The Worker is configured, run locally and deployed with Cloudflare's `cf` CLI (`cloudflare.config.ts`), with Wrangler as the bundler `cf` delegates to (3.12) | Wrangler alone with `wrangler.jsonc`; `cf` with Vite and the Cloudflare Vite plugin 2.0 beta | Owner decision to use `cf`, which takes over from Wrangler as Cloudflare's CLI. In this workspace `vite` is the vite-plus core alias, which has no `vite` executable, so on the Vite route `cf build` ran `npx vite build` with a Vite fetched outside the lockfile (checked 2026-10-26); builds would have to go through `vp build` plus `cf deploy --prebuilt`, the plugin's `vite` peer is met only through `allowAny`, and the plugin starts the Workers runtime under `vp test`. With Wrangler declared in the package, `cf dev`, `cf build` and `cf deploy` work as documented, and the Worker's `vite.config.ts` stays the lint, format and test config every package has. |
| D14 | The Worker's HTTP entry is a Hono app, and the code splits into that entry, use cases per domain (`devices`, `buckets`) and each domain's SQL store (3.12.1) | One plain `fetch` handler with `URLPattern` routes (Batch 6's first version); folders named `controllers/`, `models/` and `views/`; DDD aggregates, repositories and domain events | The first version hand-wrote what Hono ships (routing, a streaming body limit, bearer parsing, a constant-time compare, one error funnel) and mixed HTTP parsing, rules and SQL in one 340-line file whose rules raised HTTP error codes. In MVC terms the Hono routes are the controllers, the use cases with their stores are the model, and the protocol's HTTP shapes are the view; folders are named by domain so one change stays in one folder, and the view stays in `packages/protocol`, shared with the collector. DDD's aggregate cycle (load, change, save) is a read-then-write, the race Batch 6's registration fix removed: the invariants here hold because each is one atomic statement or batch, and a repository interface would have one implementation behind the D1 subset, which already abstracts the database. Owner decision. |

## 3. Detailed design

### 3.1 Entry points

| Command | Caller | Does | `--json` output |
| --- | --- | --- | --- |
| `snorlax refresh` | launchd / systemd timer, app | waits up to 60 s for the ledger lock, scans, syncs when paired, writes the snapshot | `RefreshResult` |
| `snorlax status` | app settings, terminal | version, data directory, device, last scan and sync, decode failures per agent, detected agents | `Status` |
| `snorlax pair --url <url> --name <name>` | app settings, terminal | reads the admin token from stdin, registers the device, stores the device token in the keychain | `PairResult` |
| `snorlax unpair` | app settings, terminal | deletes the device token; local data stays | `Ok` |
| `snorlax rebuild --days <n>` | owner, after a pricing change or for repair | 1 ≤ n ≤ 30: zeroes the last n days of local buckets, rescans them and marks them for upload | `RefreshResult` |
| `snorlax doctor` | app diagnostics, terminal | checks Node version, data directory permissions, keychain access, backend reachability, scheduling (the loaded refresh job and the Node its plist names) | `Doctor` |
| `snorlax install` / `uninstall` | Linux; macOS without the app | writes or removes the systemd user timer or `~/Library/LaunchAgents` plist; `uninstall --data` also deletes the keychain item and the entries snorlax wrote in the data directory; when that directory is non-empty and holds no snorlax ledger the CLI can read, the whole command refuses (exit 1, `data-dir`), deleting nothing and leaving the LaunchAgent in place, while a data directory that does not exist or is empty completes as usual | install: `Ok`; uninstall: `UninstallResult`, whose `keptEntries` is present only with `--data` |
| `snorlax snapshot` | terminal | prints the current snapshot | `SnapshotOutput`: `{ schemaVersion, ok, snapshot }` |

Commands are defined with `effect/cli` (D12, 3.13); Batches 1–3 shipped on `node:util` `parseArgs` and Batch 4b
moves them. There is no interactive prompt in any command.

### 3.2 Interfaces

#### 3.2.1 CLI calling convention

- With `--json`, stdout carries exactly one JSON object with `schemaVersion: 1` and `ok`. Human-readable output and
  diagnostics go to stderr and the log file.
- Exit code 0: success (a refresh whose sync failed still exits 0 and reports `sync.ok: false`). Exit 1: failure,
  stdout is `{"schemaVersion":1,"ok":false,"error":{"code":"…","message":"…"}}`. Exit 2: invalid arguments.
- Error codes: `locked` (lock not acquired in 60 s), `node-version`, `data-dir`, `keychain`, `network`,
  `unauthorized`, `forbidden`, `invalid-response`, `pricing`, `internal`.
- Every command can be repeated safely. `refresh` and `rebuild` hold the same lock.
- A reader that closes stdout early is not a failure: the EPIPE prints nothing and the exit code stays the
  command's own.
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
2. Its build exports JSON Schema files with `z.toJSONSchema` to `packages/protocol/schema/*.json` (committed) for the
   shapes the app decodes: the snapshot and the CLI outputs. The HTTP bodies are not exported, because the app has no
   HTTP client (2.1) and the collector and the Worker use the zod schemas directly.
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

`meta.pricing_version` is the version of the pricing table that priced the stored buckets (`litellmPricesVersion`
from `@rivus/agent-kit/cost/prices`, 3.7): a ledger's first scan writes it, a refresh keeps it, and only a
`rebuild --days 30` writes the current one again. A ledger scanned before Batch 5 keeps NULL until that rebuild.

Schema version is `PRAGMA user_version`. Migrations are forward-only; before migrating, the collector copies
`ledger.db` to `ledger.db.bak-v<old>` and keeps the latest two backups. The ledger stays in SQLite's rollback
journal, not WAL: a read-only connection to a WAL database creates `-wal` and `-shm` files, which `status` must not
(3.13 rule 8), and the backup copies one file.

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
2. Take the ledger lock: `acquireProcessLock(platform, "<data>/ledger.lock", { wait: true, signal })` from
   `@rivus/agent-kit-collab/process-lock`, held in the run's scope. The 60-second wait is timed on Effect's clock,
   and `signal` is the run's interruption, so an interrupted run stops waiting. On timeout exit with `locked`.
3. `scanUsage(platform, { since, state })` from `@rivus/agent-kit/transcript/usage`, with `since` =
   `last_scan_completed_at − 2 h` and the saved state; on the first run, `since = 0` and no state. The 2-hour margin
   is larger than the kit's 30-minute quiet window, so late records are inside the scan. Count decode and source
   failures per agent. Claude Code's `<synthetic>` assistant entries (API errors the CLI wrote itself, an all-zero
   usage) yield no record and reach no bucket.
4. For each `UsageRecord`, price it with `priceRecord(record, pricing)` from `@rivus/agent-kit/cost` (K2 in 3.10),
   where `pricing` is `createPricing(litellmPrices)` (K1): one part per model of its split, else the whole record.
   A request whose total input — cache reads and writes included — strictly exceeds the model's long-context
   threshold bills whole at that tier's rates. The kit treats a part as one request only when the record's
   granularity is `request` or the record's or that part's `modelCalls` is 1; any other part of a `turn`/`session`
   record, `modelCalls` absent included, keeps the base price.
   For each part: bucket key = (floor(timestamp / 3600 s), agent, model or ""); add tokens; add requests (1 for a
   `request` record; for `turn`/`session` records the rule recorded in 6.8 Batch 2, because the kit gives a part
   only its own share's `modelCalls`); add the part's cost when it has one, else add its requests to
   `unpricedRequests`; set `dirty = 1`. A new (agent, sessionId) adds 1 to `sessionsStarted` of the hour it was
   first seen.
5. In one SQLite transaction: write the buckets, `sessions_seen`, `pricing_version` when the run records it (the
   ledger's first scan or `rebuild --days 30`, 3.7), the new `scan_state` (`scan.state` after the loop ran to its
   end) and `last_scan_completed_at = now`. A run killed before this commit leaves the ledger as it was.
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
- `status` reads the ledger without the lock, so it can meet a refresh's commit. Both ledger connections set
  `busy_timeout` to 5000 ms, and the side that finds the database locked waits instead of failing. `node:sqlite` is
  synchronous, so that wait blocks the event loop and a SIGINT/SIGTERM is handled once the statement returns.
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
| The Node a CLI-installed LaunchAgent names is gone (upgraded or removed) | the timer stops; `doctor`'s `schedule` check is an error; `snorlax install` again writes the current Node |
| Snapshot write fails | previous snapshot stays; error in the result |

### 3.7 Compatibility and migration

- Snapshot, CLI outputs and HTTP bodies are versioned. The app refuses a newer `schemaVersion` with "The collector
  is newer than the app; update the app." v1 bundles the collector in the app, so both match by construction.
- Ledger and D1 migrations are forward-only and additive. A new bucket metric is a new column with default 0 in the
  ledger, D1 and protocol; old collectors keep writing rows without it.
- Repricing: new pricing applies to new usage. `pricing_version` in `meta` records the version of the table that
  priced the stored buckets: a ledger's first scan (no `last_scan_completed_at` yet) writes the bundled version, a
  refresh prices new usage with the bundled table but keeps the recorded version, and a `rebuild --days 30`
  reprices the whole snapshot window and records the bundled version (a shorter rebuild leaves older days at their
  old prices and keeps it). A ledger scanned before Batch 5 has no version and keeps none until that rebuild,
  because its older buckets were priced by no table. `status` reports `pricingChanged: true` when a scanned
  ledger's version is not the bundled one, a missing version included, and suggests `snorlax rebuild --days 30`.
  The version digests the table's content, so any kit upgrade whose snapshot changed moves it — a scanned ledger
  then reads `pricingChanged` until the rebuild, and the rebuild's rescan no longer yields records for the
  `<synthetic>` entries an older kit counted (3.4.1 step 3).

### 3.8 Security and privacy

- Uploads contain only bucket fields (R10); the protocol schemas are strict, and S15 checks it.
- Device tokens: 32 random bytes, base64url; D1 stores SHA-256 hex; lookup by hash. The admin token is the Worker
  secret `ADMIN_TOKEN`, compared by Hono's `bearerAuth` with its `timingSafeEqual` (both sides hashed with SHA-256,
  then compared in constant time; 3.12.1), which runs on Node too — `crypto.subtle.timingSafeEqual` exists only in
  workerd. The admin token is only sent by `pair` and revocation. The owner uploads it with
  `cf deploy --secrets-file` (3.12), never as a command-line argument.
- The data directory is mode 0700; `config.json` holds no secrets.
- Logs and `doctor` output pass through `redactText` from `@rivus/agent-kit/redact` so home paths and secret-shaped
  strings are hidden.
- The main app is not sandboxed (it starts Node and reads the data directory). The widget extension is sandboxed and
  reads only the App Group container.

### 3.9 Logs

`<data>/logs/snorlax.log`, one line per event, rotated at 5 MB with three files kept. Each refresh logs one summary
line (records, failures, pushed, pulled, duration).

### 3.10 agent-kit: what is used and what must be added

Used (pin `@rivus/agent-kit` and `@rivus/agent-kit-collab` to the same version; 0.20.0 when this plan was written,
0.22.0 from Batch 5, 0.23.0 from the kit upgrade):

| Capability | Entry | Used for |
| --- | --- | --- |
| `scanUsage`, `isUsageRecord`, `UsageRecord`, `UsageScanState` | `@rivus/agent-kit/transcript/usage` | incremental decoding of six agents, de-duplication, scan state |
| `createPricing`, `priceRecord` | `@rivus/agent-kit/cost` | per-record pricing over a table, including a model's long-context tier, no overrides or fallbacks |
| `litellmPrices`, `litellmPricesVersion` | `@rivus/agent-kit/cost/prices` | the pricing table and the version `meta.pricing_version` records |
| `createNodePlatform` (with `sqlite`) | `@rivus/agent-kit/node` | file access for the kit, and the ledger database |
| `builtinProviders`, `Provider` | `@rivus/agent-kit/providers` | the agent list for `status`; custom providers later |
| `detectAgents` | `@rivus/agent-kit/discovery` | detected agents in `status`, stat-only: `versionProbe: false` and empty `auth` probes so no credential file is read |
| `redactText` | `@rivus/agent-kit/redact` | logs and diagnostics |
| `acquireProcessLock` | `@rivus/agent-kit-collab/process-lock` | the ledger lock |
| `createMemoryPlatform` | `@rivus/agent-kit/testing` | tests with generated agent logs |

Additions to agent-kit:

| ID | Addition | Needed by | Notes |
| --- | --- | --- | --- |
| K1 | A pricing snapshot shipped by the kit: `@rivus/agent-kit/cost/prices` exports `litellmPrices`, a generated LiteLLM table with 1-hour cache-write rates and long-context tiers ready for `createPricing`, and `litellmPricesVersion` (`<LiteLLM commit date>+<commit>+<12-hex digest of the table's content>`, so it moves whenever the table's content moves), plus the weekly update workflow | Batch 5 (M2) | Released in agent-kit 0.22.0, the tiers and content digest in 0.23.0. Each key names one model (and its dated variants); family fallbacks are left to the host, and snorlax sets none |
| K2 | Export per-record pricing from `@rivus/agent-kit/cost`: `priceRecord(record, pricing)` returns `{ parts }`, one part per model of the record's split (else the whole record) with its `usage`, its own share's `modelCalls`, and `cost` (`costUsd`, `costSource`) when something prices it, by the same rules as `summarize` | Batch 5 (M2) | Released in agent-kit 0.22.0 ([agent-kit#190](https://github.com/PerfectPan/agent-kit/issues/190)). `summarize` groups only by agent and model over a window; buckets also need the hour |
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
  dependency inlined), `Contents/Helpers/snorlax` (a compiled Swift command-line tool, signed with Code Sign On
  Copy like every embedded subcomponent), and
  `Contents/Library/LaunchAgents/io.github.perfectpan.snorlax.refresh.plist`.
- Launcher (`Launcher/main.swift`): the same behavior the first `/bin/sh` script had — reads the Node path from
  `<data>/node-path`; if missing, uses `node` from `/opt/homebrew/bin:/usr/local/bin:/usr/bin`; then `execv`s
  `node <bundle>/Contents/Resources/collector/snorlax.mjs <arguments…>`. It never searches `PATH`.
- Node discovery: on launch, when `node-path` is missing or its Node fails `--version` ≥ 22.13, run
  `/bin/zsh -lc 'command -v node'` (5 s timeout), check the version and write `node-path`. When none is found,
  the menu shows "Install Node.js 22.13 or later".
- Scheduling: `SMAppService.agent(plistName:)` registers the plist (`BundleProgram` = `Contents/Helpers/snorlax`,
  `ProgramArguments` = `snorlax refresh`, `StartInterval` 300, `RunAtLoad`). Settings shows its status and a
  toggle. If Batch 0 S1 shows registration fails with the owner's signing, the app calls `snorlax install`
  instead, which writes `~/Library/LaunchAgents/io.github.perfectpan.snorlax.refresh.plist` with absolute paths.
  The two registrations share one launchd label and are mutually exclusive: `snorlax install` is the fallback
  for machines without the app or where `SMAppService` is unusable, and the CLI refuses to install or uninstall
  while `launchctl print` shows the loaded `io.github.perfectpan.snorlax.refresh` service belongs to the app
  (turn the Settings toggle off first). An interrupted `install` stops its `launchctl` child and waits for it to
  exit; when the interrupted `bootstrap` had already loaded the service from the CLI's plist, it is booted out, and
  the plist is removed.
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

- `packages/worker` (`@rivus/snorlax-worker`, private): a Hono app (D14) built by `createApp({ db, adminToken, now })`,
  where `db` is the subset of `D1Database` it uses (`prepare`, `bind`, `first`, `all`, `run`, `batch`), declared in
  the package, and `now` an injected clock, so neither the app nor its tests need the Workers runtime types. Code
  structure in 3.12.1.
- Request bodies over 1 MB are rejected with 413. A push validates every row with the protocol schema before any
  write.
- Toolchain (D13): `cf` and `wrangler` are devDependencies of the package, pinned exactly in the catalog to the
  newest npmjs releases (on 2026-10-26: `cf` 1.0.0-beta.21, `wrangler` 4.152.0). Commands run from
  `packages/worker` through `pnpm exec cf`, so the pinned `cf` runs and delegates to the package's Wrangler. The
  package's `build` script is `cf build`, which needs no account and writes `.cloudflare/output/v0/`. `workerd`, a
  dependency of both, joins `allowBuilds` for its postinstall. `.cloudflare/`, `.wrangler/` and `.dev.vars` are
  ignored by git.
- Node: `cf` needs `^22.23.0 || ^24.22.0 || ^26.12.0`, so the root `engines` and `devEngines` move from `^24.11.0`
  to `^24.22.0`; `.node-version` stays `24`, which CI resolves to the newest 24 release. Node 26 is not an LTS
  release yet and is not adopted. The collector's `engines` (`>= 22.13`, the Node that runs the published CLI) does
  not change.
- `cloudflare.config.ts` returns its configuration from a function of `--mode`. `--mode production` reads the D1
  database id from `SNORLAX_D1_DATABASE_ID` and the custom domain from `SNORLAX_DOMAIN` and throws when either is
  missing, so no account's ids or domain are committed; it publishes on that domain with `workersDev: false`
  (6.1). Any other mode, including `cf dev`'s, binds a fixed local database id, because the local D1 commands
  accept only an id. `ADMIN_TOKEN` is declared with `bindings.secret()`; `cf dev` reads it from `.dev.vars`.
- Migrations live in `packages/worker/migrations/` (the default `--dir`) and are applied with
  `cf d1 migrations apply <database id>`; adding `--local --persist-to .wrangler/state` applies them to the state
  `cf dev` uses. The bookkeeping table is Wrangler's `d1_migrations`, so Wrangler can apply later migrations too.
- Tests run the app (`app.fetch`) against an adapter that implements the D1 subset over `node:sqlite` (a `batch` is one
  `BEGIN … COMMIT`), under `vp test` like the other packages. The Workers Vitest integration is not used:
  `@cloudflare/vitest-pool-workers` 0.23.0 needs vitest 4, and vite-plus 1.3.0 ships vitest 5. The smoke test
  below covers the difference between Node and the Workers runtime.
- Smoke test (no account), from `packages/worker`: write a throwaway `ADMIN_TOKEN` to `.dev.vars`; apply the
  migrations to the local id with `--local --persist-to .wrangler/state`; start `cf dev`; check `GET /v1/health`,
  register a device with the admin token, push and pull a bucket with its device token, and get 401 for a wrong
  token; then delete `.wrangler/` and `.dev.vars`. The implementer runs it and puts the commands and output in the
  PR.
- Deployment (owner), from `packages/worker` after `cf auth login` (`cf` does not reuse Wrangler's login):
  `cf d1 create --name snorlax --read-replication-mode disabled` once, `cf d1 migrations apply <id>`, then
  `SNORLAX_D1_DATABASE_ID=<id> SNORLAX_DOMAIN=<domain> pnpm exec cf deploy --mode production --secrets-file <file>`,
  where `<file>` holds `ADMIN_TOKEN`, sits outside the repository with mode 0600, and is deleted afterwards. `cf`
  cannot set a single secret yet, and `cf workers secrets update` would take the value as an argument. Whether a
  later deploy without `--secrets-file` keeps the secret is checked on the second deploy (section 7).

### 3.12.1 Worker code structure

```text
packages/worker/src/
  index.ts           Workers entry: builds the app once per isolate from env.DB, env.ADMIN_TOKEN and Date.now
  http/
    app.ts           createApp: routes (3.2.4), middleware, validation, the error funnel
    failures.ts      the table from every use-case error `_tag` to an HTTP status and error code
  devices/
    devices.ts       use cases: register, revoke, list, authenticate a device token; the devices errors
    store.ts         SQL on `devices`
  buckets/
    buckets.ts       use cases: push (a device writes only its own rows), pull (cursor); the buckets errors
    store.ts         SQL on `buckets`, including the push batch's `devices.last_push_at` update (3.3.3)
  tokens.ts          device token generation and hashing (3.8)
  db.ts              the D1 subset
  sqlite-d1.ts       the D1 subset over node:sqlite (tests, and a later self-hosted server)
```

In MVC terms (D14), `http/` holds the controllers, each domain folder the model, and `packages/protocol/src/http.ts`
the view. Rules, checked by `test/structure.test.ts` where they are about imports:

1. Imports go one way: `index.ts` → `http/` → `devices/`, `buckets/` → `tokens.ts`, `db.ts`. Only `http/` and
   `index.ts` import `hono` or `@hono/*`; nothing under `devices/` or `buckets/` imports `http/`; the two domain
   folders do not import each other; a `store.ts` is imported only by its own folder's use-case file and by tests.
2. HTTP stays in `http/`: the `Authorization` header, status codes, the `{ error: { code, message } }` body, the
   1 MB limit, and validation of bodies and queries with the protocol schemas. Use cases take parsed values and the
   authenticated device, return plain results, and throw their own errors.
3. Errors belong to their domain. Each use-case file declares classes with a literal `_tag` that say what went
   wrong (for example `DeviceAlreadyActive`, `DeviceNotFound`, `DeviceTokenRejected`, `ForeignDeviceWrite`) and know
   no HTTP code. `http/failures.ts` maps every tag to a status and an `HttpErrorCode` in one table typed so that a tag
   without a row fails the type check; anything else is a 500 `internal` with a fixed message, the original going to
   `console.error`.
4. SQL lives only in the `store.ts` files. An invariant that must hold under concurrency stays one statement or one
   `db.batch()` (the guarded registration upsert, the push batch with its `MAX(seq) + 1` rows): a use case never
   reads, decides and then writes the same rows.
5. Stores parse D1 rows with `zod/mini` at their boundary; use cases see typed values.
6. Middleware: `bodyLimit` (1 MB; `onError` answers 413 `payload-too-large`) on every route with a body.
   `bearerAuth` with `token: adminToken` on `POST /v1/devices` and `DELETE /v1/devices/:id`, and with `verifyToken`
   calling the devices `authenticate` use case on the device routes, which puts the authenticated device in the
   context. Both pass every failure message as a function returning the JSON error `Response` with status 401,
   because Hono answers a malformed `Authorization` header with 400 by default and 3.2.4 says 401. `bearerAuth`
   compares the admin token with Hono's `timingSafeEqual` (both sides hashed, then compared in constant time), which
   replaces the package's own comparison. `@hono/standard-validator` validates JSON bodies and the pull query with
   the protocol's `zod/mini` schemas, its hook answering 400 `invalid-body`. `app.notFound` answers 404 `not-found`;
   `app.onError` is the funnel of rule 3.

### 3.13 Collector code structure

The collector is organized by command, and code below the commands is split by what it does: pure rules, modules
with IO, and capabilities with more than one implementation.

```text
packages/collector/src/
  cli/                   framework: root command, global `--json`, output envelope (one JSON object on stdout
                         with `schemaVersion` and `ok`), usage errors, the table that maps every error to a
                         FailureCode and exit code 0/1/2, redaction of all output, the command log line (not
                         written into a data directory the run refused or deleted); `bin.ts` picks the
                         capability implementations, drops EPIPE on stdout, and runs the signal-relaying runner
                         (interrupt, then re-raise SIGINT/SIGTERM)
  commands/
    refresh/             command.ts (flags, rendering) + flow.ts (the flow, in Effect)
    rebuild/             command.ts + flow.ts (zeroes the window, then the ledger module's scan-and-commit)
    status/  snapshot/   command.ts + flow.ts
    doctor/              command.ts + flow.ts + checks.ts (doctor's own verdict rules, plain functions)
    install/  uninstall/ command.ts + flow.ts, both on capabilities/scheduler; uninstall also has delete-data.ts
                         (which directory `--data` may delete, and deleting only the entries snorlax wrote)
    pair/  unpair/       stubs until Batch 7
  core/                  pure rules, no IO: buckets (hourly accumulation of the parts the kit's `priceRecord`
                         returns, with the pricing passed in), snapshot (windows, series, building the snapshot
                         from buckets), error-message
  modules/               IO with a single implementation: ledger (SQLite, migrations, the scan-and-commit flow
                         refresh and rebuild share, which creates the pricing from the kit's LiteLLM table and
                         records its version), scan (agent-kit `scanUsage`, wrapped once), snapshot-file,
                         data-dir (resolve, create, the absolute-path check), config, log, read-text-file,
                         version, time-zone, platform (the kit platform and the Node file ops it does not model)
  capabilities/          external systems with more than one implementation: scheduler (launchd; systemd in
                         Batch 8; the test fake in `test/fixtures/`), secrets (Batch 7: Keychain, libsecret,
                         memory), backend (Batch 6: HTTP client, memory)
```

Rules, checked by `test/structure.test.ts` where they are about imports:

1. Imports go one way: `cli` → `commands` → `capabilities` → `modules` → `core`. `core/` imports none of the
   other layers (protocol and agent-kit types are fine); nothing below `commands/` imports `commands/` or `cli/`.
2. A command folder never imports another command folder. Code a second command needs moves down into `core/`,
   `modules/` or `capabilities/`, by what it is.
3. Code only one command uses stays in that command's folder.
4. Each module and capability has one entry file named after it (`modules/ledger/ledger.ts`); its other files are
   internal. Code outside it imports only the entry file. No re-export barrels.
5. Capabilities are `Context.Service` interfaces with one `Layer` per implementation; `cli/bin.ts` picks the
   implementation and tests provide fakes. Modules are plain modules, not services; the exception is the
   environment the CLI runs in, which `bin.ts` provides and tests replace: `SnorlaxPlatform` and `NodeFiles` in
   `modules/platform`, and the `TimeZone` and `RuntimeInfo` references.
6. Flows (`commands/*/flow.ts`, and module flows several commands share, such as scan-and-commit) are written in
   Effect: the ledger, the ledger lock and other resources are acquired in scopes, so an interrupted run releases
   them. `core/` and command-specific rules (doctor verdicts) are plain functions without Effect types. No service
   exists only to wrap a Promise function.
7. Errors belong to the code that raises them. Each module, capability and command folder defines its own
   tagged errors describing what went wrong (for example the ledger's "newer schema" or "busy", the scheduler's
   "owned by the app"); none of them knows `FailureCode`. `cli/` owns usage errors and one table that maps every
   error `_tag` to a `FailureCode` and exit code, written so the TypeScript compiler fails when a tag is missing;
   anything unmapped, including defects, is `internal`. There is no shared `errors.ts`.
8. Building a Layer has no side effects. `status`, `doctor` and `snapshot` create or change no files: `doctor`
   reports a missing directory, a wrong mode or a data directory that is a file as failed checks in a `Doctor`
   payload, and repairs nothing.

- `FailureCode` appears only in `cli/` and the protocol package.
- agent-kit calls take the platform from `SnorlaxPlatform`, which `bin.ts` derives from the kit's `PlatformService`
  (`NodePlatformLive`); tests provide it over a memory platform or a Node platform with a temporary home.
- Output: help, usage errors and version use `effect/cli`'s `CliOutput.defaultFormatter`; command failures are
  rendered by `cli/` so that `--json` keeps exactly one object on stdout; the output mode follows the parsed
  `--json` value. Human renderings are plain text; color comes from `node:util` `styleText` against the
  destination stream (so `NO_COLOR` and non-TTY output stay plain).
- Startup: in the single-file bundle, on-demand import does nothing (rollup inlines dynamic imports), so startup
  cost is controlled by side-effect-free Layers and measured. Batch 4b measured `snorlax status --json` (median
  of 20 runs, fresh temporary `HOME` each) at 85 ms on the `parseArgs` CLI and about 112 ms on `effect/cli`. The
  bundle is not minified; rolldown keeps only legal comments.
- Licenses: the build writes `dist/THIRD_PARTY_LICENSES.md` through Vite's `build.license` — the name, version,
  license field and LICENSE text of every package the bundle's modules come from — and `@rivus/snorlax` ships it
  with `dist/`.

## 4. Rollout and stability

### 4.1 Gates and rollout stages

1. Batch 0 results recorded in section 7 (signing path, scan numbers).
2. M1 (Batches 1–4d): the owner uses the app on one Mac for three days. Token totals match ccusage
   (`ccusage claude daily` plus `ccusage codex daily`, same time zone) for every day that has ended; today may be
   lower by the last requests of sessions still running, which agent-kit reports once their file has been quiet
   for 30 minutes.
3. M2 (Batch 5): cost totals match ccusage for days that have ended, or each difference is explained (pricing table
   version, agent-logged cost). Passed on 2026-10-25; the numbers are in section 7 (M2 results).
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
switched to failing; token rules (S9) against the Worker app.

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
| M1 Local | On one Mac, the menu bar app and the desktop widget show this machine's tokens, requests and sessions for today, the last 7 and the last 30 days, refreshed every 5 minutes. Cost shows the amounts agents logged themselves; other requests are marked unpriced. | 0–4d |
| M2 Pricing | Every request whose model is in the pricing table is priced. | 5 |
| M3 Cross-device | Several Macs and Linux machines show the same totals through the owner's Worker. | 6–8 |

### 6.1 Preconditions

- Read `AGENTS.md`, including its Project Rules: never read real agent session files, zod at boundaries, no
  hand-written shape guards, injected clocks in tests, temporary `HOME` cleanup, owner-only steps.
- Toolchains: Node 24 and pnpm from the repository pins (from Batch 6, Node 24.22 or later, which `cf` needs;
  3.12); Xcode with the macOS 14 SDK or later and XcodeGen for Batches 0 and 4. The lockfile must resolve from
  `https://registry.npmjs.org/` only; on a machine whose default registry is a mirror, pass
  `--registry https://registry.npmjs.org/` to pnpm commands that resolve versions.
- M1 needs no Cloudflare account, no second machine and no agent-kit change.
- M2 needs an agent-kit release that contains K1 and K2 (3.10; K2 is
  [agent-kit#190](https://github.com/PerfectPan/agent-kit/issues/190)).
- M3 needs the owner's Cloudflare account with `cf auth login` done on the owner's machine, a domain whose DNS is
  on Cloudflare (`*.workers.dev` often does not resolve from mainland China), and a second Mac. Batches 6 and 7
  themselves need no account: tests and smoke tests run locally (3.12).

### 6.2 Working agreement

- One PR per batch; Batch 0 is one PR per spike. Titles, descriptions and checks follow `AGENTS.md`. The owner
  reviews and merges.
- Every batch PR updates 6.8 Progress: status, decisions taken within this plan's limits, open problems. 6.8 is the
  handoff to the next session or agent; there is no separate handoff file.
- Steps marked "owner" are prepared in the PR (exact commands) and run by the owner.
- Collector code follows 3.13. Batches 1–4b predate the command-folder layout; Batch 4c moves them.
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
| R13 | Batch 1 `status-doctor.test.ts`; Batch 4b makes `doctor` report data-directory problems without changing files (backend checks added in Batch 7) | M1 |
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
- Exit: `xcodebuild test` passes in CI. M1 acceptance is in 4.1 step 2.

#### Batch 4b (M1): collector on `effect/cli`, and review leftovers

- Files: `packages/collector/**`; `packages/protocol/**` for the `snapshot` output wrapper (with its JSON Schema,
  fixtures and generated Swift types); `pnpm-workspace.yaml` (catalog: `effect` and `@effect/platform-node` at the
  exact version agent-kit's `peerDependencies.effect` names).
- Change: move the collector to the structure of 3.13 on `effect/cli` (D12). CLI behavior stays the same except
  for these fixes left by the Batch 1–3 reviews:
  - `packages/collector/package.json` lists runtime `dependencies` that `dist/snorlax.mjs` already inlines; on
    pack, `@rivus/snorlax-protocol` (`workspace:*`, private) becomes `0.0.0`, so `npm i -g @rivus/snorlax` fails
    with E404. Move them to `devDependencies`; the published manifest has no `dependencies`.
  - `doctor` reports a missing data directory, a wrong mode, or a data directory that is a file as failed checks
    and changes nothing; `status` and `snapshot` create no files.
  - Every output, human text included, is redacted in `cli/`; error codes are typed as `FailureCode`; business
    modules no longer import from `cli/`.
  - `snapshot --json` prints `{ schemaVersion, ok, snapshot }` (3.1).
- Tests: existing suites keep their behavior; a test per listed fix; the hand-written shape guard in
  `test/cli.test.ts` replaced by a zod schema.
- Exit: `pnpm run check` passes; `pnpm --filter @rivus/snorlax pack` shows no `dependencies`; the PR reports the
  median of 20 cold runs of `snorlax status --json` before and after (3.13). Shipped as #16; the folder layout of
  3.13 follows in Batch 4c and the remaining review findings in Batch 4d.

#### Batch 4c (M1): command folders

- Files: `packages/collector/src/**`, `packages/collector/test/**`.
- Change: reorganize the collector into the layout and rules of 3.13. Each command gets `commands/<name>/` with
  `command.ts` and an Effect `flow.ts`; the per-feature services that only wrap Promise functions (`refresh`,
  `rebuild`, `schedule`, `snapshot`, `doctor`) and the platform adapters they need go away; the scan-and-commit
  step refresh and rebuild share becomes an Effect flow in `modules/ledger/` that acquires the ledger and the lock
  in a scope; pure rules move to `core/`; `scheduler` becomes a capability in `capabilities/` (interface, launchd
  layer, test fake); `errors.ts` is split into errors owned by each module, capability and command, plus the
  error-to-FailureCode table in `cli/` (3.13 rule 7). No CLI behavior changes: every failure keeps its current
  code and exit code.
- Tests: existing tests pass with unchanged assertions (only import paths move); the structure test catches a
  cross-command import, a deep import into a module or capability, and an upward import (for example `core/` →
  `modules/`, `modules/` → `commands/`); an interrupted refresh releases the ledger lock and closes the ledger
  (driven by a gate, no real time).
- Exit: `pnpm run check`; the built bundle behaves the same on the 4b smoke set (`--help`, `--version`,
  `status --json`, `doctor --json`, `snapshot --json`, `--version --json`, signals); cold start reported.

#### Batch 4d (M1): review leftovers

- Change: issue #11 (the 30-day group bound for buckets after today, the remaining row coercions, the
  `readLedgerStatus` open failure code, SQLite busy handling between `status` and a committing refresh, the
  `ledger-lock` test helpers), issue #13 (a snorlax marker before `uninstall --data` deletes anything, `doctor`
  checking the scheduled job and its Node path), and issue #15 (the `launchctl` child on interruption, `EPIPE` on
  a closed stdout, third-party license notices in the package).
- Tests: one per item.
- Exit: `pnpm run check`; the issues closed by the PR.

#### Batch 5 (M2): pricing

- Precondition: agent-kit with K1 and K2 released; the catalog pins it.
- Change: replace `splitByModel` with the kit's `priceRecord`; load the kit's pricing table (K1) and record
  `pricing_version`; `status` reports `pricingChanged` and suggests `snorlax rebuild --days 30` (3.7).
- Tests: `buckets.test.ts` (S11 with a table, S12 unchanged, multiplier and 1-hour cache writes through the kit).
- Exit: tests pass; M2 acceptance is in 4.1 step 3.

#### Batch 6 (M3): Worker

- Files: `packages/worker/**` (`package.json`, `cloudflare.config.ts`, `vite.config.ts`, `tsconfig.json`,
  `migrations/0001_init.sql`, `src/**`, `test/**`), HTTP schemas in `packages/protocol`, `pnpm-workspace.yaml`
  (catalog: `cf`, `wrangler`; `allowBuilds`: `workerd`), the root `package.json` (`engines`, `devEngines`),
  `.gitignore`.
- Change: 3.2.4 including `GET /v1/health`, 3.3.3, the token rules in 3.8, 3.12.
- Tests: `devices.test.ts` (S9, revoke), `buckets.test.ts` (upsert, seq order, pagination, 200-row limit, strict
  body, 413), `protocol.test.ts` (S15 schemas).
- Exit: tests pass; `pnpm exec cf deploy --dry-run --mode production` with placeholder `SNORLAX_D1_DATABASE_ID`
  and `SNORLAX_DOMAIN` builds and lists the D1 binding without an account; the `cf dev` smoke test (3.12) with its
  output in the PR. Owner: create the database, apply the migration and deploy to `snorlax.<domain>` (3.12), then
  record in section 7 that `GET /v1/health` answers from every network the devices use, and whether the secret
  survived the second deploy.

#### Batch 6b (M3): Worker on Hono, in layers

- Lands on `feat/worker` (PR #27) as added commits before that PR merges, an exception to one PR per batch; Batch 6's
  behavior and HTTP interface definitions do not change.
- Files: `packages/worker/src/**` to the layout of 3.12.1 (`handler.ts` with its `RequestFailure` and
  `STATUS_BY_CODE` goes away; `tokens.ts` keeps generation and hashing and drops `secretsEqual`);
  `packages/worker/package.json` (`exports["."]` → `./src/http/app.ts`; `hono` and `@hono/standard-validator` beside
  `zod` in devDependencies, since `cf build` bundles them); `packages/worker/test/fixtures/backend.ts` (builds
  `createApp` and gives tests `app.fetch`); `packages/worker/test/structure.test.ts` (new); `pnpm-workspace.yaml`
  (catalog); 6.8.
- Versions: `hono` and `@hono/standard-validator` pinned exactly in the catalog to the newest npmjs releases older
  than the repository's one-day `minimumReleaseAge`, with no exclusion added. On 2026-10-26 that is `hono` 4.13.14;
  `@hono/standard-validator` 0.4.1 was published that day, so 0.4.0 until 0.4.1 is a day old. Resolve with
  `--registry https://registry.npmjs.org/`.
- Change:
  1. Move each rule out of `handler.ts` into its use case: registration (the guarded upsert unchanged; `changes` 0
     → `DeviceAlreadyActive`), revocation (an unknown id → `DeviceNotFound`), listing, token authentication (an
     unknown or revoked token → `DeviceTokenRejected`), push (a path or row device other than the authenticated one
     → `ForeignDeviceWrite`; one batch answering `base + row count`), pull (cursor and `next`).
  2. Move every SQL statement, unchanged, into its domain's `store.ts`.
  3. Write `http/app.ts` with the middleware of 3.12.1 rule 6 and the routes of 3.2.4, and `http/failures.ts`.
  4. `src/index.ts` builds the app once per isolate.
- Must keep, each pinned by a test that already exists in `test/devices.test.ts`, `test/buckets.test.ts`,
  `src/sqlite-d1.test.ts` or `src/http.test.ts` (these stay and pass with only the backend helper changed): 401 for
  a missing, unknown or revoked token and for the admin token on a device endpoint; 403 for a foreign path or row;
  409 for an active id, and exactly one 201 for two concurrent registrations of one id; 201 for a revoked id,
  keeping `created_at` and `last_push_at`; `DELETE` of an unknown id 404, of a revoked id 204; 413 by declared
  length and for a streamed body, which is not read to the end; 400 for unknown keys, 0 or 201 rows, and
  `after`/`limit` that are not plain decimal integers; a fixed 500 body; seq order, replacement and pagination; error
  bodies `{ error: { code, message } }` with the protocol's codes.
- Tests: the existing suites, unchanged except the helper; `test/structure.test.ts` for the import rules of 3.12.1
  (a `hono` import in a use case, an `http/` import from a domain folder, a cross-domain import and a foreign
  `store.ts` import each fail it); a test that a malformed `Authorization` header gets 401 with the JSON error body,
  if no existing test pins it.
- Exit: `pnpm run check`; `gh repo-checks repository`; `grep -c bnpm pnpm-lock.yaml` is 0;
  `pnpm exec cf deploy --dry-run --mode production` with the Batch 6 placeholders passes, its upload size in the
  PR; the `cf dev` smoke test of 3.12 rerun with its output in the PR, stopping the whole process tree (`cf dev`,
  `cf-wrangler.js dev`, `workerd`) and confirming nothing is left running; each structure rule shown failing once
  when broken on purpose.

#### Batch 7 (M3): sync in the collector

- Files: `packages/collector/src/{sync,keychain,pair}/**`.
- Change: 3.4.1 step 6, 3.4.2, `unpair`, backend checks in `doctor`, `byDevice` in the snapshot.
- Tests: `sync.test.ts` (S6–S8, S15, failure codes; two collectors against the Worker app on in-memory
  `node:sqlite`), `install-uninstall.test.ts` extended with `pair` (S14), `keychain.test.ts` with stubbed
  `security` and `secret-tool` that checks the token is passed on stdin only, `pair.test.ts`.
- Precondition: the owner has decided whether the first push after pairing sends buckets older than 30 days
  (section 7).
- Exit: tests pass; two local collectors against `cf dev` converge (steps in the PR).

#### Batch 8 (M3): pairing in the app, Linux, release setup

- Files: `apps/macos/**` (Settings: backend URL, admin token, Pair, Unpair),
  `packages/collector/src/capabilities/scheduler/**`
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
| 6 | `pnpm --filter @rivus/snorlax-worker run test`; `cf deploy --dry-run --mode production`; `cf dev` smoke (3.12) | pass |
| 6b | the same as 6, plus `test/structure.test.ts` | pass; Batch 6's behavior unchanged |
| M1 | owner, three days on one Mac | token totals match ccusage for every finished day (4.1 step 2) |
| M2 | owner | cost totals match ccusage for finished days, or differences explained |
| M3 | owner, 5.4 | converged totals on all devices |

### 6.6 Rollback per batch

Every batch reverts with its PR. Batch 2 introduces the ledger: a later revert leaves `ledger.db` in place and a
re-applied build migrates it again. Batch 6 adds D1 tables that later Workers keep using.

### 6.7 Work split

| Work | Who |
| --- | --- |
| Batches 0–8 (including 4b) code, tests, docs, PRs | implementing agent |
| S2 run on real logs, M1/M2/M3 acceptance, deploys, signing, npm Trusted Publishing, branch protection, merges | owner |
| K1, K2 in agent-kit | agent-kit maintainer |

### 6.8 Progress

| Batch | Status | PR | Decisions taken | Open problems |
| --- | --- | --- | --- | --- |
| 0 S1 | merged | #10 (re-hosted #5) | Automatic signing with an empty team in `project.yml`; the local `xcodebuild` disables signing. Batch 4 replaced the spike menu, `spike-value.json`, and the `node -e` launcher; the App Group id is unchanged. `register()` is only the Settings toggle and is not called on launch. The launcher still does not search `PATH`. | App Group, `SMAppService`, and the widget gallery need the owner's Personal Team. See section 7. |
| 0 S2 | merged | #6 | Incremental scan uses `since` = clock now − 2 h (3.4.1); full scan uses `since` 0 and no state. `RootMissing` counts as a source failure; every other scan failure counts as a decode failure, because the scan stream does not label a listing `ReadFailed` apart from a decode `ReadFailed`. | Owner paste of `node scripts/measure-scan.ts` is not in section 7 yet, so the refresh interval stays 300 s. |
| 1 | merged | #4 | `invalid-arguments` added as the failure code for exit 2 (the plan lists codes only for runtime failures); later-batch commands (`refresh`, `rebuild`, `pair`, `unpair`, `install`, `uninstall`) are registered as `internal` stubs instead of omitted; `doctor` checks `config.json` in addition to node-version and data-dir (all local, keychain/backend/scheduling wait); status device id and scan/sync fields come from `snapshot.json` until the ledger exists (Batch 2 replaces the source, not the output); protocol `PairResult`/`Doctor` field sets are provisional pending Batches 4/7 review; `minimumReleaseAgeExclude` in pnpm-workspace.yaml for the owner's agent-kit 0.20.0 (published the same day the catalog pinned it) | Bucket and output schemas drop unknown keys on parse (forward compatibility, plan 3.7); the strict unknown-key rejection required for HTTP bodies (3.2.3) lands with Batch 6's schemas; agent-kit 0.20.0 pinned via catalog — remember to drop the exclude entry after it ages past `minimumReleaseAge` |
| 2 | merged | #7 | Rebuild runs its zeroing and its rescan as one transaction (zeroed buckets, `sessions_seen` deletes, scan, bucket writes, `scan_state`, `last_scan_completed_at` all commit together), not the plan's "one transaction, then steps 3–8": a crash between them would re-read the window over buckets that were no longer zeroed and double count. `RefreshResult.sync` is `{ok:false, pushed:0, pulled:0}` while unpaired (the "not paired" report of Batch 2; snapshot and `status` carry `sync.state: "unpaired"`). `failuresByAgent` counts every scan failure except `RootMissing` — an agent that is not installed is detection, not a decode failure, unlike the Batch 0 measure script, which counts every failure. `meta.device_name` stays NULL until `pair` owns it (Batch 7); the snapshot's device name comes from `config.json`. A snapshot write failure fails the command (exit 1, `data-dir`) after the ledger commit; the scan stays and the next refresh rewrites the snapshot. Rebuild's window start is hour-aligned rolling `now − n×24 h`, keeping bucket keys whole. Backups keep the latest two by version. `CollectorPlatform` gained optional `sqlite` and process-identity members; the refresh command widens the platform for the lock, whose absent identity members throw (the kit treats a throwing `self` as "no identity"). Test fixtures pin mtimes one hour before the scan clock so the kit decodes sources as `final` (an unpinned mtime delays Claude Code's open-request reporting past the 30-minute quiet window). S2's proof counts bytes read through the platform: an unchanged source is touched by at most the kit's one-byte cursor probe. Month-of-history fixture (9,300 records, five agents): full refresh 118 ms, incremental 29 ms, scan state 141 KB. The ledger opens under the ledger lock — migration, backup, the meta write and the meta/scan-state read all run inside it — so overlapping runs queue on the lock instead of the second reading the first's pre-commit state, and a run never fails with SQLITE_BUSY while another scans. A split record's requests are distributed across its portions: a portion naming its own `modelCalls` keeps it; the calls left over, never below zero, go to the token-largest portion without its own count, other missing portions count 0, and known counts above the record's leave the missing portions at 0; a record without `modelCalls` counts each portion by its own count or 1. | `RefreshResult.sync` cannot distinguish "unpaired" from "failed" (`ok:false` for both); Batch 7 may want a state field there (protocol change). `status` reads the device id and last scan from the ledger but sync and failures from the snapshot until Batch 7 owns them in the ledger. |
| 3 | merged | #9 | macOS LaunchAgent only. `install` writes `~/Library/LaunchAgents/io.github.perfectpan.snorlax.refresh.plist` with Label, ProgramArguments = absolute `process.execPath` + absolute running `snorlax.mjs` + `refresh`, StartInterval 300, RunAtLoad, and StandardOutPath/StandardErrorPath at `/dev/null` — the refresh summary already goes to the rotating `logs/snorlax.log` (3.9), and an unrotated launchd redirect file would only grow. A non-empty `SNORLAX_HOME` is copied into the plist's EnvironmentVariables so the agent uses that data directory. Before any change, `launchctl print gui/<uid>/<label>` must name the loaded service's `path`; the CLI refuses (exit 1, `internal`, no file touched) unless that path is its own plist — Snorlax.app's Launch at login and this agent share one label and are mutually exclusive (3.11), and a print that names no path is refused rather than guessed. Load is `launchctl bootstrap gui/<uid> <plist>`; a service already loaded under the CLI's own plist is `bootout` by service target first, so install can be repeated and a hand-deleted plist does not block uninstall; a failed `bootstrap` removes the plist it just wrote. `SNORLAX_LAUNCHCTL` overrides the launchctl binary (default `/bin/launchctl`); tests point it at a stub under a temporary HOME whose `bootstrap` fails like launchctl's while a service is loaded. `SNORLAX_OS` (`darwin`, `linux`, `win32`) selects the scheduler instead of `platform.os` so the bundled CLI can run this path on the Linux CI job; it is not copied into the plist. Linux and other systems exit 1 with code `internal` and a message that names Batch 8, because plan 3.2.1 has no unsupported-platform code and the protocol FailureCode union is outside this batch. `uninstall --data` removes only the entries snorlax writes — `ledger.db` with its SQLite sidecars, `ledger.db.bak-v*`, `ledger.lock` and its `.holder`, `config.json`, `snapshot.json` and crashed `.<hex>.tmp` atomic-write temps, `node-path`, `logs/` — then removes the directory itself only when empty, listing anything left in the output with exit 0, after `removeKeychainItem()`, which is a no-op until Batch 7. Relative data directories are refused; so are `/`, the home directory, and its ancestors, compared through `realpath`. The S14 test hashes all six agent directories around install, a real `refresh` (exit 0, `records` > 0), and uninstall, and HOME's top level gains nothing but `Library/` and the data directory. The install test parses that plist with the `plist` package (catalog devDependency, 5.0.0) and a zod schema. | `doctor` does not check scheduling yet, and the plist's Node path is `process.execPath`, which carries the installed version (nvm, Homebrew): upgrading or removing that Node silently stops the timer. Keychain removal waits for Batch 7. systemd waits for Batch 8. `launchctl print` treats every non-zero exit as not loaded. An in-flight refresh is not awaited after bootout before `uninstall --data` deletes the directory. |
| 4 | merged | #8 | S1 owner run is still pending, so the widget keeps the App Group and does not add the home-relative read entitlement. quicktype 26.0.0 (catalog) reads `schema/*.json`; the generator shares window totals with `$ref` and sets JSON Schema titles so Swift names stay stable, and date-times stay `String`. Token short form is 1000-based K/M/B/T (`812345678` → `812M`); cost is `$` with two fraction digits (`312.4` → `$312.40`); the review pass below replaced that suffix: a fully unpriced window reads `unpriced`, a partially priced one `≥ $x.xx`. Device name is shown from `snorlax status` and is read-only because no command changes it. `refresh` decodes the failure shape; Batch 2 has landed, so refresh scans real logs. `SMAppService.register()` runs only from the Settings toggle. Node discovery writes `<data>/node-path` from `/bin/zsh -lc 'command -v node'` when the saved Node is missing or older than 22.13, runs after the snapshot loads, and reads the path from the last `/`-leading output line. The compiled launcher execs the bundled collector. The Xcode build phase runs `pnpm --filter @rivus/snorlax run build` and copies `dist/snorlax.mjs`; user script sandboxing is off so that phase can run pnpm. A newer snapshot is not copied; the widget keeps the last accepted copy. A review pass replaced the `/bin/sh` launcher with a compiled `SnorlaxLauncher` tool target embedded at `Contents/Helpers/snorlax` with Code Sign On Copy — an unsigned subcomponent failed every signed build — and CI gained an ad-hoc signed build verified with `codesign --verify --deep --strict`. An unchanged snapshot (same `generatedAt`) is not copied again and does not reload widget timelines. The popover names an unnamed local device `This Mac` and an unnamed remote by the first 8 characters of its id, hides Devices when this Mac is the only device, drops rows with no usage today, plots the 30-day chart on real dates, and shows `unpriced` for fully unpriced windows and `≥ $x.xx` for partially priced ones. The widget distinguishes a missing snapshot, an unavailable container, and a newer snapshot, captions the snapshot with `as of`, and shows `—` for Today when the snapshot's day in the snapshot's zone has passed. | App Group container, `SMAppService` registration, and the widget gallery still need the owner's Personal Team (section 7). Signing-disabled tests do not answer them. Changing the device name has no CLI command. Batch 2 has landed, so `snorlax refresh` fills a snapshot by scanning this Mac's logs. Pairing controls are Batch 8. The App Group container is system-protected: a CLI cannot delete `snapshot.json` inside it, so uninstall needs the app to delete its copy or prompt the user (R14). |
| 4b | merged | #16 | `effect` and `@effect/platform-node` pinned to 4.0.4 in the catalog — the exact version `@rivus/agent-kit` 0.20.0 names in `peerDependencies.effect`; `@effect/platform-node-shared` pinned by override to the same train because 4.0.6's `effect` peer is `^4.0.6`. Structure per 3.13: `cli/` (root command, shared `--json`, envelope, exit codes, redaction, command log), `commands/` (flags via `effect/cli`, handler returns payload + human text through a one-slot `CommandOutput` service), feature services (`DataDir`, `ConfigStore`, `Log`, `StatusReport`, `Doctor`, `SnapshotStore`, `Refresh`, `Rebuild`, `Schedule`) over the plain orchestration the Batch 2/3 tests still call; `errors.ts` holds the tagged `UsageError`/`CommandError` whose `code` is the protocol `FailureCode`; the platform reaches features as `SnorlaxPlatform` (the kit `PlatformService` narrowed so the memory platform satisfies it); `bin.ts` runs `NodeRuntime.runMain` over `NodePlatformLive`. Parse errors from `effect/cli` arrive as `CliError.ShowHelp`; `cli/` renders them as exit 2 + `invalid-arguments`, its own tagged errors as exit 1, and prints the failure shape itself (`renderErrors` left on for the human path). effect/cli's own rendering is captured through a buffering, redacting `Console` and flushed only once the mode is decided, so a `--json` run drops it and keeps exactly one JSON object on stdout; the mode itself follows the value effect/cli parsed — `--json` is a `GlobalFlag.Setting`, the handler hands the parsed value to its render, and only paths where no handler ran (parse errors, built-in flags) fall back to the tokens before `--`. This makes `--json=false`, `--json no`, `--json 0`, `--no-json` and `status -- --json` behave by their parsed meaning (effect keeps the first value when the flag is spelled twice). Exit codes travel on the `Runtime.errorExitCode` marker of a `CliExit` failure. Fixes: bundled runtime deps moved to `devDependencies` (pack shows no `dependencies`); `doctor` fails the data-dir check on a missing directory, a file in its place, or a mode wider than 0700 — exit 0, nothing repaired, and the old writability probe is gone because the command must not touch files; `status`, `snapshot` and `uninstall` create nothing on a fresh machine (`DataDir.ensure` is called only by `refresh`, `rebuild` and `install` — install only after the ownership check, so a refused install builds nothing; it also creates `logs/`, which the append-only `Log` service needs for the refresh summary, while the kit's `fs.remove` and the leftovers handling treat a missing directory as already clean); `snapshot --json` wraps as `SnapshotOutput`; every output is redacted centrally in `cli/` (`redact` for JSON values, `redactText` for text), so `status.dataDir` and the `install`/`uninstall` human paths now read `~/…` — the affected test assertions follow that spelling; the hand-written shape guard in `test/cli.test.ts` became zod parses and the bundle tests parse stdout through the protocol schemas; a structure test walks the sources for `cli/`/`commands/` imports inside feature modules. The Swift generator injects the prepared snapshot schema into `snapshot-output`'s `$defs` and skips snapshot.json as its own quicktype source, because quicktype renames a named type that lives in two documents. Cold start of `snorlax status --json` (median of 20 runs, fresh temp `HOME` each): 85 ms on main 1d12d09, 112 ms on the final bundle here; `dist/snorlax.mjs` grew 824 KB → 1,006 KB (Effect runtime inlined; rolldown drops doc comments via `output.comments` — 31,495 lines, longest 560 chars — and the file stays unminified per D9's debuggable single file). `bin.ts` does not use `NodeRuntime.runMain`: it would turn a timed-out command into exit(130), which breaks the app's `CollectorClient` timeout detection (3.2.1); instead a `runFork` runner interrupts the fiber on SIGINT/SIGTERM and then re-raises the same signal at the process, so it ends by signal with empty stdout. The built-in flags are narrowed to help and version via `CliConfig` (`--wizard` would prompt interactively, `--completions`/`--log-level` are outside the convention): human `--help`/`-h`/`--version`/`-v` exit 0; with `--json` they print one `invalid-arguments` object and exit 2. `--json=` is rejected (`invalid-arguments`, exit 2) because the boolean flag takes no value and `--json=false` parsing to json would misreport either way. effect/cli's own human rendering (help, formatted parse errors) is redacted like every other output. | `effect/cli` is unstable and pinned exactly; it upgrades with agent-kit's peer range. Command modules load eagerly — real laziness is unobservable in the single-file bundle, so startup cost is held at the layer level (no side effects before a command runs) plus the cold-start measurement. `--json` is accepted before the command name (npm-style shared flags). The human path of a usage error prints effect/cli's help and formatted errors instead of the old message-plus-usage on stderr; `UsageError` prints the message alone. `pair`/`unpair` stay stubs; the #11/#13 items and the PR are the second part. |
| 4c | merged | #18 | Every module, capability and command folder raises its own `Data.TaggedError` carrying only `message`; `cli/failures.ts` maps each `_tag` of `Command.Error<typeof rootCommand>` to its code and exit, so a missing tag fails to compile, and an unexpected exception is a defect reported as `internal` with its message unchanged. `status` and `snapshot` keep an unknown read failure at `data-dir` through their own `StatusReadFailed` and `SnapshotUnreadable`. A `command.ts` exports a plain `{ name, description, flags, run }` whose `run` returns payload and human text; `cli/root.ts` turns it into the effect/cli command, so commands never import `cli/`, and `CommandOutput` stays a one-slot handoff inside `cli/`. `SnorlaxPlatform` is the full kit `Platform` (`CollectorPlatform` and the refresh platform adapter are gone); tests on the memory platform fill in the process members it lacks. `openLedger` holds the connection in a scope and `transaction` rolls back on failure or interruption; `scanAndCommit` in `modules/ledger` runs lock, open, scan, commit, snapshot and the summary log line, and the lock wait is timed on Effect's clock with the run's interruption passed to the kit. Ledger rows are parsed one at a time so failure messages carry no array index. `read-text-file` and `version` are modules (IO shared by several commands); `NodeFiles` lives in `modules/platform`; deleting the data directory moved from the scheduler to `commands/uninstall/delete-data.ts` (only uninstall uses it; `requireAbsoluteDataDir`, which the scheduler needs for both commands, stays in `modules/data-dir`), and the `removeKeychainItem` no-op to the uninstall flow. The scheduler's `install(job, prepare)` and `uninstall(job, guard)` take the caller's step so the order stays: install prepares the data directory only after the ownership check, and `uninstall --data` checks the directory before `launchctl print`. The scheduler entry exports one Layer per implementation (`Scheduler.launchd`, `Scheduler.unsupported(os)`, `Scheduler.osOverrideInvalid`) and `cli/bin.ts` picks one from `SNORLAX_OS` or `platform.os`; the two that are not launchd fail only install and uninstall, so `status` and the other commands ignore `SNORLAX_OS`. `launchctl` runs with the run's abort signal, and a failed or interrupted `bootstrap` removes the plist it wrote (before, an interrupted install left the child running and the plist in place). Cold start of `snorlax status --json` (median of 20 alternating runs, fresh temporary `HOME` each, one machine): 92.6 ms on the bundle of main a32fa8e, 89.0 ms here; `dist/snorlax.mjs` 1,006,197 → 1,017,239 bytes. | An interrupted install stops `launchctl`, but a `bootstrap` that completed first leaves the service loaded without its plist until `install` or `uninstall` boots it out; #15 (wait for the child, a bundle-level test) stays in 4d. `CommandOutput` is the only service that is neither a capability nor part of the environment. The refresh and rebuild flows repeat their five-line preparation (platform, data directory, logger, time zone). `LedgerLockHeld` → `locked` has no CLI-level test; it comes with the ledger-lock test helper of Batch 4d (#11). |
| 4d | merged | #20 | A bucket after today (a clock running ahead) is in no window and opens no agent or model group in the snapshot. The `scan_state` row and `user_version` are parsed with zod/mini, and a bad value is `LedgerUnreadable` naming the table or pragma; `openLedger` reads `user_version` and hands it to the migrations, which avoids an import cycle. A `status` that cannot open the ledger reports `LedgerUnreadable` (`data-dir`) with the path. Both ledger connections set `busy_timeout` 5000 ms and the ledger stays in the rollback journal (3.3.2, 3.5); WAL was rejected because a read-only open creates `-wal`/`-shm` and backups would need a checkpoint. The lock tests match probe events by name, settle overlapping runs, and cover `LedgerLockHeld` → `locked` through the CLI; three `toMatchObject({ message: /re/ })` assertions that matched anything became `expect.stringMatching`. `uninstall --data` deletes only in a directory whose `ledger.db` is a regular file with a rollback-journal SQLite header and a `meta` row read through `readLedgerStatus`; a WAL header is refused without opening it, a missing or empty directory passes, and anything else refuses the whole command (`data-dir`) before `launchctl` runs, which also stops the old unlink of a file at `SNORLAX_HOME`. The refusal names its case: no `ledger.db` is `DataDirNotSnorlax` and points at plain `snorlax uninstall` for removing only the job; a `ledger.db` that is not snorlax's (not a regular file, not a rollback-journal SQLite header, or no `meta` table, which `readLedgerStatus` reports as `LedgerNotSnorlax`, also `data-dir` for `status`) is `DataDirNotSnorlax` with no advice, since a refresh would migrate such a database into a ledger; a ledger that cannot be read (a hot journal a read-only connection cannot roll back, a lock past the busy timeout, damage) is `DataDirLedgerUnreadable` with SQLite's reason and one `snorlax refresh` before retrying. Failures that reject the data directory itself carry `refusesDataDir` in the `cli/` table, and a successful `uninstall --data` returns `deletedDataDir`; either way the run writes no command log line into that directory. The scheduler gained a read-only `inspect` (the CLI plist and `launchctl print`, any failure folded into an unknown source), and the plist's Node path is read back from the layout `renderLaunchAgentPlist` writes rather than with the `plist` package (about 260 KB in the bundle). `doctor`'s `schedule` check: no launchd → warn; loaded by the app with no CLI plist → ok, with a CLI plist too → warn; the CLI plist's Node missing, not executable, or not checkable (its `stat` fails, say with EACCES) → error; no Node path readable from the plist → warn; CLI plist, executable Node and loaded → ok; anything else → warn; only an error makes `healthy` false. An interrupted `launchctl` run stops the child and waits for it to exit — the kit settles `run` after the child closes — at most 5 s on the Effect clock; an install interrupted inside `bootstrap` then boots out a service loaded from its plist before removing the plist, in an uninterruptible cleanup; only interruption takes this path, so a failed `bootstrap` still just removes the plist. EPIPE on stdout is dropped in `cli/bin.ts`; other stdout errors still crash. Third-party notices come from Vite's built-in `build.license` (no new dependency); it writes only the heading for a package without a LICENSE file, so a test fails on such a section instead of the file noting it. Every bundle the tests start goes through `test/fixtures/bundle.ts`, which builds the whole environment and requires HOME and the launchctl stub under the system temporary directory, with a launchctl path that does not exist by default. A kept `logs/` directory is listed only through its entries (`logs/keep.txt`, not `logs, logs/keep.txt`). | Only an interrupted `bootstrap` is undone: an interrupt during the repeat install's `bootout` or during `uninstall`'s `bootout`, and a `bootstrap` that hits the kit's 15 s timeout, leave launchd as it is, as before. The bundle test of the interrupted bootstrap cannot tell a missing exit wait apart (the stub is released milliseconds after the signal); the module test with a scripted child does. The macOS app copies only `snorlax.mjs`, so the app bundle does not carry `THIRD_PARTY_LICENSES.md` yet. The busy test covers a reader holding its lock across a refresh's COMMIT; the reverse direction cannot be driven deterministically. #13's owner check of `doctor` and `uninstall` against the real launchd is still to run. |
| 5 | merged | #21 | agent-kit and agent-kit-collab 0.22.0 in the catalog, with `effect`, `@effect/platform-node` and the `@effect/platform-node-shared` override at 4.0.5, the kit's `peerDependencies.effect`; the `vite` alias follows `vite-plus` to 1.3.0. `core/buckets` prices each record with the kit's `priceRecord(record, pricing)` and the local `splitByModel` is gone: the agent's own amount first, the split, the multiplier and one-hour cache writes are the kit's rules, and snorlax keeps only the bucket key, `sessionsStarted` and the division of a record's requests among its parts (the Batch 2 rule, unchanged; the kit gives a part only its own share's `modelCalls`). A part without a cost adds its requests to `unpricedRequests` and nothing to `costUsd`. The pricing is `createPricing(litellmPrices)` with no overrides or fallbacks, created once per run in the ledger module's `commitScan` and passed to core's accumulator, because that flow is where records are priced and where `pricing_version` is written, in the same transaction. `meta.pricing_version` is the version that priced the stored buckets: a ledger's first scan (`last_scan_completed_at` still NULL before the commit) writes `litellmPricesVersion`, a refresh keeps a recorded version, and only `rebuild --days 30` writes the current one (a shorter rebuild leaves older days of the snapshot window at their old prices, so it keeps the version and `status` keeps suggesting the full rebuild). A ledger scanned before Batch 5 keeps its NULL version on refresh, because its older buckets were priced by no table; the rule settles that upgrade instead of a note to run the rebuild by hand. `status.pricingChanged` comes from `readLedgerStatus`: true when the ledger has been scanned and its version is not the bundled one (NULL included), false without a ledger or before its first scan, so a fresh install reads false after its first refresh and a pre-Batch-5 ledger reads true until `rebuild --days 30`; the human output adds a `pricing:` line naming `snorlax rebuild --days 30` only then. `uninstall --json` returns `UninstallResult` (#19): `keptEntries` lists the entries `--data` kept, as the human output does, and is `[]` when the directory was removed; without `--data` it is absent, so an untouched data directory does not read as nothing kept. Test expectations for models the kit's snapshot prices (`claude-opus-5-5`, `claude-haiku-4-5`) are computed from `litellmPrices` by `test/fixtures/pricing.ts`, so a price change in a kit release does not break them; `gpt-6.2` and the Grok fixture models are not in the snapshot and stay unpriced. Cold start of `snorlax status --json` (median of 20 alternating runs, fresh temporary `HOME` each, one machine): 80.7 ms on the bundle of main 58a973a, 81.2 ms here; `dist/snorlax.mjs` 1,027,096 → 1,073,148 bytes. | Ids with a reasoning suffix (`claude-opus-4-8-thinking`, `gpt-5.6-sol-high`, `deepseek-v4-pro-thinking`) are not the same model to the kit's table and are unpriced without a fallback; the M2 comparison found none in the owner's logs of the last 30 days. `pricingChanged` compares versions only, so a kit release whose snapshot changed no price the ledger used still reports it. The app decodes `pricingChanged` but does not show it. |
| — (kit 0.23.0 upgrade) | merged | #22 | agent-kit and agent-kit-collab 0.23.0 in the catalog. A request whose total input — cache reads and writes included — strictly exceeds the model's long-context threshold bills whole at the tier's rates (`Price.longContext`); the tier is judged per part, and a part counts as one request only when the record's granularity is `request` or the record's or that part's `modelCalls` is 1, so any other part of a `turn`/`session` record — `modelCalls` absent included — keeps the base price. Claude Code `<synthetic>` entries yield no record. `litellmPricesVersion` now digests the table's content, so the upgrade moves `PRICING_VERSION` and every scanned ledger reads `pricingChanged` until `snorlax rebuild --days 30`, which is expected: its buckets were priced at base rates and still count the `<synthetic>` requests an older kit turned into records. New tests: the tier through `accumulateRecord` (`gpt-6.1-sol`, 272k threshold), the synthetic entry through a Claude Code refresh fixture; both fail on 0.22.0. | Models the LiteLLM table does not price stay unpriced; the owner cannot supply a price yet (#23). |
| 6 | PR open; Batch 6b reworks it on the same branch before merge | #27 | The admin token is compared by hashing both sides with `crypto.subtle.digest("SHA-256")` and walking the two fixed-length digests with no early exit, because `crypto.subtle.timingSafeEqual` exists only in workerd and the handler runs on Node for tests and self-hosting. The handler and everything below it uses only cross-runtime APIs (`URLPattern`, `crypto.getRandomValues`, `crypto.subtle.digest`, `btoa`); `src/index.ts` is the only Workers-specific file, and the node:sqlite adapter of the D1 subset is production code under `src/` (exported as `./sqlite-d1`), so a later self-hosted server can reuse them (section 7). The error body's codes are enumerated in the protocol (`invalid-body` 400, `unauthorized` 401, `forbidden` 403, `not-found` 404, `conflict` 409, `payload-too-large` 413, `internal` 5xx), unlike the CLI's open failure-code string. A push answers `base + row count`, where `base` is read by the batch's first statement (`SELECT COALESCE(MAX(seq), 0)`), so the number comes from inside the batch's transaction and never counts a concurrent push; the batch still ends with the `devices` update (3.3.3), and a read inside the batch sees the batch's earlier writes. A row whose `deviceId` differs from the path id is 403, the same rule as a foreign path (S9). Re-registering a revoked id returns 201 with a fresh token and clears `revoked_at`, keeping `created_at` and `last_push_at` so the usage history stays (R11). `DELETE` of an unknown id is 404, which keeps the section 7 secret-survival check (any non-401) unambiguous; deleting an already revoked device stays 204. D1 timestamps are epoch milliseconds (the ledger's convention); `GET /v1/devices` renders them as ISO `Z` strings, null before the first push. The HTTP shapes get no JSON Schema export, fixtures or Swift types (3.2.3): the app has no HTTP client (2.1). Unit tests sit next to the file they test (`src/http.test.ts`, `src/sqlite-d1.test.ts`); the handler tests that go through HTTP and the database stay in `test/`, with the shared backend helper in `test/fixtures/` (AGENTS.md). `cf dev --port N` passes the port through as a direct flag; the `--`-forwarded form validated under `--dry-run` but still bound 8787. Fix round 1 (review, no blocking findings): registration is one atomic `INSERT … ON CONFLICT (id) DO UPDATE … WHERE devices.revoked_at IS NOT NULL` statement whose `meta.changes` (0 → 409) leaves no read-then-write race for two concurrent registrations, so the adapter reports real change counts (`run` for statements without result columns, `all` otherwise, in `run`/`all` and per batch statement). A body over 1 MB is refused by its declared `Content-Length` and, while chunks stream in, by its actual bytes — the reader cancels at the limit instead of draining the body. An unexpected error answers a fixed `internal error` body and logs the original with `console.error` instead of echoing it. Pull query values must be plain decimal integer strings (`0x10`, `1e1`, `-1`, `1.5`, empty all read 400) with `after` ≥ 0 and 1 ≤ `limit` ≤ 1000 (default 1000). `RequestFailure` takes only the code and message; the status comes from a `Record<HttpErrorCode, number>` that fails to compile when a code is missing, and the class is not exported. A batch's rollback runs only while a transaction is open and never replaces the original error — a failing rollback is reported on top of it with the original error as its `cause`. | Owner steps remain: create the database, apply the migration, deploy with the secrets file (3.12), and record reachability in section 7. The push's first-statement read and `MAX(seq)` semantics ran against the node:sqlite adapter; real D1's batch order is documented to match but is only exercised by the owner's deploy. The admin token on device endpoints reads 401 — only device tokens list devices and buckets. The collector bundle's hash moved with no behavior change (the shared bucket field shape of the lenient and strict schemas; the HTTP shapes tree-shake out) — no changeset: the bundle only gains unreachable zod code from the protocol's HTTP shapes until Batch 7's sync client uses them. |
| 6b | not started | #27 (same branch) | | |
| 7 | not started | | | |
| 8 | not started | | | |

## 7. Risks, open questions, and follow-up

| Item | Type | Impact | Owner | Next step |
| --- | --- | --- | --- | --- |
| App Group or `SMAppService` unusable with free signing | resolved | — | owner | S1 confirmed both work with a free Personal Team; a Developer ID is needed only to hand a build to another Mac without building there |
| Agents change their log formats | risk | usage under-counted | maintainer | decoders live in agent-kit; `failuresByAgent` surfaces it |
| D1 free limits exceeded | risk | writes fail until 00:00 UTC | owner | 8.2 estimate; dirty buckets wait for the next day |
| Node path changes (version managers) | risk | collection stops | maintainer | app rediscovers Node; `doctor`; Node SEA later |
| Logs older than 30 days are gone | constraint | `rebuild` beyond 30 days would lose usage | — | `rebuild` capped at 30 |
| Snorlax is a trademark | risk | rename request | owner | original artwork, disclaimer in README |
| S1 results | resolved | signing path | owner | Owner run on 2026-10-23 with a free Personal Team (Xcode 27.1): the App Group container is available as `<TeamID>.io.github.perfectpan.snorlax`; the widget appears in the gallery and shows the snapshot; `SMAppService` registration is enabled (`launchctl print` shows the job submitted by smd, 129 runs, last exit code 0, every 300 s). A signed build needs the launcher as a compiled helper (Batch 4 fix). No provisioning profile was generated, so a bundle-id collision with a second Apple ID is checked in Batch 8 |
| M2 results | resolved | cost totals | owner | Run on 2026-10-25 with the app built from main 1658c6f (agent-kit 0.23.0): `status` reported `pricingChanged`, `snorlax rebuild --days 30` repriced 89,352 records with no failures and cleared it. For the finished days 2026-10-18 to 2026-10-24, daily cost and tokens per agent match `ccusage claude daily` and `ccusage codex daily` (ccusage 20.0.44) to the cent, with one exception: Codex on 2026-10-18, where snorlax counts 0.007% more tokens and $321.00 against $320.83; the cause was not investigated and the owner accepted it. In the last 30 days only requests to two models the LiteLLM table does not price are unpriced (#23). Buckets older than 30 days, written by an M1 build, keep their unpriced requests because `rebuild` stops at 30 days; no window the app shows reaches them, and M3 decides whether sync sends them |
| Second Mac under another Apple ID | open | bundle id may already be registered to the first team | owner | Batch 8: build on the second Mac; if Xcode rejects the bundle id, make the prefix configurable in `project.yml` |
| S2 results | pending owner run | refresh interval and performance target | owner | On each machine, run `node scripts/measure-scan.ts`. It reads local agent homes (full: `since` 0 and no state; incremental: the saved state and `since` = now − 2 h) and prints one JSON object of counts only. Paste that JSON here. The refresh interval stays 300 s until the numbers are recorded. |
| Worker reachability | open | domain | owner | record here after Batch 6 |
| `cf` and `cloudflare.config.ts` are in beta | risk | a `cf` release changes commands, the configuration format or Build Output | maintainer | `cf` and `wrangler` are pinned exactly and upgraded on purpose; Wrangler with `wrangler.jsonc` stays a fallback, since both use the same D1 migration table (3.12) |
| `ADMIN_TOKEN` across deploys | open | if a deploy without `--secrets-file` drops the secret, `pair` and revocation answer 401 | owner | after the second deploy, send `DELETE /v1/devices/<an unused id>` with the admin token: any answer other than 401 means the secret was kept; otherwise every deploy passes the file (3.12) |
| Buckets older than 30 days on the first push | open | pairing marks every local bucket dirty (3.4.2), including the M1 buckets of 2026-09-23 to 09-25 that no rebuild can reprice (M2 results); no window shows them, so they cost writes and storage only | owner | decide before Batch 7: push them, so the backend stays a full copy of the ledger, or push only the last 30 days |
| K1, K2 in agent-kit | resolved | — | agent-kit maintainer | Released in agent-kit 0.22.0 (`/cost/prices`, `priceRecord`); Batch 5 pins it |
| Presence on this collector | follow-up | — | owner | separate Spec and Plan (8.3) |
| Self-hosted backend | follow-up | — | owner | The Hono app and the node:sqlite D1 adapter run on Node too (3.12.1), so a Node server (`@hono/node-server`) on a SQLite file could serve the same HTTP API later; not planned now (owner, 2026-10-26) |
| Several users per backend | follow-up | — | owner | Out of scope (1.4). The change stays additive: a `users` table, `devices.user_id` defaulting to one user, pulls filtered by user (a `(user_id, seq)` index, or a join on `devices` to avoid a backfill), and `ADMIN_TOKEN` redefined as a server or per-user enrollment token; device endpoints and bodies keep their shape. Needs its own Spec and Plan |

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
