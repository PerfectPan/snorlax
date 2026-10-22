# Contributing

## Development Setup

Requirements: the Node.js major in `.node-version` (Node 24, the current LTS) and Git. The root `package.json`
declares the range in `engines.node` and enforces it through `devEngines.runtime` (`onFail: "error"`): with a Node
outside `^24.11.0`, `pnpm install` fails with `ERR_PNPM_BAD_RUNTIME_VERSION`. pnpm is pinned in the root
`package.json` `packageManager` field; corepack resolves it automatically (`corepack enable pnpm` once per
machine), and CI installs it through `pnpm/setup`. A standalone pnpm install also works if its major matches.

CI and `.node-version` follow the current Node.js Active LTS major, and workflows reference actions by their latest major tag. When a new Node.js line enters Active LTS (Node 26 is expected in late October 2026), move `.node-version`, the `engines` and `devEngines.runtime` fields and the `@types/node` catalog entry to it in one change.

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
`publishConfig.access: "public"`, a `files` list, and a place in the `versioning.fixed` group in
`pnpm-workspace.yaml`; a private tool package sets `"private": true`.

## Contribution Flow

1. Open an issue or discussion for ambiguous work.
2. Choose Spec and Plan artifacts using the [Change Design Gate](#change-design-gate) before substantial work. Review the behavior and technical design before implementing that scope.
3. Create a focused branch with a short descriptive name.
4. Install local Git hooks with `./scripts/install-git-hooks.sh` if this checkout has not already done so.
5. Identify the affected domain concepts, layer boundaries, data flow, and tests before changing code.
6. Implement the change, keeping responsibilities separated and using existing project patterns.
7. Add or update tests for behavior changes.
8. Update `README.md`, `docs/`, `AGENTS.md`, `CONTRIBUTING.md`, or the active Spec and Plan when user-facing behavior, architecture, development workflow, operations, or project policy changes.
9. Run repository checks, title checks, and project-specific format, lint, test, build, and package checks.
10. For a newly created GitHub repository, run `gh repo-checks protect --apply` with an admin-authorized account.
11. Open a pull request or merge request with a conventional title, a summary of what changed and why, validation with skipped gates, and any risks.
12. Keep the PR/MR description current after review feedback, rebases, validation reruns, or scope changes.

Small typo corrections, narrow documentation fixes, and repository metadata updates do not need a separate Spec and Plan.

## Required Checks

```bash
# Local Git hooks:
./scripts/install-git-hooks.sh

# Aggregate gate: format:check, build, lint, typecheck, test, repository checks:
pnpm run check

# PR/MR title:
gh repo-checks pr-title "docs: update project template"

# PR/MR description:
gh repo-checks pr-body pr-body.md

# GitHub repository setup dry run:
gh repo-checks protect --repo OWNER/REPO

# Package or release dry-run:
pnpm run publish:dry-run
```

## Changesets

pnpm builds changelogs and version bumps from changesets in `.changeset/`. A PR that changes what a published
package ships (source, manifest, build config) or the lockfile should include one:

```bash
pnpm change
```

`pnpm change` asks for the affected packages, a bump type (`patch`, `minor`, `major`) and a user-facing message.
Without a terminal, pass them explicitly:

```bash
pnpm change @rivus/snorlax --bump patch --summary "Update runtime dependencies."
```

Or write the file directly (this is what the command produces):

```markdown
---
"@rivus/snorlax": patch
---

Update runtime dependencies.
```

The file name is a short kebab-case slug. `pnpm change status` previews what pending changesets would release, and
`pnpm version -r` (the `version-packages` script) consumes them. Tests, fixtures and Markdown changes usually do
not need a changeset; changesets are not CI-enforced in this template, so whether a change rides a release is the
maintainer's call. See [`docs/development/release.md`](docs/development/release.md) for the release procedure.

## SDD Workflow And Document Lifecycle

1. Record the problem, affected users or maintainers, in-scope behavior, non-goals, and acceptance conditions.
2. Choose artifacts with the [Change Design Gate](#change-design-gate). Product work defaults to one behavioral Spec and one detailed Plan for the same deliverable. The Spec states required behavior: interactions and acceptance scenarios. The Plan owns the technical decisions (design, component and interface changes, data flow) and the detailed execution plan (ordered tasks, tests, exit conditions, validation, and rollback).
3. Review the behavior and technical design before implementing the affected scope. The Plan must resolve implementation decisions rather than leave them to the implementer; keep it blocked while a material decision is unresolved. New behavior revises the Spec. New implementation decisions revise the Plan.
4. Implement inside that boundary. Add evidence for each acceptance condition, or say why existing evidence is enough. Update current-state docs in the same change.
5. Before retiring a completed Spec or Plan, move still-valid behavior, invariants, and operational limits into current-state docs and tests. The final delivery PR may delete the completed files. Keep an unfinished Spec or Plan active.
6. Git history and the delivery PR keep the retired decision. Do not copy completed Specs or Plans into a second archive.

## Change Design Gate

Every change needs a requirement record. Use the smallest set of artifacts that makes behavior and implementation reviewable.

| Change type | Required artifact |
| --- | --- |
| Product behavior | One Spec plus one detailed Plan for the same deliverable |
| Technical refactor without changed user behavior | Detailed Plan with compatibility and acceptance conditions |
| Narrow maintenance, tests, or documentation | Requirement and PR checklist; a separate Plan only when useful |

A Spec defines observable interactions, scope, failure behavior, and acceptance examples. Use stable scenario IDs and Given/When/Then where useful. Link scenarios to tests. A Spec does not prescribe components, interfaces, or execution order. Keep active Specs under [`docs/specs/`](docs/specs/). A small change may keep both sections in the PR description. Split only when each slice has an independently demonstrable outcome.

A Plan records technical decisions and the detailed execution plan that implements them. Shared architecture, compatibility, security, and recovery decisions belong in a reviewed Plan. After implementation, move lasting constraints into current-state architecture or operations docs. This template does not keep an RFC directory. Removing a proposal does not mark unimplemented ideas as delivered.

## Implementation Plans

[`docs/plans/`](docs/plans/) contains active Plans: technical decisions plus a detailed execution plan. Copy [`0000-template.md`](docs/plans/0000-template.md) and keep only the sections that apply. A product plan links its paired Spec. Explain the current constraints, the decisions, the boundaries, the failure and rollback behavior, and how the change will be verified. A file list alone is not a design.

The execution plan tells the implementer exactly what to do: preconditions, a completion contract, ordered tasks with files, changes, tests, and exit conditions, a validation ledger, and rollback per batch. Keep the plan blocked while a decision that changes scope, interfaces, data, or rollout is unresolved.

Keep unknown owners, dates, and interfaces marked "unconfirmed". A plan may make feature-specific technical decisions, but it cannot silently override current architecture. At completion, migrate lasting constraints into current-state docs and tests, then delete the completed Spec and plan in the final delivery PR. Keep unfinished scope visible.

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
- Use `docs/specs/` for active product behavior and acceptance contracts.
- Use `docs/plans/` for active technical decisions and detailed execution plans. Migrate lasting decisions into current-state docs.
- Use `docs/` for durable current-state knowledge: architecture, development guides, operational runbooks, references, and onboarding tutorials.

Follow `docs/README.md` when adding or reorganizing project documentation. Update docs in the same change as behavior, configuration, command, API, deployment, architecture, or operational changes. Keep examples runnable when possible; otherwise, label them as illustrative and explain the validation gap.

## Pull Request Expectations

The PR/MR template has three sections:

- **Summary**: what changed and why, with links to the issue, Spec, or Plan.
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

Release notes come from the release tool. `pnpm version -r` writes each published package's `CHANGELOG.md` from the changesets in `.changeset/` (see [Changesets](#changesets)) and records consumption in `.changeset/ledger.yaml`. Do not edit generated changelogs or keep a hand-written root `CHANGELOG.md` beside them.

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

Workflows reference actions by their latest major version tag, such as `actions/checkout@v7`, not by commit SHA. Workflow files copied from this template take action upgrades from the template rather than local edits.

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
