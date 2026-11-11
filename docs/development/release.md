# npm Release Runbook

Changesets owns change records (`pnpm changeset`), version bumps and changelogs (`changeset version`) and
publishing (`changeset publish`), configured in `.changeset/config.json`. `@rivus/snorlax` (`packages/collector`)
is the one package published to npm, by GitHub Actions with npm Trusted Publishing (OIDC) and provenance. A merged
version PR publishes and the workflow pushes the tag `@rivus/snorlax@<version>` and creates the GitHub Release.
`@rivus/snorlax-protocol` and `@rivus/snorlax-worker` are private (`"private": true`): they are never versioned,
tagged or published, and the macOS app ships them bundled. No long-lived npm token is stored in the repository or
its secrets.

| Step | Where | Result |
| --- | --- | --- |
| Changeset | feature PR | `.changeset/<name>.md`, written with `pnpm changeset` or by hand; CI does not check for it |
| Version PR | `publish-npm.yml`, on each push to `main` with pending changesets | draft PR `chore(release): version packages` from `changeset-release/main`, whose body lists the new changelog section |
| Version PR merge | GitHub, the only manual step | bumped `package.json` version and `CHANGELOG.md` on `main`, no pending changesets |
| Publish | `publish-npm.yml`, on the merge push | the release gates run, the package publishes, and the workflow pushes the tag and creates the GitHub Release |

Each row is a separate completion state. A merged version PR is not a published release, and a started publish
workflow is not a published package.

## The Release Workflow

`publish-npm.yml` runs on every push to `main` (a PR merge is a push) and on manual dispatch. One job:

1. `changesets/action/select-mode@v2.1.2` chooses `version` when non-empty changesets are pending,
   `publish` when there are no changesets and unpublished versions exist, or `none` when no work is needed.
2. Before either versioning or publishing, `npm view @rivus/snorlax version` checks that the package name
   already exists on npm. A missing name or registry failure stops the workflow before a version PR is created.
   Complete [One-Time Setup](#one-time-setup) first.
3. Only `publish` mode runs the repository's complete gate (`pnpm run check`, which includes
   `scripts/check-release-plan.mjs`) and a production-dependency audit before publishing.
4. For `version` or `publish`, `changesets/action` runs its native version/publish path: it opens or updates
   the draft version PR from pending change records, or publishes unpublished versions when no records remain.
   The version commit goes through the GitHub API, so GitHub signs it. Mode `none` skips the action.

Runs share one concurrency group with `cancel-in-progress: false`: a push waits for the running run, and GitHub
keeps only the newest waiting run, cancelling older waiting ones.

## Changesets

A PR that changes what the published package ships (source, manifest, build config) or the lockfile carries a
changeset. CI does not check for a missing one; the author adds it and the reviewer looks for it. Write it with:

```bash
pnpm changeset add --patch @rivus/snorlax -m "Correct the refresh command."
```

Interactive form: `pnpm changeset` prompts for the packages, the bump and the message, and needs a terminal. The
command writes `.changeset/<name>.md`, which you can also write by hand under any short kebab-case name:

```markdown
---
"@rivus/snorlax": patch
---

Correct the refresh command.
```

The summary becomes the changelog entry, so write it for users of the package. Rules for the bump:

- Use `patch` for fixes, `minor` for additions and `major` for a deliberate breaking release. There is no
  repository-specific major-bump cap.
- A change inside a private package that the app or the collector bundles needs no release note: private packages
  are never versioned. A record naming a private or ignored package is never consumed by `changeset version`, including `none` entries,
  so `check-release-plan.mjs` rejects it; name `@rivus/snorlax` or delete the record.
- `pnpm changeset status --verbose` prints the pending changesets and the version they would release.

## Versioning Configuration

`.changeset/config.json` sets `privatePackages: { version: false, tag: false }`, so the private packages are never
versioned or tagged, and `changelog-github` writes PR links and author thanks into the package's `CHANGELOG.md`.
The single published package versions independently (`fixed: []`); when a second published package appears, decide
between adding it to a `fixed` group (lockstep releases) and keeping independent versions, and document the choice
here.

## First Releases

