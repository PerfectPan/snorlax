---
"@rivus/snorlax": patch
---

`snorlax doctor` ends its human output with a verdict line (`doctor: healthy`, or `doctor: 2 problems found (1 error, 1 warning)`), and exits 1 when unhealthy instead of 0 — the `--json` payload is unchanged, so scripts read `healthy` or the exit code.
