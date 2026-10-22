# macOS app (S1 spike)

Batch 0 S1. Batch 4 grows this directory into the menu bar app in plan section 3.11.
The generated `Snorlax.xcodeproj` is not committed.

## Layout

- `project.yml` — XcodeGen spec. Targets `Snorlax` (macOS 14+, `LSUIElement`, bundle id `io.github.perfectpan.snorlax`) and `SnorlaxWidget`.
- `Snorlax/` — SwiftUI `MenuBarExtra`. Not sandboxed.
- `SnorlaxWidget/` — WidgetKit extension, bundle id `io.github.perfectpan.snorlax.widget`, sandboxed.
- `SnorlaxKit/` — shared JSON value and App Group id. Batch 4 puts generated snapshot types here.
- `Helpers/snorlax` — `/bin/sh` launcher, copied to `Contents/Helpers/snorlax`. Git stores the executable bit; the copy keeps it.
- `LaunchAgents/io.github.perfectpan.snorlax.refresh.plist` — copied to `Contents/Library/LaunchAgents/`.

## Behavior

The menu bar and the widget show one string from `spike-value.json` in the App Group container. The file is a JSON object with a string field `value`, for example `{"value":"812M"}`. When the container exists and the file is missing, the app writes `{"value":"0"}`. A file that does not decode is left in place and the menu shows the error. The widget only reads. The menu bar label is the value, or `Snorlax` when the container is unavailable. The menu refreshes the file every 2 seconds so an edit is visible; Batch 4 replaces that timer with the data-directory watch from plan 3.11. The widget timeline is one entry with policy `.after(now + 15 min)`. Adding the widget uses the snapshot, so the gallery shows the file's current value. The widget kind is `io.github.perfectpan.snorlax.spike`.

The App Group entitlement on both targets is `$(TeamIdentifierPrefix)io.github.perfectpan.snorlax`. Both Info.plists write the expanded value to `AppGroupIdentifier`. The app and the widget read that key, so the id passed to `containerURL` matches the signed entitlement. With no team, the prefix is empty and the id is `io.github.perfectpan.snorlax`.

The menu button Register login item calls `SMAppService.agent(plistName: "io.github.perfectpan.snorlax.refresh.plist")`. Launching the app does not. `register()` bootstraps the agent immediately (`SMAppService.h`), and the plist sets `RunAtLoad` and `StartInterval` 300, so the launcher runs at once and then every 300 seconds. The plist sets `BundleProgram` to `Contents/Helpers/snorlax` and `ProgramArguments` to `snorlax`, `refresh`. Unregister login item calls `unregister()`. Open Login Items Settings calls `SMAppService.openSystemSettingsLoginItems()`.

The launcher resolves the data directory as `SNORLAX_HOME`, or `~/Library/Application Support/snorlax` when that is unset. It reads `<data>/node-path` when that file's first line is an executable path. Otherwise it uses the first `node` in `/opt/homebrew/bin:/usr/local/bin:/usr/bin`. It does not search `PATH` or a login shell. It then runs one `node -e` line that writes `<data>/spike-run.json` containing `{"ok":true}`. Batch 4 replaces that line with the bundled collector and adds the app's `/bin/zsh -lc 'command -v node'` discovery, which writes `node-path` when it is missing or older than Node 22.13.

## Local verification (no Apple ID)

`project.yml` uses Automatic signing and an empty team, so opening the project in Xcode asks for a team. A compile without an Apple ID overrides signing on the command line:

```bash
cd apps/macos
xcodegen generate
xcodebuild -project Snorlax.xcodeproj -scheme Snorlax -configuration Debug \
  -destination 'generic/platform=macOS' \
  -derivedDataPath DerivedData \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY=- \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGNING_ALLOWED=NO \
  DEVELOPMENT_TEAM= \
  build
```

On this machine (Xcode 27.0, macOS 27.0.1) that command ended with `** BUILD SUCCEEDED **`. The first `xcodebuild` failed to load `IDESimulatorFoundation` against a stale `/Library/Developer/PrivateFrameworks/DVTDownloads.framework`. `xcodebuild -runFirstLaunch` completed, and the command above then succeeded. That was machine setup, not a project change. Xcode also prints `Metadata extraction skipped, no AppIntents.framework dependency found`. The spike has no App Intents; the build still succeeds.

