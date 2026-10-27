# Worker deployment

The sync backend is a Cloudflare Worker and a D1 database, in `packages/worker`. Deploying it is an owner step:
this page does not log in, and it does not name an account, a database id, a domain, or a URL. Every such value
below is a placeholder.

Run the commands from `packages/worker`, so `pnpm exec cf` is the `cf` pinned by this repository. `cf` does not
reuse a Wrangler login. It needs Node.js `^22.23.0 || ^24.22.0 || ^26.12.0`. This repository develops on Node 24.

## Log in

```bash
cf auth login
```

## Create the database

Once per account:

```bash
cf d1 create --name snorlax --read-replication-mode disabled
```

The command prints the new database id. The rest of this page calls it `<d1-database-id>`.

## Apply the migrations

Apply them to the remote database. The `--local` flag is for `cf dev`, not for this deploy.

```bash
cf d1 migrations apply <d1-database-id>
```

## Admin token

```bash
openssl rand -hex 32
```

The command prints 64 hexadecimal characters. Those characters are legal in an admin token. Store the value in a
password manager.

Write it to a file that is outside this repository, mode `0600`:

```text
ADMIN_TOKEN=<token>
```

`<secrets-file>` below is that file. Delete it after the deploy. Do not commit it, and do not pass the token as an
argument: `cf` has no command that sets one secret by itself, and `cf workers secrets update` would take the value
on the command line.

## Deploy

The default publish target is the Worker's `workers.dev` hostname:

```bash
SNORLAX_D1_DATABASE_ID=<d1-database-id> pnpm exec cf deploy --mode production --secrets-file <secrets-file>
```

`--mode production` reads the database id from `SNORLAX_D1_DATABASE_ID` and stops if it is missing, so the
repository never has to store an id.

To publish on a domain you control instead, set `SNORLAX_DOMAIN`. The Worker is then served on that domain and
`workers.dev` is turned off:

```bash
SNORLAX_D1_DATABASE_ID=<d1-database-id> SNORLAX_DOMAIN=<domain> \
  pnpm exec cf deploy --mode production --secrets-file <secrets-file>
```

Leave `SNORLAX_DOMAIN` unset to stay on `workers.dev`.

Changing the domain moves the Worker to a new origin. Pair each device again with the admin token. The collector
revokes that device and registers it again, and usage already uploaded stays. The steps are in
[pairing.md](pairing.md).

## Deploy again

Deploy from an up-to-date `main`, after `pnpm install`: `cf deploy` builds the Worker from the working tree. Later
deploys leave out `--secrets-file`:

```bash
SNORLAX_D1_DATABASE_ID=<d1-database-id> pnpm exec cf deploy --mode production
```

Every deploy reads `SNORLAX_DOMAIN` again. On a domain you control, set it to the same value as before, as in the
domain command above. Leaving it unset turns `workers.dev` back on.

`ADMIN_TOKEN` stays set across deploys that do not pass a secrets file. To replace it, write a new secrets file as
above, deploy with `--secrets-file` again, and delete the file. Devices keep their own tokens; only admin calls
(pairing and revoking) need the new value.

When a change adds a file under `migrations/`, apply the migrations as above before that deploy. Migrations are
additive, so the Worker that is still running keeps working on the new schema.

To confirm the admin token is still set, revoke a device id that does not exist, the way
[pairing.md](pairing.md) revokes a device (the header in a file, never on the command line), with any UUID that no
device uses in place of `<device-id>`. A body with code `not-found` and the message `no device <device-id>` means
the token was accepted. Code `unauthorized` means the secret is missing or different.

## Check

On the default hostname:

```bash
curl -fsS "https://<worker-name>.<account-subdomain>.workers.dev/v1/health"
```

On a custom domain, request `https://<domain>/v1/health` instead. A successful health check is the deploy check
for this page.
