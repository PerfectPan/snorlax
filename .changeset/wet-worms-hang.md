---
"@rivus/snorlax": patch
---

Fix collector review leftovers: `uninstall --data` deletes only a snorlax data directory and no longer rewrites its log afterwards, `doctor` checks the scheduled refresh and the Node it runs, `status` waits for a committing refresh instead of failing, an interrupted `install` boots out a service its bootstrap already loaded, a closed stdout no longer ends in an EPIPE stack, and the package ships the license notices of the dependencies it bundles.
