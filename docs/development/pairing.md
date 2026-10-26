# Pairing

Pairing registers this machine with the Worker. The collector stores the device token in the macOS keychain, or,
on Linux, with `secret-tool` from libsecret. The admin token is read from stdin for that one command and is not
saved. Replace every `<placeholder>` below, including the angle brackets. None of them is a real account, domain,
or keychain item.

## Command line

Take the admin token from a password manager. Pass it on stdin, on macOS or Linux:

```bash
printf '%s\n' "$ADMIN_TOKEN" | snorlax pair --url https://<worker>.<account-subdomain>.workers.dev --name "MacBook Pro"
```

The URL has to be `https:`. Only `localhost`, `127.0.0.1`, and `[::1]` may use `http:`. `--name` is the device
name stored for this machine.

On macOS the same token can be read from a keychain item and piped. `<service>` and `<keychain-account>` name
that item in the password manager. They are not a Cloudflare account, and snorlax does not create the item:

```bash
security find-generic-password -s "<service>" -a "<keychain-account>" -w \
  | snorlax pair --url https://<worker>.<account-subdomain>.workers.dev --name "MacBook Pro"
```

`security` prints the token and a newline. `pair` removes one trailing newline.

On Linux, install `secret-tool` (libsecret) before pairing. The collector runs it to store the device token. The
package that provides the command depends on the distribution. The admin token still comes from stdin, as above.

## In the macOS app

Open Settings and use the Sync section.

When this Mac is not paired, the section asks for the backend URL, the device name, and the admin token. The
device name starts as the name `snorlax status` reports, and is left empty when status has none. Pair stays
disabled until all three fields are filled, and while a command is already running. The admin token is used only
for that attempt. It is not saved. Closing the Settings window, finishing pairing, or unpairing clears it.
Minimizing or hiding the window, or switching to another app, does not, so close the window when you are not
using the token. A snapshot that shows this Mac as paired clears it too.

When this Mac is paired, the section shows that it is paired, the sync state (`ok`, `failed`, `unpaired`, or
`revoked`), and the last sync time. Those three come from the snapshot. Unpair removes the pairing and keeps the
local ledger.

Pair and Unpair both reload `snorlax status` and the snapshot afterwards.

## Check

```bash
snorlax status
snorlax doctor
```

`status` prints the device name and the sync state. `doctor` checks the machine and does not change it. Use both
after pairing and after unpair.

## Unpair

```bash
snorlax unpair
```

This deletes the device token and clears the saved backend URL. The local ledger and snapshot stay. Running it
when this machine is not paired succeeds.

## Pair again

After `snorlax unpair`, or when this machine's device token is gone, run `pair` again with the admin token. The
collector revokes the existing registration for this device id when there is one, then registers it again.
Buckets already uploaded stay. The previous device token stops working. Do this the same way after the Worker's
origin changes. A hand revoke is not required for either case.

## Revoke a device

Revoke by hand when `pair` reports `conflict` or `keychain`. `conflict` is the rare case where the collector
already revoked this id and the new registration still collided. `keychain` means the backend registered the
device but the device token was not stored. Write the header into a file so the token is not a command-line
argument. The `umask` applies only inside the subshell:

```bash
(
  umask 077
  printf 'Authorization: Bearer %s\n' "$ADMIN_TOKEN" > "<header-file>"
  curl -sS -X DELETE -H "@<header-file>" \
    "https://<worker>.<account-subdomain>.workers.dev/v1/devices/<device-id>"
  rm "<header-file>"
)
```

`DELETE /v1/devices/<device-id>` marks that device revoked and keeps its buckets. `<device-id>` is the id
`snorlax status` prints, or the id from a previous pair.

## A new origin

Moving the Worker to a custom domain, or otherwise changing its origin, means every device pairs again. Run
`pair` with the admin token, as in [Pair again](#pair-again). The saved URL is the old origin. The deploy steps
are in [worker.md](worker.md).

## When pairing fails

`pair --json` prints one JSON object on stdout. A failure exits 1. Rejected arguments exit 2. Without `--json`,
stdout is not that object. The app always passes `--json`. The `error.code` on the object says which case it is.
The app shows the sentence for that code plus the collector's `message`.

| Code | What to do |
| --- | --- |
| `unauthorized` | The admin token was not accepted. Check the token from the password manager and pair again. |
| `conflict` | Revoking this device and registering it again still collided. Revoke it with the admin token, then pair again. |
| `network` | The backend could not be reached. Check the URL and that this machine can resolve it. |
| `keychain` | The backend registered this device, but the device token was not saved in the keychain. Revoke the device, then pair again. On Linux, confirm `secret-tool` runs. |
| `forbidden` | The backend refused this pairing. |
| `invalid-response` | The collector could not read the backend's response. |
| `invalid-arguments` | The URL or the device name was rejected. The URL must use `https`, except `http` for `localhost`, `127.0.0.1`, and `[::1]`. |

Any other code is a failure the sentences above do not name. The collector's `message` is the detail to keep.

## The first upload

The first pairing uploads every local bucket, including buckets older than 30 days. The app's windows do not show
those older buckets. They are uploaded so the backend is a full copy of the ledger.
