---
"@rivus/snorlax": minor
"@rivus/snorlax-protocol": minor
---

Expose 180 local days in the snapshot daily series for a token-usage heatmap, while retaining today/7-day/30-day totals. Expand explicit rebuilds to 180 days with the same atomic replace semantics; deleted source logs cannot be recovered and rebuilt missing usage is zeroed, including on synced devices. The heatmap history comes only from stored local and synced aggregate buckets; no extra source-log scan is introduced.
