# Agent Guidelines

This repository is intended to become a maintainable, publishable project. Treat every change as if it may be reviewed, packaged, indexed, and installed by users.

## Working Rules

- Keep changes scoped to the user request and nearby code.
- Prefer existing project patterns over new abstractions.
- Do not commit local config, credentials, generated logs, temporary workspaces, build artifacts, or machine-specific paths.
- Do not add private tokens, internal hostnames, private repository names, or personal filesystem paths.
- Use `rg` for searches when available.
- Update tests and documentation when behavior changes.

## Project Rules

snorlax reads coding-agent logs, so these rules apply to every change and to every agent working on it:

- Never read, load, or scan real agent session files on any machine (`~/.claude`, `~/.codex`, `~/.gemini`,
  `~/.grok`, `~/.local/share/opencode`, `~/.pi`, or the same paths under a configured home). Tests use repository
  fixtures and logs generated under a temporary `HOME`. Measurements on real logs are run by the owner only.
- Parse unknown data (agent records, files, HTTP bodies, CLI output) with `zod/mini` schemas at the boundary. Do
  not write shape guards by hand: no `asRecord`/`isRecord`-style helpers and no inline
  `typeof value === "object" && value !== null` checks on unknown values.
- Tests advance time through an injected clock (the agent-kit `Platform` clock, or fake timers when the code uses
  global timers). Never assert on real elapsed time.
- A test or command that sets a temporary `HOME` removes it afterwards:
  `H=$(mktemp -d); HOME=$H <command>; s=$?; rm -rf "$H"; exit $s`.
- Uploads carry only the bucket fields defined in `docs/specs/0001-snorlax.md` (numbers, device id, UTC hour,
  agent id, model name). Never add prompts, paths, project names, or session ids to anything that leaves the machine.
- Cloudflare credentials, Apple signing, npm Trusted Publishing, branch protection, and merging are owner steps.
  Prepare the change and the exact command; do not run deploys or publish.

## Project-Specific Commands

This is a pnpm workspace TypeScript monorepo. The pnpm version is pinned in the root `package.json`
`packageManager` field (corepack and CI resolve it automatically). The root `package.json` is itself a private
workspace project — it publishes nothing and holds the `pnpm -r` shortcuts. Node comes from `.node-version`.

```bash
# Install local Git hooks (pre-commit repository checks, pre-push blocks direct pushes to main):
./scripts/install-git-hooks.sh

# Install dependencies from the committed lockfile (CI does the same with --frozen-lockfile):
pnpm install

# After adding or changing a dependency, refresh the lockfile and commit it:
pnpm install

# Aggregate gate: format:check, build, lint, typecheck, test:
pnpm run check

# Individual gates (run in every workspace package that defines them):
pnpm run format        # or format:check
pnpm run build
pnpm run lint          # vp lint: oxlint with type-aware rules and TypeScript diagnostics
pnpm run typecheck
pnpm run test

# Work on one package (add ... after the name to include its workspace dependencies):
pnpm --filter @rivus/snorlax run test

# Record a release note for changed packages. Non-interactive form (works without a terminal):
pnpm change @rivus/snorlax --bump patch --summary "Update runtime dependencies."
# Interactive prompt (needs a terminal); preview with `pnpm change status`:
pnpm change

# Release identity check and publish dry run (dry run never uploads):
pnpm run release:check -- vX.Y.Z --repository OWNER/REPO
pnpm run publish:dry-run

# Repository, PR/MR title and description checks:
gh repo-checks repository
gh repo-checks pr-title "docs: update project template"
gh repo-checks pr-body pr-body.md

# GitHub repository setup dry run:
gh repo-checks protect --repo OWNER/REPO
```

Workspace members are listed in `pnpm-workspace.yaml`. Publishable packages live under `packages/`;
`scripts/` is the private `repo-scripts` package for repository automation written in TypeScript and run directly
by Node. Shared dependency versions live in the `pnpm-workspace.yaml` catalog, referenced as `catalog:`;
`catalogMode: strict` makes `pnpm add` of an already-cataloged package at an off-catalog version fail, but it does
not police hand-edited manifests, so keep shared versions in the catalog deliberately. All published packages
release at one shared version through the `versioning.fixed` group. Every package defines the `build`,
`lint`, `typecheck`, `test`, `format` and `format:check` scripts that the root shortcuts call.
`docs/development/release.md` is the release runbook.

Do not claim implementation work is complete until the relevant commands pass, or until skipped commands are explained with concrete blockers.

## Development Workflow

For non-trivial changes:

1. Understand the requested behavior, affected domain concepts, ownership boundaries, and data flow.
2. Follow the Spec/Plan selection rules in `CONTRIBUTING.md`. Review required design artifacts before implementation. The Spec states required behavior; the Plan records technical decisions and the ordered tasks, tests, and exit conditions to execute. Do not start a Plan that is blocked on an unresolved decision. Migrate lasting constraints to current-state documentation.
3. Keep the implementation scoped to the task and nearby code.
4. Update tests and documentation when behavior, public contracts, or workflow expectations change.
5. Ensure local Git hooks are installed for the checkout when practical.
6. Run repository checks, title checks, and project-specific validation gates.
7. For a newly created GitHub repository, configure branch protection with `gh repo-checks protect --repo OWNER/REPO --check check --apply` (add `--approvals 0` for a single maintainer) using an admin-authorized account.
8. Open or update the PR/MR with a summary of what changed and why, the exact validation and skipped gates, and any risks.