OIDC cannot create a package name that has never existed on npm. The workflow's `npm view` check blocks it
before creating the version PR until `@rivus/snorlax` has an npm release. Finish the
placeholder publish and Trusted Publisher setup below first (tracked in #35), then re-run the Release workflow.
The placeholder `0.0.0` never collides with real releases, which are higher. The same check runs before publication
so a newly added name cannot reach the OIDC exchange without setup.

## One-Time Setup

### Repository

1. Keep the repository public. pnpm attaches provenance only when the repository and the package are public; from a
   private repository it publishes without provenance.
2. The published `package.json` has `repository.url` pointing at this GitHub repository (`git+https://github.com/OWNER/REPO.git`)
   and `publishConfig.access: "public"`, and lists published files in `files`. npm rejects provenance when the
   repository does not match, and a scoped package without public access cannot publish.
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

   Scoped packages need an npm organization or user scope that the maintainer owns. Skip this step if the name
   already exists on npm.
2. On npmjs.com open the package **Settings → Trusted Publisher → GitHub Actions** and enter the owner, the
   repository, the workflow filename `publish-npm.yml`, and no environment (unless you add one to the workflow).
   The trusted publisher is bound to that file name, so renaming the workflow means configuring it again.
   Enable **direct publishing** ("Allow npm publish"): new configurations default to staged publishing only, and
   `pnpm publish` then fails with an authorization error. The CLI equivalent (npm 11.15 or later, two-factor
   authentication on the account) is:

   ```bash
   npm trust github @rivus/snorlax --repo PerfectPan/snorlax --file publish-npm.yml --allow-publish
   npm trust list @rivus/snorlax
   ```

   A new configuration expires unless a publish uses it within 2 days, so create it right before merging the first
   version PR, not days ahead.
3. Under **Publishing access**, select "Require two-factor authentication and disallow tokens" so that only the
   trusted workflow can publish.

The workflow filename in the form is `publish-npm.yml`, the file `.github/workflows/publish-npm.yml`. Its
`release` job sets `permissions.id-token: write` (that permission is the OIDC token the exchange requires) and
sets no `environment:`, which is why the form's environment stays empty. The job does not read `NPM_TOKEN` or
`NODE_AUTH_TOKEN`. A form whose workflow filename or environment does not match this file fails the exchange even
after the placeholder publish.

## Cutting a Release

1. Merge feature PRs with changesets (see [Changesets](#changesets)).
2. Each such merge runs the Release workflow. With pending records, `changesets/action` runs `pnpm run
   version-packages`: `changeset version` consumes the changesets, bumps the package, writes its changelog (with
   PR links and author thanks) and deletes the consumed records. The action then commits the result through the
   GitHub API (signed) and opens or updates the draft PR `chore(release): version packages` from
   `changeset-release/main`; the PR body lists the package's new `CHANGELOG.md` section. Every later push with
   changesets regenerates the PR from the new `main`. **Actions → Release → Run workflow** on `main` rebuilds it
   on demand, for example after the PR was closed by hand. The bump comes only from the changesets: to release a
   different bump, merge a changeset with that bump.
3. Every version update leaves the version PR in Draft (`pr-draft: always`). CI runs on Draft PR events too.
   Review the version and changelog diff and select **Ready for review** before merging. Confirm that `check` and
   `macos` actually ran and passed for the current head and merge result before squash-merging. PR events created
   with `github.token` may require maintainer approval; follow any GitHub approval prompt.
4. The merge push runs the Release workflow on the merge commit, where no record is pending: `select-mode` chooses
   `publish`, the gates run, and `changeset publish` publishes it through Trusted Publishing. The action
   pushes the tag `@rivus/snorlax@X.Y.Z` and creates the GitHub Release with the changelog section. Merging the
   version PR is the release decision.
5. Verify the version, for example `npm view @rivus/snorlax@X.Y.Z`, `git ls-remote --tags origin`, the GitHub
   Release, and a clean `npm install` in a scratch project. Registry reads can lag the publish by a minute; retry
   the read, not the publish. The npm package page shows a provenance badge linking to the workflow run.

## Bot Pull Requests

- **Version PR**: see step 3 above. Its title already passes `gh repo-checks pr-title`; bot PRs skip the description check.
- **Dependabot npm PRs**: one weekly PR carries every minor and patch npm update, and a second one every major.
  Dependabot officially supports pnpm 7–10; on pnpm 12 its support is limited (dependabot-core#16397), so a PR may
  edit `package.json` files or the catalog in `pnpm-workspace.yaml` without regenerating the root
  `pnpm-lock.yaml`. Check out the branch, run `pnpm install`, and commit the lockfile so CI runs green. A
  `vite-plus` bump and the matching `vite` alias
  (`npm:@voidzero-dev/vite-plus-core`) land in separate PRs; add the alias bump to the first branch before
  merging so the two stay in lockstep. Dependabot moves a peer together with the matching devDependency; moving an
  exact peer is a `minor` change, since hosts pinning the old version then fail to install, so do not run a release
  with only `patch` changesets for a release that carries one. Add a `patch` changeset for published
  packages whose runtime dependencies or peers changed.
- **Dependabot GitHub Actions PRs** move an action to its next major version tag (for example `actions/checkout@v7`
  to `@v8`); minor and patch releases need no PR because workflows reference the major tag. Merge them for this
  repository's own workflows (`ci.yml`, `publish-npm.yml`). Close PRs that touch `review.yml` or another file
  synced from [PerfectPan/project-template](https://github.com/PerfectPan/project-template), with a comment that the
  bump comes from upstream, and sync the file once upstream has it. Dependabot cannot ignore an action per file, so
  these PRs keep appearing.

## Failure Recovery

The action publishes only when no record is pending; with records pending it prepares the version PR instead, even
if an earlier version is still unpublished. Recovery therefore re-runs the run of the release commit itself whenever
it can.

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
- **Publication stopped part-way**: re-run the failed run; `changeset publish` skips versions already on npm and
  tags the rest on the run's commit. **Run workflow** on `main` does the same only while no record is pending, and
  it tags the current `main` commit instead of the release commit. Never bump the version to retry, and never
  unpublish.
- **Published but the tag or Release is missing**: `select-mode` finds nothing to publish, so re-runs do not add them. Create them by hand on the release commit:
  `gh release create '@rivus/snorlax@X.Y.Z' --target <release commit>` with the package's changelog section as
  notes.
- **Version PR closed by hand or out of date**: **Run workflow** on `main` rebuilds it from the pending records.
- **Trusted Publishing rejected the package**: fix the trusted publisher on npmjs.com (owner, repository, workflow
  file name, environment) and re-run. A package name that never existed on npm needs the placeholder first publish
  (see [First Releases](#first-releases)).
- **A record is never consumed**: it names a private or ignored package. Remove it or move its note to
  `@rivus/snorlax`; `check-release-plan.mjs` names it.
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
