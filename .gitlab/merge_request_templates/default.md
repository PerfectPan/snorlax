<!-- Title format: `type(scope): summary`, in English. Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. -->

## Summary

<!-- What changed and why. Link the issue, Spec, or Plan when there is one. -->

-

## Validation

<!-- Commands you ran and their results; logs or screenshots for behavior claims. Name skipped checks and why. -->

- [ ] Aggregate gate (format, build, lint, typecheck, test): `pnpm run check`
- [ ] Repository checks: `gh repo-checks repository`
- [ ] MR title and description: `gh repo-checks pr-title "<title>"`, `gh repo-checks pr-body <body-file>`
- [ ] Changeset for published-package changes, when this MR should produce a release: `.changeset/<name>.md`
- [ ] Package or release dry-run, when publishing changes: `pnpm run publish:dry-run`

## Risks

<!-- Optional: compatibility, rollout, rollback, or follow-up risks. Delete this section when there are none. -->

-
