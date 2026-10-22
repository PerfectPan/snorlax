# npm Release Runbook

pnpm owns change records (`pnpm change`), version bumps (`pnpm version -r`) and changelogs. Published packages
under `packages/` are published to npm by GitHub Actions with npm Trusted Publishing (OIDC) and provenance. No
long-lived npm token is stored in the repository or its secrets.

| Step | Where | Result |
| --- | --- | --- |
| Changeset | feature PR | `.changeset/<name>.md`, written with `pnpm change` or by hand |
| Version Packages | `version-packages.yml` (manual) | draft PR `chore(release): version packages` on `changeset-release/main`; the PR body lists each release |
| Release PR merge | GitHub | bumped `package.json` versions, `CHANGELOG.md` per package, `.changeset/ledger.yaml`, no pending changesets |
| GitHub Release | GitHub UI or `gh release create` | tag `vX.Y.Z` on the release commit |
| Publish | `publish-npm.yml` (on Release `published`) | packages on npm with provenance |

Each row is a separate completion state. A merged release PR is not a published release, and a started publish
workflow is not a published package.

## Versioning Configuration

`pnpm-workspace.yaml` sets `versioning.changelog.storage: repository`, so `pnpm version -r` deletes consumed
changesets immediately and commits each package's `CHANGELOG.md`. The default (`registry`) keeps changesets until
the registry confirms publication; the changesets action would then keep reopening a version PR forever, because
it decides from the remaining `.changeset/*.md` files.

All published packages release in lockstep through the `versioning.fixed` group: `pnpm version -r` bumps the whole
group together at one shared version, and one release tag covers it — `scripts/check-release.ts` requires every
published package to carry the tag's version and says so when a package lags behind. Add every new published
package to the group. A package that should never version belongs in `versioning.ignore`.

`pnpm change status` previews the pending release plan, and `pnpm change check` validates committed versions
against `versioning.fixed` groups without reading intents.

## First Releases

Publishing a package name that has never existed on npm fails at the trusted-publishing exchange (OIDC cannot
create package names), while `pnpm version -r` consumes the changesets either way. The Version Packages workflow
therefore runs `scripts/check-first-publish.ts` first and fails while any published package has no version on npm.

This is why the setup below publishes a placeholder `0.0.0` once. Afterwards the first Version Packages run bumps
`0.0.0 → 0.1.0` from the kept `minor` "Initial release." changeset in `.changeset/`. Measured on pnpm 12.8.1: with
the `versioning.fixed` group, the pending intent applies to the group's shared version even before that version
was ever published; without a fixed group, pnpm's rule (11.16+) is that a never-published package debuts at its
manifest version verbatim and pending changesets apply from the next release only.

## One-Time Setup

### Repository

1. Keep the repository public. pnpm attaches provenance only when the repository and the package are public; from a
   private repository it publishes without provenance.
2. Every published `package.json` has `repository.url` pointing at this GitHub repository (`git+https://github.com/OWNER/REPO.git`)
   and `publishConfig.access: "public"`. npm rejects provenance when the repository does not match, and
   `pnpm run release:check` enforces both.
3. Let GitHub Actions create pull requests: **Settings → Actions → General → Workflow permissions → Allow GitHub
   Actions to create and approve pull requests**. Version Packages fails without it.

### npm Trusted Publisher, per package

A trusted publisher is configured per package name, and npm only offers the setting for a package that already
exists. For each package:

1. **First publish only.** OIDC cannot create a new package name, so a maintainer publishes a placeholder `0.0.0`
   once, with their own npm login:

   ```bash
   dir="$(mktemp -d)" && cd "$dir"
   printf '{"name":"@scope/example","version":"0.0.0","description":"Placeholder; releases are published by CI."}\n' > package.json
   npm publish --access public
   npm deprecate @scope/example@0.0.0 "Placeholder; install a later version."
   ```

   Scoped packages need an npm organization or user scope that the maintainer owns. Skip this step if the name
   already exists on npm. Until the placeholder exists, the Version Packages workflow fails its first-publish check
   (`scripts/check-first-publish.ts`) instead of consuming changesets for a package that cannot publish.
2. On npmjs.com open the package **Settings → Trusted Publisher → GitHub Actions** and enter the owner, the
   repository, the workflow filename `publish-npm.yml`, and no environment (unless you add one to the workflow).
3. Under **Publishing access**, select "Require two-factor authentication and disallow tokens" so that only the
   trusted workflow can publish.

One package's trusted publisher does not authorize another. A publish for an unconfigured package fails with an
authentication error for that package only.

## Cutting a Release

1. Merge feature PRs that carry changesets (`.changeset/*.md`). Changesets are not CI-enforced; whether a change
   rides a release is the maintainer's call. The release bump is the largest bump across the pending changesets —
   to release a major, merge a `major` changeset first.
2. Run **Actions → Version Packages → Run workflow** on `main`. The workflow first requires every published
   package to have a version on npm — a missing first publish fails the run (see One-Time Setup). The changesets
   action runs `pnpm run version-packages` (`pnpm version -r`), which consumes the pending changesets, bumps
   package versions, writes
   each package's `CHANGELOG.md` and records consumption in `.changeset/ledger.yaml`. The action commits through
   the GitHub API (signed) and opens or updates the draft PR `chore(release): version packages` from
   `changeset-release/main`. The PR body lists every released package with its new changelog section.
