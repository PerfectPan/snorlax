---
"@rivus/snorlax": patch
---

The scheduled refresh no longer stops when the Node it was installed with is removed. `snorlax install` writes a `refresh.sh` launcher into the data directory — seeded with the running Node's path — and the LaunchAgent and systemd unit start `/bin/sh refresh.sh`, which resolves Node at run time: `node-path` first (Snorlax.app keeps it current), then the fixed fallbacks. `doctor` reports a missing launcher script or no Node anywhere the launcher looks as the errors that stop the schedule, and `uninstall --data` deletes the launcher with the rest.
