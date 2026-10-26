---
"@rivus/snorlax": minor
---

On Linux, `snorlax install` and `snorlax uninstall` register a systemd user timer that runs `refresh` every 5 minutes. Windows still has no scheduler.