## Releases

- A PR that changes what a published package ships (source, manifest, build config) or the lockfile includes a
  changeset under `.changeset/`. Create it with `pnpm change`, or write the file directly (format in
  `CONTRIBUTING.md`). Changesets are not CI-enforced in this template; adding one is the maintainer's call.
- Never bump versions, edit generated `CHANGELOG.md` files, create release tags, or publish by hand. The
  `Version Packages` workflow prepares versions, and publishing a GitHub Release runs `publish-npm.yml`.
  Follow `docs/development/release.md`.
- Workspace dependencies between packages use `workspace:*`; pnpm replaces them with exact versions when packing.

## Repository Architecture

- Organize code by domain boundaries, layer boundaries, and test boundaries before mechanical one-file-per-export preferences.
- Put unit tests next to the code they test (for TypeScript, `foo.test.ts` beside `foo.ts`; other languages follow their own convention). Integration tests, which cross modules, run a built artifact, or go through an external boundary such as HTTP or a database, live in the package's `test/` directory, with shared fixtures under `test/fixtures/`.
- Keep domain rules, application services, infrastructure adapters, UI/CLI entrypoints, persistence, and test fixtures separated when those responsibilities exist.
- JavaScript or TypeScript projects take shared lint, format, and `tsconfig` rules from the `PerfectPan/lint-config` repository; see its README. Extend those shared configs instead of copying them.
- Do not introduce a shared abstraction unless it removes real duplication, clarifies a boundary, or matches an existing project pattern.
- When a file starts mixing multiple responsibilities or layers, split by responsibility rather than by arbitrary size.
- Substantial product behavior uses one Spec plus one detailed Plan. Technical refactors use a Plan. Record technical choices there before implementation.

## Documentation

- Keep `README.md` focused on orientation, quick start, and current user-facing behavior.
- Use `CONTRIBUTING.md` for contribution workflow.
- Use `docs/specs/` for active product behavior and `docs/plans/` for active technical decisions and detailed execution plans. Current-state documentation owns implemented behavior.
- Use `docs/` for durable current-state knowledge such as architecture, development guides, operational runbooks, references, and onboarding tutorials.
- Record user-facing changes with changesets (`.changeset/*.md`) in the same PR; do not edit generated changelogs or add a hand-written root `CHANGELOG.md`.
- When behavior, configuration, commands, APIs, deployment, architecture, or operations change, update the relevant docs in the same PR/MR or explain why no docs changed.

## AI Delivery Workflow

When an AI agent completes implementation work:

1. Inspect `git status --short --branch`.
2. Verify generated files, secrets, machine paths, and build artifacts are not staged.
3. Run the required verification gates and record the exact commands.
4. Commit pending changes with a concise conventional commit message.
5. Push the branch and verify the remote head.
6. Create or reuse a GitHub Pull Request when the task is not landing directly on `main`.
7. Include a delivery summary with what changed and why, validation, and remaining risks.

## Review Evidence

- PR/MR titles must be English and follow `type(scope): summary`, including bot-generated release and dependency PRs such as `chore(release): version packages`; use `gh repo-checks pr-title` to verify them.
- PR/MR descriptions must have a Summary (what changed and why) and a Validation section (exact commands and results, skipped gates with reasons); add Risks when there are any. Do not add agent attribution lines such as "Generated with <tool>". Verify the body with `gh repo-checks pr-body` before opening or updating the PR/MR. Bot-opened PRs are exempt from the description check, not the title check.
- If a claim depends on logs, screenshots, package output, deployed behavior, or generated artifacts, attach or link the evidence in the PR/MR.
- Update the PR/MR description after substantial code changes, review-driven revisions, rebases that change behavior, or validation reruns.
- Keep GitHub PR and GitLab MR templates in sync if the project uses both hosting styles.

## Git

- Branch names should be short and descriptive, such as `feat/release-source`.
- Commit messages should be concise and use conventional prefixes when they fit.
- Signed commits are preferred when local git signing is configured.
- Do not rewrite or discard user changes unless explicitly requested.

## Publish Safety Check

Before pushing public-facing or package-facing changes, scan for accidental private references. Adjust globs for the project stack:

```bash
rg --hidden --no-ignore -n "private-token|secret|internal-domain.example|HOME_PATH_PLACEHOLDER" . \
  --glob '!.git/**' \
  --glob '!.omx/**' \
  --glob '!**/node_modules/**' \
  --glob '!**/dist/**' \
  --glob '!AGENTS.md' \
  --glob '!CONTRIBUTING.md' \
  --glob '!SECURITY.md'
```