Checked on `DerivedData/Build/Products/Debug/Snorlax.app`:

- `Contents/MacOS/Snorlax` and `Contents/PlugIns/SnorlaxWidget.appex` are universal Mach-O executables (arm64 and x86_64).
- `Contents/Helpers/snorlax` is mode `755` and matches `Helpers/snorlax`.
- `Contents/Library/LaunchAgents/io.github.perfectpan.snorlax.refresh.plist` has `BundleProgram` `Contents/Helpers/snorlax`, arguments `snorlax` and `refresh`, `StartInterval` 300, and `RunAtLoad` true.
- App `Info.plist`: `LSUIElement` true, bundle id `io.github.perfectpan.snorlax`, minimum system version 14.0. `AppGroupIdentifier` is `io.github.perfectpan.snorlax` because `TeamIdentifierPrefix` was empty.
- Widget `Info.plist`: extension point `com.apple.widgetkit-extension`, the same App Group id, bundle id `io.github.perfectpan.snorlax.widget`.
- `codesign -dv`: `Signature=adhoc`, flags `adhoc,linker-signed`, `TeamIdentifier=not set`, `Info.plist=not bound`. No entitlements are embedded. `SMAppService.h` says these APIs require a code-signed app, so this binary cannot answer the signing questions.

The launcher was run directly. Each temporary home was removed afterwards. On this machine `node` is not in the three fixed directories (it is on `PATH` through a version manager).

- No `node-path`: exit 1, stderr `snorlax: node not found (checked node-path, then /opt/homebrew/bin:/usr/local/bin:/usr/bin)`, no `spike-run.json`. `PATH` still contained `node`.
- `SNORLAX_HOME` `node-path` naming an executable, and a different executable `node-path` under the temporary `HOME`: exit 0, the `SNORLAX_HOME` executable ran, `<SNORLAX_HOME>/spike-run.json` was `{"ok":true}`, and the `HOME` data directory had no spike file.
- `node-path` naming a non-executable file: exit 1, the same not-found message, no spike file.
- `node-path` under `$HOME/Library/Application Support/snorlax` naming an executable Node: exit 0, `spike-run.json` was `{"ok":true}`.

`swift test` in `SnorlaxKit`: `SpikeValueTests`, 3 tests, 0 failures.

The app was not launched. `register()` was not called. `~/Library/LaunchAgents/io.github.perfectpan.snorlax.refresh.plist` and `~/Library/Application Support/snorlax` were absent before and after. `launchctl print gui/<uid>/io.github.perfectpan.snorlax.refresh` could not find the service, before and after. `xcodebuild` does run `lsregister` on the built app. That records the bundle with Launch Services. It is not `SMAppService` registration.

Not verified here, and not implied by the green build: whether `containerURL` returns the App Group, whether `SMAppService` registration stays enabled, and whether the widget appears in the gallery.

## Owner run (free Personal Team)

A nil container from the unsigned build is not evidence that a Personal Team cannot use App Groups. Turn signing on before answering the three questions.

1. Xcode is installed. `xcodegen` is on `PATH`. Node.js is 22.13 or later (`node --version`).
2. From the repository root:

```bash
cd apps/macos
xcodegen generate
open Snorlax.xcodeproj
```

`xcodegen generate` rewrites `Snorlax.xcodeproj` from `project.yml` and drops unsaved signing edits. Set the team again after a regenerate.

3. Xcode → Settings… → Accounts. Sign in with the Apple ID if needed. Select that Apple ID, then Personal Team, and note the 10-character Team ID.
4. In the project navigator select the Snorlax project, then the Snorlax target, then Signing & Capabilities.
   - Leave Automatically manage signing on.
   - Team: Personal Team.
   - The App Groups entitlement must list `$(TeamIdentifierPrefix)io.github.perfectpan.snorlax`. If the capability is not on the tab, click + Capability, add App Groups, and add that group. `Snorlax/Snorlax.entitlements` already contains it. If Xcode asks to register the group on the team, allow it.
   - Leave App Sandbox off. Plan 3.11: the main app is not sandboxed.
5. Select the SnorlaxWidget target, Signing & Capabilities.
   - Same Personal Team and Automatically manage signing.
   - App Sandbox stays on. `SnorlaxWidget/SnorlaxWidget.entitlements` sets it.
   - The same App Group. After the team prefix, the id must match the app target, including the dot.
