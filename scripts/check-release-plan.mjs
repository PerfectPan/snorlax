#!/usr/bin/env node

import { readConfig } from "@changesets/config";
import { getReleasePlan } from "@changesets/get-release-plan";
import { shouldSkipPackage } from "@changesets/should-skip-package";
import { getPackages } from "@manypkg/get-packages";

const packages = await getPackages(process.cwd());
const configResult = await readConfig(packages.rootDir, packages);
if (!configResult.config) {
  throw new Error(configResult.errors.join("\n"));
}
const config = configResult.config;
const plan = await getReleasePlan(packages.rootDir);
const packagesByName = new Map(packages.packages.map((pkg) => [pkg.packageJson.name, pkg]));
const recordPath = (changeset) => `.changeset/${changeset.id}.md`;
const failures = [];

for (const changeset of plan.changesets) {
  // Even a `none` entry keeps a skipped package's record pending forever.
  const skipped = changeset.releases.filter((release) =>
    shouldSkipPackage(packagesByName.get(release.name), {
      ignore: config.ignore,
      allowPrivatePackages: config.privatePackages.version
    })
  );
  if (skipped.length > 0) {
    failures.push(
      `${recordPath(changeset)} names ${skipped.map((release) => release.name).join(", ")}, which is not versioned`
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`check-release-plan: ${failure}`);
  }
  process.exit(1);
}

console.log(`check-release-plan: ok (${plan.changesets.length} pending change record(s))`);
