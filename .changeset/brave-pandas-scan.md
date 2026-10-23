---
"@rivus/snorlax": minor
---

Add the local ledger and the `refresh` and `rebuild` commands: incremental scanning of every agent the kit decodes, hourly usage buckets in a migrated SQLite ledger with backups, the device's snapshot written atomically with today / 7-day / 30-day windows in the device time zone, and agent-logged costs (Pi, opencode, Grok) kept as logged while other requests count as unpriced.
