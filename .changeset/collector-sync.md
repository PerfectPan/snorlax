---
"@rivus/snorlax": minor
---

Refresh and rebuild report `sync.state` (`ok`, `failed`, `unpaired`, `revoked`) and, when a sync fails or the device is revoked, an optional `sync.message` with the reason. A locked or missing keychain fails the sync and the command still exits 0 with the snapshot written. When `config.json` has an https backend URL (http only for localhost, 127.0.0.1, or [::1]) and this device's token can be read, they push dirty hourly buckets and pull other devices' buckets into the snapshot.
