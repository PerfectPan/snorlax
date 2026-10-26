---
"@rivus/snorlax": minor
---

Refresh and rebuild report `sync.state` (`ok`, `failed`, `unpaired`, `revoked`) and, when a sync fails or the device is revoked, an optional `sync.message` with the reason. A missing keychain item is `unpaired`. Only a keychain that cannot be read fails the sync (`failed`); the command still exits 0 with the snapshot written. A pull page whose `next` does not move past `after` fails the sync instead of looping. When `config.json` has an https backend URL (http only for localhost, 127.0.0.1, or [::1]) and this device's token can be read, they push dirty hourly buckets and pull other devices' buckets into the snapshot.

`snorlax pair` registers this device with a backend, stores the device token in the keychain, marks local buckets dirty and resets remote rows, then writes the pairing into `config.json`. That write is what counts as paired. A refresh that fails afterwards still exits 0. `snorlax unpair` drops the local pairing and keeps the data. `doctor` checks the keychain and the backend when a URL is configured. `uninstall --data` deletes the keychain item.
