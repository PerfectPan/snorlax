---
"@rivus/snorlax": minor
---

Add the collector CLI skeleton: `status`, `doctor` and `snapshot` commands with one-object `--json` outputs and the 0/1/2 exit-code convention, a private (0700) data directory with `config.json`, and a rotated log that redacts home paths. The `@rivus/snorlax-protocol` workspace package adds the zod definitions of the bucket, snapshot and CLI output shapes with committed JSON Schema exports and sample fixtures.
