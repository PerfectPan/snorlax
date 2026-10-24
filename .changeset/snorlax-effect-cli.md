---
"@rivus/snorlax": patch
---

Move the collector CLI onto `effect/cli` (plan 3.13): commands parse with typed flags, the global `--json`
stays one JSON object on stdout in every outcome, and failures keep their failure codes and exit codes.
Alongside the move: the published package no longer lists bundled runtime dependencies (a global install
failed with E404 on the private protocol workspace link), `doctor` reports a missing or mis-permissioned
data directory as a failed check instead of creating it, `status` and `snapshot` create no files,
`snapshot --json` wraps the snapshot as `{ schemaVersion, ok, snapshot }`, and every output — human text
included — passes through the same redaction.
