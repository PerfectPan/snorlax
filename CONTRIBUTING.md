# Contributing

## Development Setup

Requirements: Node.js `^26.13.1` (26.13.1 or a newer 26.x release) and Git. `.node-version` selects major 26 for version managers. The root `package.json`
declares the version in `engines.node` and enforces it through `devEngines.runtime` (`onFail: "error"`): with a Node
outside `^26.13.1`, `pnpm install` fails with `ERR_PNPM_BAD_RUNTIME_VERSION`. pnpm is pinned in the root
`package.json` `packageManager` field; corepack resolves it automatically (`corepack enable pnpm` once per
machine), and CI installs it through `pnpm/setup`. A standalone pnpm install also works if its major matches.

Development, CI and release workflows require at least Node.js 26.13.1, the [November 2026 security release](https://nodejs.org/en/blog/vulnerability/november-2026-security-releases), and accept later 26.x releases. `pnpm/setup` resolves `devEngines.runtime` in CI; `engines.node` enforces the same range locally. Keep both ranges aligned and `.node-version` on major 26. Node 26.13.0 and Node 27 are rejected. Published-package minimums and Node type declarations retain their existing compatibility baseline; update them only when required by an API change. Workflows reference actions by their latest major tag.

```bash
# install local Git hooks
./scripts/install-git-hooks.sh

# install dependencies from the committed lockfile (CI does the same with --frozen-lockfile)
pnpm install

# after changing dependencies in any package.json, refresh the lockfile and commit it
# (pnpm rejects versions published less than a day ago: minimumReleaseAge in pnpm-workspace.yaml)
pnpm install

# run the full local gate
pnpm run check

# work on one package (add ... after the name to include its workspace dependencies)
pnpm --filter @rivus/snorlax run test
```

To add a package, copy an existing package under `packages/` (or `packages/example` from
[PerfectPan/project-template-pnpm](https://github.com/PerfectPan/project-template-pnpm)), rename it, and run
`pnpm install` so the lockfile picks it up.
Dependencies shared with other workspace packages come from the `pnpm-workspace.yaml` catalog
(`"dependency": "catalog:"`); `catalogMode: strict` makes `pnpm add` of an already-cataloged package at an
off-catalog version fail, but it does not police hand-edited manifests, so keep shared versions in the catalog
deliberately. A published package needs a stable `version`, a `repository.url` pointing at this GitHub repository,
`publishConfig.access: "public"`, and a `files` list; a private tool package sets `"private": true`.

## Contribution Flow

1. Open an issue or discussion for ambiguous work.
2. Check the [Change Design Gate](#change-design-gate). Write an implementation plan only when the change meets the gate; bugfixes and routine changes go straight to implementation and PR/MR summary.
3. Create a focused branch with a short descriptive name.
4. Install local Git hooks with `./scripts/install-git-hooks.sh` if this checkout has not already done so.
5. Identify the affected domain concepts, layer boundaries, data flow, and tests before changing code.
6. Implement the change, keeping responsibilities separated and using existing project patterns.
7. Add or update tests for behavior changes.
8. Update `README.md`, `docs/`, `AGENTS.md`, `CONTRIBUTING.md`, or the active Plan when user-facing behavior, architecture, development workflow, or project policy changes.
9. Run repository checks, title checks, and project-specific format, lint, test, build, and package checks.
10. For a newly created GitHub repository, run `gh repo-checks protect --apply` with an admin-authorized account.
11. Open a pull request or merge request with a conventional title, a summary of what changed and why, validation with skipped gates, and any risks.
12. Keep the PR/MR description current after review feedback, rebases, validation reruns, or scope changes.

## Required Checks

```bash
# Local Git hooks:
./scripts/install-git-hooks.sh

# Aggregate gate: format:check, build, lint, typecheck, test:
pnpm run check

# Pending change records (CI runs it before the aggregate gate; gh-repo-checks v1.4.0 or later):
gh repo-checks release-plan

# PR/MR title:
gh repo-checks pr-title "docs: update project template"

# PR/MR description:
gh repo-checks pr-body pr-body.md

# GitHub repository setup dry run:
gh repo-checks protect --repo OWNER/REPO
```

## Changesets

Changesets build changelogs and version bumps from change records in `.changeset/`. A PR that changes what a
published package ships (source, manifest, build config) or the lockfile should include one:

```bash
pnpm changeset
```

`pnpm changeset` asks for the affected packages, a bump type (`patch`, `minor`, `major`) and a user-facing message.
Without a terminal, pass them explicitly:

```bash
pnpm changeset add --patch @rivus/snorlax -m "Update runtime dependencies."
```

Or write the file directly (this is what the command produces):

```markdown
---
"@rivus/snorlax": patch
---

Update runtime dependencies.
```

The file name is a short kebab-case slug. Name only published packages: `@rivus/snorlax-protocol` and
`@rivus/snorlax-worker` are private, Changesets never versions them, and `gh repo-checks release-plan` (run in CI)
rejects a record that names one. Describe a protocol or Worker change by its effect on `@rivus/snorlax` when it
changes what that package ships. `pnpm changeset status --verbose` previews what pending changesets would release,
and the Release workflow's version pull request (`changeset version`) consumes them. Tests, fixtures and Markdown
changes usually do not need a changeset; changesets are not CI-enforced, so whether a change rides a release is the
maintainer's call. See [`docs/development/release.md`](docs/development/release.md) for the release procedure.

## Plan Lifecycle And Retirement

1. Draft a plan from [`docs/plans/0000-template.md`](docs/plans/0000-template.md) only when triggered by the [Change Design Gate](#change-design-gate). Keep `Status: blocked` while a material scope, interface, data, or rollout decision is unresolved.
2. Review the goals, boundaries, and key decisions before implementing; update the plan if design choices change mid-flight.
3. Implement within that scope, adding tests and updating current-state `docs/` in the same change.
4. Retire the plan in its final delivery PR/MR as soon as its code scope lands on the default branch; move deferred manual checks and future polish to issues rather than keeping the plan open. Follow [`docs/AGENTS.md` §4](docs/AGENTS.md#4-retiring-a-plan).

## Change Design Gate

Most changes need only a clear PR/MR description (`## Summary` and `## Validation`), not a separate document.

| Change scope | Required artifact |
| --- | --- |
| Bugfix, localized feature/refactor, tests, dependencies, or docs | PR/MR description explaining what changed, why, and how it was verified |
| New subsystem or package, public contract/schema/protocol change, major design tradeoffs, or multi-PR/multi-session work | One Plan in [`docs/plans/`](docs/plans/) |

## Implementation Plans

[`docs/plans/`](docs/plans/) holds active Plans only while non-trivial work is in flight. Copy [`0000-template.md`](docs/plans/0000-template.md) and keep only the sections that apply. State the problem, goals, non-goals, boundaries, rejected alternatives, failure/rollback behavior, and verification; a file list alone is not a design.

Keep unknown owners, dates, and interfaces marked "unconfirmed". A plan may make feature-specific technical decisions, but it cannot silently override current architecture. Follow [Plan Lifecycle And Retirement](#plan-lifecycle-and-retirement) when the code lands.

## Repository Architecture

Maintain the repository around real responsibilities:

- Domain rules describe business or product concepts and should not depend on UI, CLI, persistence, network, or framework adapters.
- Application services coordinate use cases and data flow without owning infrastructure details.
- Infrastructure adapters isolate external systems such as filesystems, databases, HTTP clients, queues, build tools, and hosted services.
- UI, CLI, or API entrypoints translate user or protocol input into application calls.
- Test fixtures and helpers belong near the tests or in clearly named test-support areas.

For JavaScript or TypeScript projects, take shared lint, format, and `tsconfig` rules from the `PerfectPan/lint-config` repository instead of copying them; see its README. Other stacks choose their own tooling.

Avoid splitting code only to satisfy a mechanical one-export rule. Split when a file mixes responsibilities, a component or service needs independent testing, a boundary becomes reusable, or a change would otherwise make review harder. When adding a top-level directory or durable module boundary, document the reason in the PR/MR and record the technical choice in a Plan when the structure affects long-term integration.

## Documentation Standards

Keep each documentation surface focused:

- Use `README.md` for orientation, quick start, and current user-facing behavior.
- Use `CONTRIBUTING.md` for contribution workflow, review expectations, and repository policy.
- Use `AGENTS.md` for AI-agent instructions.
- Use `docs/plans/` for active implementation plans while non-trivial work is in flight; retire them when code lands.
- Use `docs/` (`guides/`, `reference/`, `architecture/`, `development/`) for durable current-state knowledge that code alone cannot express.

Follow [`docs/AGENTS.md`](docs/AGENTS.md) for category placement, writing standards, and retiring plans into durable docs, and list new documents in [`docs/README.md`](docs/README.md). Update docs in the same change as behavior, configuration, command, API, deployment, architecture, or operational changes.

## Pull Request Expectations

The PR/MR template has three sections:

- **Summary**: what changed and why, with links to the issue or Plan when there is one.
- **Validation**: the commands you ran and their results, evidence for behavior or packaging claims, and skipped gates with reasons.
- **Risks** (optional): compatibility, rollout, rollback, or follow-up risks. Delete it when there are none.

Use a conventional title:

```text
type(scope): summary
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.

Titles are English; `gh repo-checks pr-title` rejects CJK characters. Bot-generated PRs follow the same rule, so configure release and dependency bots to emit titles such as `chore(release): version packages` or `chore(deps): bump <package> to <version>`.

Summary and Validation must be present and contain real content, not template placeholders; other sections are optional. Do not include agent attribution lines such as "Generated with <tool>"; the author is accountable for the content. `gh repo-checks pr-body` enforces these rules, and the `PR description` job runs it on every pull request event, including description edits. PRs opened by bot accounts skip the description check, because dependency and release bots write their own bodies; they still must pass the title check. A skipped job still satisfies the required status check.

Update the description when review feedback, rebases, or follow-up commits change the scope or validation result. Reviewers should be able to understand the final state from the PR/MR without reconstructing it from comments.

## Release Notes

Release notes come from the release tool. `pnpm run version-packages` (`changeset version`) writes each published package's `CHANGELOG.md` from the changesets in `.changeset/` (see [Changesets](#changesets)), with PR links and author thanks from `@changesets/changelog-github`, and deletes consumed records. Do not edit generated changelogs or keep a hand-written root `CHANGELOG.md` beside them.

## License

Choose the license by project type when the repository is created:

- Applications (services, desktop or web apps, agents) use GPL-3.0-only, so distributed modifications stay open source. Replace `LICENSE` with the GPL text (`gh api licenses/gpl-3.0 --jq .body > LICENSE`) and set package metadata to `GPL-3.0-only`.
- Tools and libraries (CLIs, packages, configs, templates) use MIT, which this template ships in `LICENSE`. Package metadata uses `MIT`.

Record the choice in the README. Change it later only as a deliberate project decision, and keep third-party notices for code or data copied from other projects.

## Repository Checks

Do not commit private tokens, local config, generated workspaces, internal hostnames, or personal filesystem paths.

Keep package or deploy contents intentional. If a file should ship, verify it appears in the package or deployment dry-run.

The review checks come from [`PerfectPan/gh-repo-checks`](https://github.com/PerfectPan/gh-repo-checks): CI runs them through its GitHub Action (`uses: PerfectPan/gh-repo-checks@v1`), and locally they run as a GitHub CLI extension (`gh extension install PerfectPan/gh-repo-checks`). Do not copy the check scripts into this repository; change them upstream. Repository-specific additions, such as extra required files or forbidden patterns, go in `.github/repo-checks.conf`, and repository-specific scripts run as extra steps after the shared check.

Run `gh repo-checks repository` locally before opening review. This generic check does not replace stack-specific tests, but it catches missing template files, tracked local artifacts, obvious secrets, private paths, and drift in review templates.

Workflows reference actions by their latest major version tag, such as `actions/checkout@v7`, not by commit SHA. The Release workflow calls the shared release workflow at `PerfectPan/gh-repo-checks/.github/workflows/npm-release.yml@v1`, which pins `changesets/action` to an exact release tag itself. Workflow files copied from this template take action upgrades from the template rather than local edits.

## Local Git Hooks

Install local hooks after cloning or creating a repository from this template:

```bash
./scripts/install-git-hooks.sh
```

The pre-commit hook runs `git diff --cached --check` and `gh repo-checks repository --staged` before a commit is created; without the extension it warns and skips the repository check. The pre-push hook rejects pushes to `main`, which changes only through pull requests. Hooks are a local guardrail; CI and branch protection remain the authoritative enforcement because hooks can be missing or bypassed.

If `core.hooksPath` is already set to another path, `scripts/install-git-hooks.sh` fails instead of overwriting it. Re-run with `--force` only after confirming the existing hooks can be replaced or moved into `.githooks`.

## Repository Setup

Template files do not carry GitHub branch protection settings into every new repository. After creating a GitHub repository from this template, run:

```bash
gh repo-checks protect --repo OWNER/REPO --check check --apply
```

The command requires a GitHub account or token with permission to edit repository settings. It protects the default branch by requiring pull requests, one approving review (fresh after new pushes), linear history, resolved conversations, and the `Review` workflow checks named `repository checks`, `conventional PR title`, and `PR description`. `--check check` also requires this repository's `CI` workflow job named `check`.

A repository with a single maintainer cannot approve its own pull requests; pass `--approvals 0` to keep the other protections without a review requirement. Add the project's CI job names with `--check NAME` (repeatable) so they are required too. If the repository already uses a ruleset, add these checks to the ruleset instead of layering classic branch protection on top.

Labels are not copied either. GitHub's defaults include `bug` and `enhancement` but not `task`, and an issue template's label only applies when the label exists, so create it once:

```bash
gh label create task --repo OWNER/REPO --color 0E8A16 --description "Maintenance, refactoring, dependency, or tooling work"
```

## Security Reports

Use `SECURITY.md` for vulnerability reporting guidance. Do not include secrets, exploit details, or private infrastructure in public issues or pull requests.
