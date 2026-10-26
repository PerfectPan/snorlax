# Linux install

The collector on Linux is the `snorlax` command-line tool. It reads the logs the coding agents already write, keeps a
local ledger, and — after `snorlax install` — refreshes that ledger on a systemd user timer. There is no menu-bar
app on Linux. Pairing with a Worker is a separate step; this page only says what that step needs.

## Node.js

`@rivus/snorlax` requires Node.js `>= 22.13` (the `engines` field of `packages/collector/package.json`). Install a
Node that satisfies that range and check it with `node -v` before installing the package. The Node you use for
`snorlax install` is the Node the timer will run: the unit file stores that binary's absolute path.

## Install the CLI

```bash
npm i -g @rivus/snorlax
```

## Schedule refresh

```bash
snorlax install
```

`snorlax install` does the following:

1. Refuses to continue when the data directory is not an absolute path, or when `snorlax-refresh.timer` is already
   loaded from a unit file this command did not write.
2. Creates the data directory if it is missing.
3. Writes two user units, mode `0644`:
   - `${XDG_CONFIG_HOME:-~/.config}/systemd/user/snorlax-refresh.service`
   - `${XDG_CONFIG_HOME:-~/.config}/systemd/user/snorlax-refresh.timer`

   A relative or empty `XDG_CONFIG_HOME` is ignored, and `~/.config` is used instead. That is the XDG base-directory
   rule.
4. The service is `Type=oneshot`, because `refresh` exits. `ExecStart` is three arguments: the absolute path of the
   Node that ran `snorlax install`, the absolute path of that install's `snorlax.mjs`, and `refresh`. When
   `SNORLAX_HOME` is set to a non-empty value, that value is copied into a single `Environment=` line so the timer
   uses the same data directory. Standard output and standard error are discarded. The refresh summary is appended
   to `<data-directory>/logs/snorlax.log`.
5. The timer waits `OnBootSec=1min` after the user manager starts (this is not machine boot), then runs every
   `OnUnitActiveSec=5min`. The `[Install]` section is `WantedBy=timers.target`, which is what
   `systemctl enable` installs.
6. Runs `systemctl --user daemon-reload`, then `systemctl --user enable --now snorlax-refresh.timer`.

`AccuracySec` and `Persistent` are left at systemd's defaults. The default accuracy is one minute, so a run can
start up to a minute after it was due. `Persistent` defaults to false, so a timer that elapses while the user
manager is stopped does not run a catch-up when the manager starts again.

Repeating `snorlax install` rewrites both units, reloads, and enables the timer again. If enable fails, the units
just written are deleted and systemd is reloaded so the next login does not start them.

The `systemctl` binary is `/usr/bin/systemctl` unless `SNORLAX_SYSTEMCTL` names another path.

A user timer runs in that user's systemd manager. It stops when the user logs out, unless lingering is enabled for
the account (`loginctl enable-linger`). snorlax does not enable lingering. On a manager that has already been up
for more than a minute, `enable --now` can treat `OnBootSec` as already elapsed and run `refresh` once immediately.

## Data directory

The data directory is `SNORLAX_HOME` when that variable is set and non-empty, and otherwise
`${XDG_DATA_HOME:-~/.local/share}/snorlax`. It is created at mode `0700`. `snorlax install` and
`snorlax uninstall --data` both require the path to be absolute.

## Status and doctor

`snorlax status` prints the local snapshot. `snorlax doctor` checks the Node version, the data directory,
`config.json`, and the timer. It changes nothing.

A timer that is enabled and active, whose unit names a Node that exists and is executable, is reported as the
systemd user timer running. A missing, non-executable, or uncheckable Node is an error, and only an error makes
`doctor` unhealthy. No timer at all is a warning: until `snorlax install`, the snapshot changes only when something
runs `refresh`.

## Uninstall

```bash
snorlax uninstall
snorlax uninstall --data
```

`snorlax uninstall` disables the timer when it is loaded from this install's unit file, deletes both unit files,
and runs `daemon-reload`. A second uninstall does the same and succeeds when the timer is already gone.

`--data` also deletes the entries snorlax wrote in the data directory (the ledger, the snapshot, the log, and the
files named with them). Entries snorlax did not write are left in place and listed. A directory that is not a
snorlax data directory is not deleted, and the timer is left loaded.

## Pairing

Pairing on Linux needs `secret-tool` (libsecret). The steps are in [pairing.md](pairing.md).