6. Scheme: Snorlax. Product → Run. There is no Dock icon (`LSUIElement`). The menu bar shows `Snorlax` until a value loads, then the value.
7. Open the menu.
   - The App Group id should be `<TeamID>.io.github.perfectpan.snorlax`. If it is only `io.github.perfectpan.snorlax`, this process is not signed with the team. Fix signing before recording a result.
   - A file path means the container works. The app writes `spike-value.json` there when the file is missing (`{"value":"0"}`). Replace it with `{"value":"812M"}` and save. Within about 2 seconds the menu label becomes `812M`. Record: App Group works.
   - The text "App Group container is unavailable for this signature" means record: App Group does not work with this Personal Team. Plan 3.11 then uses the home-relative read-only temporary exception for the widget. Do not use the login item to debug the container.
8. Widget gallery: right-click the desktop, choose Edit Widgets, search for Snorlax, and add the small or medium size. Do step 7 first so the file exists. The widget does not create it. The added widget should show the same string as the menu. A later edit is read at the next timeline reload (15 minutes) or when the widget is removed and added again. If Snorlax is absent from the gallery, record that. Do not copy the `.appex` into another folder.
9. Login item. The spike does not write `node-path`. If `node` is not in `/opt/homebrew/bin`, `/usr/local/bin`, or `/usr/bin`, write the path before registering or the agent will fail on every run:

```bash
mkdir -p "$HOME/Library/Application Support/snorlax"
command -v node > "$HOME/Library/Application Support/snorlax/node-path"
node --version
```

The version must be 22.13 or later. The file is one line, the absolute path of that executable.

10. In the menu, click Register login item.
    - The agent starts immediately and then every 300 seconds. It writes `~/Library/Application Support/snorlax/spike-run.json` (`{"ok":true}`). It does not read agent logs.
    - If the status is `requires approval in System Settings`, click Open Login Items Settings, allow the item, then close and open the menu to read the status again.
    - Record whether the status becomes `enabled` and whether `spike-run.json` appears. If `register()` throws, the menu shows the error. Record that text.
11. Click Unregister login item when the check is finished. Confirm the service is gone:

```bash
launchctl print "gui/$(id -u)/io.github.perfectpan.snorlax.refresh"
```

The print should say the service could not be found. Do not copy the plist into `~/Library/LaunchAgents`. If the app or the plist changes after a successful registration, unregister and register again. `SMAppService.h` requires re-registration when the plist or the executable changes.

12. Write the three answers on the `S1 results` row in `docs/plans/0001-snorlax.md` section 7: App Group container, `SMAppService` registration, widget gallery. Replace `pending owner run`.

Command-line build with the team, from `apps/macos`. Replace `TEAMID` with the id from step 3:

```bash
xcodebuild -project Snorlax.xcodeproj -scheme Snorlax -configuration Debug \
  -destination 'generic/platform=macOS' \
  -derivedDataPath DerivedData \
  DEVELOPMENT_TEAM=TEAMID \
  CODE_SIGN_STYLE=Automatic \
  CODE_SIGN_IDENTITY="Apple Development" \
  CODE_SIGNING_REQUIRED=YES \
  CODE_SIGNING_ALLOWED=YES \
  build
```

Run from Xcode so the menu is visible. The product is `DerivedData/Build/Products/Debug/Snorlax.app`.

To run the bundled launcher without registering a login item, from `apps/macos`:

```bash
H=$(mktemp -d)
printf '%s\n' "$(command -v node)" > "$H/node-path"
SNORLAX_HOME="$H" "DerivedData/Build/Products/Debug/Snorlax.app/Contents/Helpers/snorlax"
s=$?
cat "$H/spike-run.json"
rm -rf "$H"
exit $s
```

The file should contain `{"ok":true}`.

## Batch 4

- Replace `SpikeValue` and `spike-value.json` with the generated snapshot and the App Group copy of `snapshot.json`.
- Replace the `node -e` line with `exec` of `Contents/Resources/collector/snorlax.mjs`.
- Write `node-path` from the login-shell discovery in plan 3.11 before the login item is useful on a machine that only has a version-manager Node.
- Replace the 2 second timer with the directory watch and the 60 second fallback.
- Add the rest of plan 3.11 except pairing, which is Batch 8.

If this spike widget was added to the desktop, remove it before installing the Batch 4 widget. The kind string changes with that replacement.
