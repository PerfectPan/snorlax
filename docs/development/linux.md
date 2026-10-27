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

Until `@rivus/snorlax` is published to npm, build it from a clone instead. Building needs Node.js `^24.22.0` and
pnpm 12 (the root `package.json`'s `devEngines` and `packageManager`); the built CLI runs on Node `>= 22.13`.

```bash
git clone https://github.com/PerfectPan/snorlax.git
cd snorlax
pnpm install
pnpm --filter @rivus/snorlax run build
mkdir -p ~/.local/bin
ln -sf "$PWD/packages/collector/dist/snorlax.mjs" ~/.local/bin/snorlax
```

`~/.local/bin` must be on `PATH`. The timer runs the link, which points into this clone, so keep both. After
`git pull`, run `pnpm install` and the build again; `snorlax install` does not need to run again.

## Schedule refresh

```bash
snorlax install
```

`snorlax install` does the following:

1. Refuses to continue when the data directory is not an absolute path, or when `snorlax-refresh.timer` is already
   loaded from a unit file this command did not write.
2. Creates the data directory if it is missing.
3. Writes two user units, mode `0644`, in the systemd user manager's configuration directory:
   - `<manager-config>/systemd/user/snorlax-refresh.service`
   - `<manager-config>/systemd/user/snorlax-refresh.timer`

   `<manager-config>/systemd/user` is the user configuration entry in `systemctl --user show --property=UnitPath`:
   the first path under the user's home whose last two segments are `systemd` and `user`. The XDG data entry
   (`…/share/systemd/user`), `user.control`, generator and transient directories, and any path outside the home are
   not used. There is no fallback to `~/.config` or to the shell's `XDG_CONFIG_HOME`. If that entry is missing, or
   the query fails or does not parse, install writes nothing.
4. The service is `Type=oneshot`, because `refresh` exits. `ExecStart` is three arguments: the absolute path of the
   Node that ran `snorlax install`, the absolute path the CLI was started from (`snorlax.mjs`, or the link to it),
   and `refresh`. systemd does not expand `$` in the program (the Node path) and does not collapse `$$` there, so
   that word leaves `$` as written. The second argument doubles `$`, because later arguments expand `$VAR` and
   `${VAR}`. The service always sets `Environment=SNORLAX_HOME` to the absolute data directory this install resolved,
   so the timer and that CLI use the same directory whether it came from `SNORLAX_HOME`, `XDG_DATA_HOME`, or the
   default. Standard output and standard error are discarded. The refresh summary is appended to
   `<data-directory>/logs/snorlax.log`.
5. The timer waits `OnBootSec=1min` after the machine boots. `OnStartupSec` would measure from the user manager's
   start; this timer uses `OnBootSec`. It then runs every `OnUnitActiveSec=5min`. The `[Install]` section is
   `WantedBy=timers.target`, which is what `systemctl enable` installs.
6. Runs `systemctl --user daemon-reload`, then `systemctl --user enable --now snorlax-refresh.timer`.

`AccuracySec` and `Persistent` are left at systemd's defaults. The default accuracy is one minute, so a run can
start up to a minute after it was due. `Persistent` defaults to false, so a timer that elapses while the user
manager is stopped does not run a catch-up when the manager starts again.

Repeating `snorlax install` rewrites both units, reloads, and enables the timer again. If enable fails, snorlax
disables the timer when this install is the unit systemd loaded. When that check cannot run, it still runs
`disable --now`: ownership was confirmed before the units were written, and a stuck manager will likely time the
check out too. It then deletes the units just written and reloads. `enable --now` enables and then starts, so a
start failure or a timeout can leave the timer enabled; the disable removes that before the unit files go.

The `systemctl` binary is `/usr/bin/systemctl` unless `SNORLAX_SYSTEMCTL` names another path.

A user timer runs in that user's systemd manager. It stops when the user logs out, unless lingering is enabled for
the account (`loginctl enable-linger`). snorlax does not enable lingering. On a machine that has already been up
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

Pairing on Linux needs `secret-tool` (libsecret), which stores the device token. If `secret-tool` is not
installed, a token stored earlier cannot be read or deleted. `unpair` and `uninstall --data` still complete,
and they say the program could not be found and that a stored token was not deleted. A refresh reports the
device as not paired and includes that reason. `doctor` says the same. `pair` still needs `secret-tool` to
store the token. The steps are in [pairing.md](pairing.md).
