# Project Template: pnpm

A repository template for TypeScript monorepos managed with a [pnpm](https://pnpm.io) workspace that publish
packages to npm.

It layers a pnpm workspace, shared lint and format rules, CI, and an npm release flow on top of the
stack-agnostic [PerfectPan/project-template](https://github.com/PerfectPan/project-template), and keeps that
template's contribution workflow (Spec + Plan), review checks, Git hooks and documentation standards.

## Stack

| Concern | Choice |
| --- | --- |
| Monorepo | pnpm 12.8.1 workspace, pinned in the root `package.json` `packageManager` field; members in `pnpm-workspace.yaml` |
| Runtime | The current Node.js LTS major in `.node-version` (`24`); CI resolves its latest patch. `engines` and `devEngines.runtime` require `^24.11.0`, and pnpm fails the install outside that range (`ERR_PNPM_BAD_RUNTIME_VERSION`) |
| Language | TypeScript 7.0.2, `tsconfig` extends `@perfectpan/lint-config/tsconfig/node.json` |
| Toolchain | Vite+ (`vp`) 1.1.0 for build (`vp pack`), lint (`vp lint`), format (`vp fmt`) and tests (`vp test`); shared settings from [`@perfectpan/lint-config`](https://github.com/PerfectPan/lint-config) v0.6.0; type check stays `tsc` |
| Tests | Vitest 5 bundled in Vite+; test files import from `vite-plus/test` |
| Shared versions | External dependencies used by workspace packages live in the `pnpm-workspace.yaml` catalog; `catalogMode: strict` rejects `pnpm add` of a cataloged package at an off-catalog version |
| Releases | pnpm release management (`pnpm change`, `pnpm version -r`) with all published packages in one `versioning.fixed` lockstep group, the changesets GitHub action for the version PR, npm Trusted Publishing with provenance |

## Quick Start

1. **Create the repository** from this template (GitHub **Use this template**, or
   `gh repo create OWNER/REPO --public --template PerfectPan/project-template-pnpm --clone`).
2. **Rename the placeholders.**
   - Package scope and name: `@scope/example` in `packages/example/package.json` (name, `repository.url` and the
     directory), its README, and the `.changeset/initial-release.md` entry. Rename or replace `packages/example`
     itself as needed.
   - Repository URL: `PerfectPan/project-template-pnpm` in every published `package.json` `repository.url`. npm
     provenance requires it to match the publishing repository.
   - Root `package.json` `name` and this README. Pick the license by project type: libraries and tools keep
     the MIT `LICENSE` (update the holder); applications switch to GPL-3.0-only (see `CONTRIBUTING.md` License).
3. **Install and check.**

   ```bash
   gh extension install PerfectPan/gh-repo-checks
   ./scripts/install-git-hooks.sh
   pnpm install
   pnpm run check
   ```

4. **Protect the default branch** with an admin-authorized `gh` session:

   ```bash
   gh repo-checks protect --repo OWNER/REPO --approvals 0 --check check --apply
   ```

   `--check check` requires the CI job named `check` next to the review checks. `--approvals 0` suits a single
   maintainer, who cannot approve their own pull requests; drop it to require one approving review.

   Also allow GitHub Actions to create pull requests (**Settings → Actions → General**) so Version Packages can open
   the release PR.
5. **Set up npm Trusted Publishing** for every package before the first release, following
   [docs/development/release.md](docs/development/release.md#one-time-setup).

## Layout

```text
pnpm-workspace.yaml           workspace members, the shared dependency catalog, pnpm and release settings
pnpm-lock.yaml                the one lockfile for the whole workspace
.changeset/                   pending changesets, consumed by Version Packages
packages/example/             example public library: src, vp pack build to dist, vite-plus/test suite
scripts/                      repo-scripts project (check-release.ts) and the template's shell checks
.github/workflows/            ci.yml, review.yml, version-packages.yml, publish-npm.yml
docs/development/release.md   release runbook
```

The root `package.json` is itself a private workspace project — pnpm counts it among the workspace projects, it
publishes nothing, and its scripts call `pnpm -r`, so `pnpm run check` works from the repository root.

## Commands

| Command | What it runs |
| --- | --- |
| `pnpm run check` | `format:check`, `build`, `lint`, `typecheck`, `test` (repository checks run in the Review workflow and the pre-commit hook) |
| `pnpm run build` / `lint` / `typecheck` / `test` / `format` / `format:check` | `pnpm -r run <task>`: the task in every workspace package that defines it |
| `pnpm --filter @scope/example run test` | one package's task; add `...` after the name to include its workspace dependencies |
| `pnpm change` | record a changeset for changed packages |
| `pnpm run version-packages` | `pnpm version -r`: consume changesets, bump versions, write changelogs |
| `pnpm run release:check -- vX.Y.Z --repository OWNER/REPO` | tag, version, manifest and pending-changeset checks before publishing |
| `pnpm run publish:dry-run` | `pnpm publish -r --dry-run --json`: prints, per package a publish would upload, the version and the file list. Run it after `pnpm run check` so `dist` exists |

## CI and Releases

- `ci.yml` runs `pnpm run check` on pull requests and `main`. `pnpm/setup` installs pnpm and Node from the pinned
  versions, installs with `--frozen-lockfile`, and caches the pnpm store keyed on the lockfile. Private
  repositories pay for Actions minutes: there, consider running CI only on `ready_for_review` plus
  `workflow_dispatch` instead of every push.
- `review.yml` (from the upstream template) checks repository hygiene, the PR title and the PR description.
- `version-packages.yml` (manual) consumes pending changesets and opens the draft PR
  `chore(release): version packages` from `changeset-release/main`.
- `publish-npm.yml` publishes when a non-prerelease GitHub Release is published.
- Dependabot updates npm dependencies and GitHub Actions weekly with `chore(deps)` titles. Dependabot officially
  supports pnpm 7–10; on pnpm 12 its support is limited (dependabot-core#16397), so a PR may edit `package.json`
  or the catalog without regenerating `pnpm-lock.yaml` — run `pnpm install` and commit the lockfile on the branch
  before merging. See [docs/development/release.md](docs/development/release.md).

Workflows reference actions by their latest major version tag, such as `actions/checkout@v7`, not by commit SHA. See
[docs/development/release.md](docs/development/release.md) for the release procedure and recovery steps.

## License

MIT. See [LICENSE](LICENSE). Projects created from this template choose their own license by project type.

## Template Maintenance

Generic files come from [PerfectPan/project-template](https://github.com/PerfectPan/project-template): the policy
sections of `AGENTS.md` and `CONTRIBUTING.md`, `SECURITY.md`, `docs/README.md`, `docs/specs/`,
`docs/plans/`, the PR/MR and issue templates, `.githooks/pre-commit`, `.github/workflows/review.yml`, and the shell
scripts under `scripts/`. Sync those from upstream instead of editing them here, then keep the pnpm-specific
additions:

- the filled command sections in `AGENTS.md`, `CONTRIBUTING.md` and the PR/MR templates;
- `.githooks/pre-push`, and everything pnpm, npm or TypeScript specific.

Keep this template free of project-specific business logic; `packages/example` stays a minimal example.
