# npm Release Runbook

Changesets owns change records (`pnpm changeset`), version bumps and changelogs (`changeset version`) and
publishing (`changeset publish`), configured in `.changeset/config.json`. `@rivus/snorlax` (`packages/collector`)
is the only package this repository publishes; GitHub Actions publishes it to npm with npm Trusted Publishing
(OIDC) and provenance. A merged version PR publishes, and the workflow pushes the tag `@rivus/snorlax@<version>`
and creates its GitHub Release. No long-lived npm token is stored in the repository or its secrets.

| Step | Where | Result |
| --- | --- | --- |
| Changeset | feature PR | `.changeset/<name>.md`, written with `pnpm changeset` or by hand; CI does not check for it |
| Version PR | `publish.yml`, on each push to `main` with pending changesets | draft PR `chore(release): version packages` from `changeset-release/main`, whose body lists the package's new changelog section |
| Version PR merge | GitHub, the release decision | bumped `package.json` version and `CHANGELOG.md` on `main`, no pending changesets |
| Publish | `publish.yml`, on the merge push | the release gates run, the package publishes, and the workflow pushes its tag and creates its GitHub Release |

Each row is a separate completion state. A merged version PR is not a published release, and a started publish
workflow is not a published package.

## The Release Workflow

`publish.yml` runs on every push to `main` (a PR merge is a push) and on manual dispatch. It calls the shared
workflow `PerfectPan/gh-repo-checks/.github/workflows/npm-release.yml@v1`, whose
[runbook](https://github.com/PerfectPan/gh-repo-checks/blob/v1/docs/npm-release.md) describes each job and its
recovery:

1. **select release mode** (read-only) runs `changesets/action/select-mode`: `version` for pending records,
   `publish` for unpublished versions without pending records, or `none` when there is no release work. `none`
   skips the remaining jobs. In `version` mode `gh repo-checks release-plan` checks the pending records again. In
   both modes `gh repo-checks first-publish` uses `npm view` to require an existing npm version: in `version` mode
   for the release plan's affected public packages, so an unrelated new package does not block an existing
   package's version PR, and in `publish` mode for all public, non-ignored packages.
2. **version packages** opens or updates the draft version PR with `pnpm run version-packages`. The version commit
   goes through the GitHub API, so GitHub signs it.
3. **check and pack packages** (read-only, `publish` mode) runs the repository's complete gate (`pnpm run check`)
   and the one input this repository sets, `audit-command: pnpm --filter @rivus/snorlax audit --audit-level=high`:
   the collector bundles its devDependencies into `dist`, so a `--prod` audit would skip the code that ships. The
   filter does not follow workspace packages, so a runtime dependency of the bundled `@rivus/snorlax-protocol` is
   audited only because the collector declares it too (see the comment in `publish.yml`). It then packs the
   unpublished version.
4. **publish packages** is the only job with the OIDC permission. It installs without lifecycle scripts, publishes
   the packed tarball through Trusted Publishing, pushes the tag and creates the GitHub Release.

Runs share one concurrency group with `cancel-in-progress: false`: a push waits for the running run, and GitHub
keeps only the newest waiting run, cancelling older waiting ones.

## Changesets

A PR that changes what `@rivus/snorlax` ships (source, manifest, build config, or a bundled protocol change) or the
lockfile carries a changeset. CI does not check for a missing one; the author adds it and the reviewer looks for
it. Write it with:

```bash
pnpm changeset add --patch @rivus/snorlax -m "Correct the doctor verdict line."
```

Interactive form: `pnpm changeset` prompts for the packages, the bump and the message, and needs a terminal. The
command writes `.changeset/<name>.md`, which you can also write by hand under any short kebab-case name:

```markdown
---
"@rivus/snorlax": patch
---

Correct the doctor verdict line.
```

The summary becomes the changelog entry, so write it for users of the package. Rules for the bump:

- Use `patch` for fixes and `minor` for features. While `@rivus/snorlax` is 0.x, a breaking change is also `minor`:
  `major` would release 1.0.0, and `gh repo-checks release-plan` rejects it unless the PR that adds the record also
  lists `allow-major @rivus/snorlax` in `.github/repo-checks.conf`. Remove that line after 1.0.0 is published.
- Name only `@rivus/snorlax`. `@rivus/snorlax-protocol` and `@rivus/snorlax-worker` are private, and
  `privatePackages.version: false` means Changesets never versions them. A record naming only a private package is
  never consumed by `changeset version`, so it stays pending and the flow would never publish again; a record
  naming a private package beside `@rivus/snorlax` fails `changeset version` outright.
  `gh repo-checks release-plan`, which CI runs on every pull request, rejects both, including `none` records.
  Describe a protocol change by its effect on `@rivus/snorlax` instead.
- `pnpm changeset status --verbose` prints the pending changesets and the version they would release.

## Versioning Configuration

`.changeset/config.json` sets `privatePackages: { version: false, tag: false }`, so the private workspace packages
are never versioned or tagged, and `["@changesets/changelog-github", { "repo": "PerfectPan/snorlax" }]` writes PR
links, commit links and author thanks into `packages/collector/CHANGELOG.md`. The changelog generator reads PR
data through the GitHub API, so the version step needs `GITHUB_TOKEN`; the action provides it in CI. The shared
`fmt` of `@perfectpan/lint-config` ignores the generated `CHANGELOG.*`: the generator indents the blank lines of a
multi-paragraph summary, which `format:check` would otherwise reject in the version PR. Preview the version PR
locally in a throwaway worktree with `GITHUB_TOKEN=$(gh auth token) pnpm run version-packages`, then discard the
result.

`fixed: []`: with one published package there is nothing to group. When a second published package appears,
decide between a `fixed` group (lockstep releases at one shared version) and independent versions, and document
the choice here. If the new package's `vite.config.ts` sets its own `fmt.ignorePatterns`, start the list with
`...fmt.ignorePatterns`, or its first version PR fails `format:check` on the generated changelog.

## First Releases

Publishing a package name that has never existed on npm fails at the trusted-publishing exchange: OIDC cannot create
package names. The first-publish check in select release mode stops the Release workflow before it creates a version
PR for a new package name. `@rivus/snorlax` has no version on npm yet, so every run with pending records fails that
check until the placeholder publish in One-Time Setup exists. Publish the placeholder and re-run the failed run to get
the version PR; configure the trusted publisher right before merging that PR (see One-Time Setup for why not earlier).

The placeholder `0.0.0` never collides with real releases, which are higher. The manifest's `0.1.0` was never
published, and the pending records include `minor` bumps, so the first version PR releases `0.2.0`.

## One-Time Setup

### Repository

1. Keep the repository public. pnpm attaches provenance only when the repository and the package are public; from a
   private repository it publishes without provenance.
2. Every published `package.json` has `repository.url` pointing at this GitHub repository
   (`git+https://github.com/PerfectPan/snorlax.git`), `publishConfig.access: "public"`, and a `files` list. npm
   rejects provenance when the repository does not match, and a scoped package without public access cannot
   publish.
3. Let GitHub Actions create pull requests: **Settings → Actions → General → Workflow permissions → Allow GitHub
   Actions to create and approve pull requests**. The Release workflow fails without it, on the first push to `main`
   that leaves changesets pending.

### npm Trusted Publisher

A trusted publisher is configured per package name, and npm only offers the setting for a package that already
exists:

1. **First publish only.** OIDC cannot create a new package name, so a maintainer publishes a placeholder `0.0.0`
   once, with their own npm login:

   ```bash
   dir="$(mktemp -d)" && cd "$dir"
   printf '{"name":"@rivus/snorlax","version":"0.0.0","description":"Placeholder; releases are published by CI."}\n' > package.json
   npm publish --access public
   npm deprecate @rivus/snorlax@0.0.0 "Placeholder; install a later version."
   ```

   The `@rivus` scope must belong to an npm organization or user the maintainer owns. Skip this step if the name
   already exists on npm.
2. On npmjs.com open the package **Settings → Trusted Publisher → GitHub Actions** and enter the owner
   `PerfectPan`, the repository `snorlax`, the workflow filename `publish.yml`, and no environment. The trusted
   publisher is bound to that file name, so renaming the workflow means configuring it again. Enable **direct
   publishing** ("Allow npm publish"): new configurations default to staged publishing only, and `pnpm publish`
   then fails with an authorization error. The CLI equivalent (npm 11.15 or later, two-factor authentication on
   the account) is:

   ```bash
   npm trust github @rivus/snorlax --repo PerfectPan/snorlax --file publish.yml --allow-publish
   npm trust list @rivus/snorlax
   ```

   A new configuration expires unless a publish uses it within 2 days, so create it right before merging the first
   version PR, not days ahead.
3. Under **Publishing access**, select "Require two-factor authentication and disallow tokens" so that only the
   trusted workflow can publish.

The workflow filename in the form is `publish.yml`, the file `.github/workflows/publish.yml`: npm checks this calling
file, not the shared workflow it calls. Its `release` job grants `id-token: write` (the OIDC token the exchange
requires), which the shared workflow passes only to its publish job, and neither sets an `environment:`, which is why
the form's environment stays empty. Neither reads `NPM_TOKEN` or `NODE_AUTH_TOKEN`. A form whose workflow filename or
environment does not match this file fails the exchange even after the placeholder publish.

`@rivus/snorlax-protocol` and `@rivus/snorlax-worker` are private: they need no trusted publisher and no placeholder
release. A package that later becomes public needs its own placeholder and trusted publisher; one package's trusted
publisher does not authorize another.

## Cutting a Release

1. Merge feature PRs with changesets (see [Changesets](#changesets)).
2. Each such merge runs the Release workflow. With pending records, the version job runs `pnpm run
   version-packages`: `changeset version` consumes the changesets, bumps the package, writes its changelog
   (with PR links and author thanks) and deletes the consumed records. The action then commits the result through
   the GitHub API (signed) and opens or updates the draft PR `chore(release): version packages` from
   `changeset-release/main`; the PR body lists the package's new `CHANGELOG.md` section. Every later push with
   changesets regenerates the PR from the new `main`. **Actions → Release → Run workflow** on `main` rebuilds it
   on demand, for example after the PR was closed by hand. The bump comes only from the changesets: to release a
   different bump, merge a changeset with that bump.
3. Every version update leaves the version PR in Draft (`pr-draft: always`). Pull request events created with
   `github.token` do not start workflows, so CI has not run on it yet. Review the version and changelog diff, then
   select **Ready for review** to start CI. Each update returns the PR to Draft, so repeat this step after an
   update. GitHub can require an authorized maintainer to select **Approve workflows to run** for PR events created
   with `github.token`; see [GitHub's trigger behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow).
4. Confirm the `check` and `macos` jobs actually ran and passed for the current head alongside the Review checks,
   and squash-merge. Merging the version PR is the release decision.
5. The merge push runs the Release workflow on the merge commit, where no record is pending: select-mode chooses
   `publish`, a read-only job runs the gates and the audit and packs the unpublished version, and the publish job's
   `changeset publish` runs `pnpm publish` on that tarball through Trusted Publishing. pnpm sends the job's OIDC token
   and attaches provenance itself. The action pushes the tag `@rivus/snorlax@X.Y.Z` and creates the GitHub Release
   with the version's changelog section.
6. Verify the package at the new version, for example `npm view @rivus/snorlax@X.Y.Z`, `git ls-remote --tags
   origin`, the GitHub Release, and a clean `npm install -g @rivus/snorlax@X.Y.Z` in a scratch prefix. Registry
   reads can lag the publish by a minute; retry the read, not the publish. The npm package page shows a provenance
   badge linking to the workflow run.

## Bot Pull Requests

- **Version PR**: see step 3 above. Its title already passes `gh repo-checks pr-title`; bot PRs skip the description check.
- **Dependabot npm PRs**: one weekly PR carries every minor and patch npm update, and a second one every major.
  Dependabot officially supports pnpm 7–10; on pnpm 12 its support is limited (dependabot-core#16397), so a PR may
  edit `package.json` files or the catalog in `pnpm-workspace.yaml` without regenerating the root
  `pnpm-lock.yaml`. Check out the branch, run `pnpm install`, and commit the lockfile so CI runs green. A
  `vite-plus` bump and the matching `vite` alias
  (`npm:@voidzero-dev/vite-plus-core`) land in separate PRs; add the alias bump to the first branch before
  merging so the two stay in lockstep. Add a `patch` changeset for `@rivus/snorlax` when an update changes what it
  bundles or its runtime behavior.
- **Dependabot GitHub Actions PRs** move an action to its next major version tag (for example `actions/checkout@v7` to
  `@v8`); minor and patch releases need no PR because workflows reference the major tag. `publish.yml` references the
  shared release workflow's `v1` tag the same way, and that workflow pins the changesets actions itself. Merge them
  for this repository's own workflows (`ci.yml`, `publish.yml`). Close PRs that touch `review.yml` or another file
  synced from [PerfectPan/project-template](https://github.com/PerfectPan/project-template), with a comment that the
  bump comes from upstream, and sync the file once upstream has it. Dependabot cannot ignore an action per file, so
  these PRs keep appearing.

## Failure Recovery

The action publishes only when no record is pending; with records pending it prepares the version PR instead, even
if an earlier version is still unpublished. Recovery therefore re-runs the run of the release commit itself whenever
it can.

- **select release mode failed**: `release-plan` names a record to fix or remove, or the package a major record
  would move to 1.0.0. `first-publish` names a package name with no version on npm: publish the placeholder
  (One-Time Setup), then re-run the failed run. Nothing was versioned or published.
- **Version step failed** (`changeset version`, changelog lookup): nothing changed on `main` or the release branch.
  Re-run the latest run for a transient failure; otherwise fix the cause in a reviewed PR, whose merge regenerates
  the version PR. A missing `GITHUB_TOKEN` fails this step.
- **Gates failed before publication**: nothing is tagged or published. Re-run for a transient failure. Otherwise fix
  the cause in a reviewed PR: a fix without records publishes the same version from its merge push; a fix with
  records goes into the next version PR and that unpublished version is skipped. GitHub allows re-running a run for
  30 days; after that, only **Run workflow** on `main` remains, and only while no record is pending.
- **The version PR's merge run was cancelled or failed**: re-run that run. It keeps the merge commit, where no
  record is pending, so it publishes. If a later push with records ran instead, it prepared the next version PR and
  the merged version stays unpublished until this re-run. Avoid merging PRs with records while the merge run is
  still waiting.
- **Publication stopped part-way**: use **Re-run failed jobs** on the failed run, which keeps its commit and packed
  tarball; `changeset publish` skips versions already on npm and tags the rest on the run's commit. **Run workflow**
  on `main` does the same only while no record is pending, and it tags the current `main` commit instead of the
  release commit. Never bump the version to retry, and never unpublish.
- **Published but the tag or Release is missing**: the version is already on npm, so re-runs do not add them.
  Create them by hand on the release commit: `gh release create '@rivus/snorlax@X.Y.Z' --target <release commit>`
  with the version's changelog section as notes.
- **Version PR closed by hand or out of date**: **Run workflow** on `main` rebuilds it from the pending records.
- **Trusted Publishing rejected the package**: fix its trusted publisher on npmjs.com (owner, repository, workflow
  file name, environment, direct publishing allowed) and re-run.
- **A record is never consumed**: it names a private or ignored package. Remove it or move its note to
  `@rivus/snorlax`; `gh repo-checks release-plan` names it in CI and in select release mode.
- **Bad published contents**: npm versions are immutable. Deprecate the version and release a fix:

  ```bash
  npm deprecate @rivus/snorlax@X.Y.Z "Broken build; use X.Y.Z+1"
  ```

  Move a dist-tag back when `latest` must point at the previous version:
  `npm dist-tag add @rivus/snorlax@<previous> latest`. `npm unpublish` is limited to 72 hours after publishing
  and blocks the version number permanently; prefer deprecation.
- Once a version is on npm, do not move or reuse its tag. Fix forward with a new version.

## CI Trigger Options

`ci.yml` runs on ordinary `pull_request` and `push` events, which is enough for a single-maintainer repository. A
repository that wants CI to validate an exact head/base pair, or to skip CI on drafts, can replace it with a
`workflow_dispatch` workflow that takes `head_sha`/`base_sha` inputs and re-checks the PR head before and after the
run. That design costs a manual trigger per PR; adopt it only when stale or racing CI results are a real problem.
