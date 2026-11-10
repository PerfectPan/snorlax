#!/usr/bin/env node

// Rejects pending change records that changesets would accept but the release flow cannot ship:
// - A record naming a package that is never released (a private workspace while privatePackages.version is false,
//   or an ignored package) is never consumed by `changeset version`, so main would keep a pending record, the
//   action would keep taking the version branch, and nothing would publish again.
// - Changesets has no bump cap. While the packages are 0.x a release may bump at most minor; a deliberate major
//   release changes this script in a reviewed PR. Delete this block once the packages are 1.x or later.
import { getReleasePlan } from "@changesets/get-release-plan";

const plan = await getReleasePlan(process.cwd());
// Skipped (private or ignored) packages never get a real bump, but one that depends on a released package still
// appears in the plan with type "none", so only real bumps count as released.
const released = new Set(plan.releases.filter((release) => release.type !== "none").map((release) => release.name));
const recordPath = (changeset) => `.changeset/${changeset.id}.md`;
const failures = [];

for (const changeset of plan.changesets) {
  const unreleased = changeset.releases.filter((release) => release.type !== "none" && !released.has(release.name));
  if (unreleased.length > 0) {
    failures.push(
      `${recordPath(changeset)} names ${unreleased.map((release) => release.name).join(", ")}, which is not released`
    );
  }
  if (changeset.releases.some((release) => release.type === "major")) {
    failures.push(`${recordPath(changeset)} requests a major bump; a release may bump at most minor`);
  }
}
if (failures.length === 0 && plan.releases.some((release) => release.type === "major")) {
  failures.push("the pending records propagate a major bump; a release may bump at most minor");
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`check-release-plan: ${failure}`);
  }
  process.exit(1);
}

console.log(`check-release-plan: ok (${plan.changesets.length} pending change record(s))`);
