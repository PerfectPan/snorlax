---
"@rivus/snorlax": patch
---

Price long-context requests at the model's tier rates when a single request's total input exceeds its threshold, and stop counting Claude Code's synthetic API-error entries as requests; after upgrading, run `snorlax rebuild --days 30` to reprice the stored buckets with the new table.
