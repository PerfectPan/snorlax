---
"@rivus/snorlax": minor
---

Add `snorlax install` and `snorlax uninstall` for macOS. `install` registers a LaunchAgent that runs `refresh` every 300 seconds. `uninstall` removes it, and `uninstall --data` also deletes the data directory. On Linux both commands exit with an error until systemd support arrives.
