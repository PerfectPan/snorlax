# macOS app

Menu bar app and desktop widget (plan 3.11, Batch 4). The generated `Snorlax.xcodeproj` is not committed.

## Layout

- `project.yml` — XcodeGen spec. Targets `Snorlax` (macOS 14+, `LSUIElement`, bundle id `io.github.perfectpan.snorlax`), `SnorlaxWidget`, and logic tests `SnorlaxKitTests`.
- `Snorlax/` — SwiftUI `MenuBarExtra` and Settings. Not sandboxed. Launch does not call `SMAppService.register()`.
- `SnorlaxWidget/` — WidgetKit extension, bundle id `io.github.perfectpan.snorlax.widget`, sandboxed. Kind `io.github.perfectpan.snorlax.usage`.
- `SnorlaxKit/` — generated Codable types, snapshot loading, formatting, the collector client, the directory watcher, and the App Group copy. `swift test` runs here.
- `Helpers/snorlax` — `/bin/sh` launcher, copied to `Contents/Helpers/snorlax`.
- `LaunchAgents/io.github.perfectpan.snorlax.refresh.plist` — copied to `Contents/Library/LaunchAgents/`.

There is no Pokémon artwork. The menu bar title is today's token total as text.

## Behavior

The menu title is today's tokens in short form (`812345678` is `812M`). The popover shows today, 7 days, and 30 days (tokens, cost, and the word `unpriced` when that window has unpriced requests), the top agents and models, devices, a 30-day bar chart, and the status line. Buttons: Refresh now, Settings, Quit.

Settings shows the device name from `snorlax status`. No collector command changes the name yet, so the field is read-only; pairing sets it in a later batch. Launch at login is an `SMAppService` toggle for `io.github.perfectpan.snorlax.refresh.plist`. Diagnostics runs `snorlax doctor --json`.

The app watches the data directory (200 ms debounce, 60 s fallback). A snapshot whose `schemaVersion` is newer than 1 is refused with "The collector is newer than the app; update the app." and is not copied. An accepted snapshot is copied to `snapshot.json` in the App Group container, then `WidgetCenter.reloadAllTimelines()` runs.

The widget reads that copy. Small: today's tokens and cost. Medium: today, 7 days, and the top three agents. One timeline entry, policy `.after(now + 15 minutes)`. The S1 owner run is still pending, so the widget does not use the home-relative read entitlement.

On launch, when `<data>/node-path` is missing or its Node is older than 22.13, the app runs `/bin/zsh -lc 'command -v node'` (5 s timeout), checks the version, and writes `node-path`. When none is found, the menu shows "Install Node.js 22.13 or later". `<data>` is `SNORLAX_HOME`, or `~/Library/Application Support/snorlax`.

The launcher reads `node-path`, otherwise the first `node` in `/opt/homebrew/bin:/usr/local/bin:/usr/bin`. It does not search `PATH`. It then execs `Contents/Resources/collector/snorlax.mjs`. An Xcode build phase runs `pnpm --filter @rivus/snorlax run build` and copies `packages/collector/dist/snorlax.mjs` to that path. `pnpm` must be on `PATH` or in `/opt/homebrew/bin` or `/usr/local/bin`.

Swift types are generated from `packages/protocol/schema` by `pnpm --filter @rivus/snorlax-protocol run generate:swift`. Do not edit `SnorlaxKit/Sources/SnorlaxKit/Generated/Protocol.swift`.

The App Group entitlement on the app and the widget is `$(TeamIdentifierPrefix)io.github.perfectpan.snorlax`. Both Info.plists write the expanded value to `AppGroupIdentifier`. With no team, the prefix is empty and the id is `io.github.perfectpan.snorlax`.

`register()` bootstraps the login item immediately. Only the Settings toggle calls it.

## Local verification (no Apple ID)

`project.yml` uses Automatic signing and an empty team. A compile without an Apple ID overrides signing:

```bash
cd apps/macos
xcodegen generate
xcodebuild -project Snorlax.xcodeproj -scheme Snorlax -configuration Debug \
  -destination 'platform=macOS' \
  -derivedDataPath DerivedData \
  CODE_SIGN_STYLE=Manual \
  CODE_SIGN_IDENTITY=- \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGNING_ALLOWED=NO \
  DEVELOPMENT_TEAM= \
  test
```

`test` builds the app (and bundles the collector) and runs `SnorlaxKitTests` without launching Snorlax. `swift test` in `SnorlaxKit` runs the same tests. Do not run the app from this unsigned build if the goal is to avoid writing `~/Library/Application Support/snorlax`: launch discovers Node and creates that directory when `SNORLAX_HOME` is unset.

To run the bundled launcher without registering a login item, point `SNORLAX_HOME` at a temporary directory and remove it afterwards:

```bash
H=$(mktemp -d)
printf '%s\n' "$(command -v node)" > "$H/node-path"
SNORLAX_HOME="$H" "DerivedData/Build/Products/Debug/Snorlax.app/Contents/Helpers/snorlax" status --json
s=$?
rm -rf "$H"
exit $s
```

## Owner run (free Personal Team)

Turn signing on before answering whether the App Group works, whether `SMAppService` registration stays enabled, and whether the widget appears in the gallery. A nil container from the unsigned build is not evidence.

1. Xcode and `xcodegen` are installed. Node.js is 22.13 or later. `pnpm` is on `PATH`.
2. From `apps/macos`: `xcodegen generate`, then `open Snorlax.xcodeproj`. Regenerating drops unsaved signing edits.
3. Xcode → Settings… → Accounts. Select the Personal Team and note the Team ID.
4. Snorlax target → Signing & Capabilities. Automatically manage signing, Team: Personal Team. The App Group is `$(TeamIdentifierPrefix)io.github.perfectpan.snorlax`. App Sandbox stays off.
5. SnorlaxWidget target: the same team, App Sandbox on, the same App Group.
6. Scheme: Snorlax. Product → Run. There is no Dock icon. The menu title stays `Snorlax` until a snapshot loads.
7. Open the menu. The App Group id should be `<TeamID>.io.github.perfectpan.snorlax`. A path means the container exists. Record that. "App Group container is unavailable for this signature" means the Personal Team could not use the group.
8. To see numbers before a real refresh, copy `packages/protocol/fixtures/snapshot.json` to `<container>/snapshot.json`. The menu reads it on the next open (or within about a minute). The title becomes `81.2M`.
9. Widget gallery: Edit Widgets, search for Snorlax, add the small or medium size. It shows the copied snapshot. If Snorlax is absent, record that.
10. Settings → Launch at login. That is the only `register()` call. Allow the item in System Settings if it asks. The agent runs `snorlax refresh` immediately and every 300 seconds. On this branch `refresh` is still the Batch 2 stub, so the agent exits with `internal` and does not read agent logs. Record whether the status becomes `enabled`.
11. Turn Launch at login off when the check is finished. Confirm the service is gone:

```bash
launchctl print "gui/$(id -u)/io.github.perfectpan.snorlax.refresh"
```

The print should say the service could not be found. Do not copy the plist into `~/Library/LaunchAgents`.

12. Write the three answers on the `S1 results` row in `docs/plans/0001-snorlax.md` section 7: App Group container, `SMAppService` registration, widget gallery.

If a spike widget is still on the desktop, remove it. Its kind was `io.github.perfectpan.snorlax.spike`.