3. Start CI on the release PR. Pull requests created with `github.token` do not trigger workflows. Select **Ready
   for review** (the `ready_for_review` event starts CI), or close and reopen the PR. Pushing an empty commit to
   the branch also works. To avoid the manual step, pass an App token or a fine-grained PAT to the changesets
   action's `github-token` input in `.github/workflows/version-packages.yml` — never through the `GITHUB_TOKEN`
   environment variable, which the action rejects when it differs from the input.
4. Review the version and changelog diff, wait for green checks, and squash-merge.
5. Check the release identity locally on the merged release commit:

   ```bash
   git switch main && git pull
   pnpm run release:check -- vX.Y.Z --repository OWNER/REPO
   ```

   The check requires the tag version on every published package, `publishConfig.access: "public"`, a `files`
   list, a matching `repository.url`, and no pending changesets.
6. Create a non-prerelease GitHub Release with tag `vX.Y.Z` targeting the release commit (not a later `main`):

   ```bash
   gh release create vX.Y.Z --target <release-commit-sha> --generate-notes
   ```

   `publish-npm.yml` checks out the tag, verifies the tag equals the package versions and the commit is on
   `main` (`release:check --verify-git`), runs `pnpm run check`, then runs
   `pnpm publish -r --access public --no-git-checks`. pnpm publishes natively, sends the workflow's OIDC token and
   attaches provenance itself, and skips packages whose version already exists on npm. Prereleases do not publish.
7. Verify every package at the new version, for example `npm view @scope/example@X.Y.Z` and a clean
   `npm install` in a scratch project. Registry reads can lag the publish by a minute; retry the read, not the
   publish. The npm package page shows a provenance badge linking to the workflow run.

`pnpm run publish:dry-run` runs the same `pnpm publish -r` command with `--dry-run --json`: it does everything a
publish would do except uploading, and prints, per package a publish would upload, the version and the file list.
Run it after `pnpm run check` so `dist` exists.

## Bot Pull Requests

- **Release PR**: see step 3 above. Its title already passes `gh repo-checks pr-title`; bot PRs skip the description check.
- **Dependabot npm PRs**: one weekly PR carries every minor and patch npm update, and a second one every major.
  Dependabot officially supports pnpm 7–10; on pnpm 12 its support is limited (dependabot-core#16397), so a PR may
  edit `package.json` files or the catalog in `pnpm-workspace.yaml` without regenerating the root
  `pnpm-lock.yaml`. Check out the branch, run `pnpm install`, and commit the lockfile so CI runs green. A
  `vite-plus` bump and the matching `vite` alias
  (`npm:@voidzero-dev/vite-plus-core`) land in separate PRs; add the alias bump to the first branch before
  merging so the two stay in lockstep. Dependabot moves a peer together with the matching devDependency; moving an
  exact peer is a `minor` change, since hosts pinning the old version then fail to install, so do not run Version
  Packages with only `patch` changesets for a release that carries one. Add a `patch` changeset for published
  packages whose runtime dependencies or peers changed.
- **Dependabot GitHub Actions PRs** move an action to its next major version tag (for example `actions/checkout@v7`
  to `@v8`); minor and patch releases need no PR because workflows reference the major tag. Merge them for this
  repository's own workflows (`ci.yml`, `version-packages.yml`, `publish-npm.yml`). Close PRs that touch `review.yml` or another file
  synced from [PerfectPan/project-template](https://github.com/PerfectPan/project-template), with a comment that the
  bump comes from upstream, and sync the file once upstream has it. Dependabot cannot ignore an action per file, so
  these PRs keep appearing.

## Failure Recovery

- **Validation fails before publishing** (`release:check`, `pnpm run check`): nothing was published. Fix the cause
  in a new PR, then delete the GitHub Release and its tag and create them again on the fixed commit, or cut the
  next version. This is the only case where a tag may be recreated.
- **Authentication fails for a package**: configure its trusted publisher, then re-run the failed workflow run.
  pnpm skips packages already published at that version, so a re-run only publishes what is missing.
- **Partial publish**: multi-package publishing is not atomic. Re-run the workflow; never hand-publish a different
  artifact under the same version.
- **Bad published contents**: npm versions are immutable. Deprecate the version and release a fix:

  ```bash
  npm deprecate @scope/example@X.Y.Z "Broken build; use X.Y.Z+1"
  ```

  Move a dist-tag back when `latest` must point at the previous version:
  `npm dist-tag add @scope/example@<previous> latest`. `npm unpublish` is limited to 72 hours after publishing
  and blocks the version number permanently; prefer deprecation.
- Once any package of a version is on npm, do not move or reuse its tag. Fix forward with a new version.

## CI Trigger Options

`ci.yml` runs on ordinary `pull_request` and `push` events, which is enough for a single-maintainer repository. A
repository that wants CI to validate an exact head/base pair, or to skip CI on drafts, can replace it with a
`workflow_dispatch` workflow that takes `head_sha`/`base_sha` inputs and re-checks the PR head before and after the
run. That design costs a manual trigger per PR; adopt it only when stale or racing CI results are a real problem.
