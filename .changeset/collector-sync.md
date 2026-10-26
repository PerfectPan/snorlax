---
"@rivus/snorlax": minor
---

Refresh and rebuild report `sync.state` (`ok`, `failed`, `unpaired`, `revoked`). When `config.json` has a backend URL and this device's token can be read, they push dirty hourly buckets and pull other devices' buckets into the snapshot.
