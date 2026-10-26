# snorlax

Snorlax eats 400 kg a day. snorlax counts what your coding agents eat: the tokens, requests and cost of Claude
Code, Codex, Gemini CLI, Grok, opencode and Pi, added up across every machine you use, on the macOS menu bar and in
desktop widgets.

Status: planning. Nothing is released yet. The behavior is specified in
[docs/specs/0001-snorlax.md](docs/specs/0001-snorlax.md) and the design and execution plan are in
[docs/plans/0001-snorlax.md](docs/plans/0001-snorlax.md).

## How it works

```text
each machine
  agent logs (read only) -> collector (Node CLI, run every 5 minutes)
                         -> local ledger: usage per UTC hour, agent and model
                         -> snapshot.json -> menu bar app and desktop widget (Swift)
                         -> your Cloudflare Worker + D1 <- the other machines
```

- **Non-invasive.** The collector only reads the files the agents already write. It installs no hooks or plugins
  and changes no agent configuration. Log decoding comes from
  [`@rivus/agent-kit`](https://github.com/PerfectPan/agent-kit).
- **Numbers only.** What leaves a machine is hourly totals keyed by device, agent and model name. Prompts, paths,
  project names and session ids stay local.
- **Your own backend.** Sync goes through a Worker deployed to your Cloudflare account. Without one, snorlax works
  on a single machine. Any service that implements the same HTTP interface can replace it.
- **Linux too.** On Linux machines the collector runs headless and only uploads. Install and the systemd timer are described in [docs/development/linux.md](docs/development/linux.md).

## Planned layout

```text
packages/protocol/   zod definitions shared by the collector, the Worker and the generated Swift types
packages/collector/  the `snorlax` CLI (npm `@rivus/snorlax`)
packages/worker/     Cloudflare Worker and D1 migrations
apps/macos/          menu bar app, desktop widget and the SnorlaxKit Swift package
```

## Development

The repository is a pnpm workspace created from
[PerfectPan/project-template-pnpm](https://github.com/PerfectPan/project-template-pnpm). Commands, conventions and
project rules for contributors and coding agents are in [AGENTS.md](AGENTS.md) and
[CONTRIBUTING.md](CONTRIBUTING.md). Deploying a Worker is described in
[docs/development/worker.md](docs/development/worker.md).

```bash
./scripts/install-git-hooks.sh
pnpm install
pnpm run check
```

## License

GPL-3.0-only. See [LICENSE](LICENSE).

Snorlax is a trademark of Nintendo, Creatures and GAME FREAK. This project is not affiliated with or endorsed by
them and does not use their artwork.
