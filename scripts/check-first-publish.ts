import { execFileSync } from "node:child_process";
import process from "node:process";

import { findRepositoryRoot, isPublishable, readWorkspacePackages } from "./lib/workspace.ts";

const root = findRepositoryRoot();
const registry = process.env.RELEASE_REGISTRY ?? "https://registry.npmjs.org/";
const names = readWorkspacePackages(root)
  .filter(isPublishable)
  .map((pkg) => pkg.manifest.name)
  .filter((name): name is string => name !== undefined && name.length > 0);

const missing: string[] = [];
for (const name of names) {
  let versions: unknown;
  try {
    versions = JSON.parse(
      execFileSync("npm", ["view", name, "versions", "--json", "--registry", registry], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      })
    );
  } catch (error) {
    const stderr = String((error as { stderr?: Buffer | string }).stderr ?? "");
    if (!stderr.includes("E404")) {
      // A network or registry failure is not evidence that the package is unpublished; say so and stop.
      console.error(`check-first-publish: registry lookup failed for ${name}: ${stderr.trim().split("\n")[0]}`);
      process.exit(1);
    }
    missing.push(name);
    continue;
  }
  if (!Array.isArray(versions) || versions.length === 0) {
    missing.push(name);
  }
}

if (missing.length > 0) {
  console.error(`check-first-publish: no version on npm yet for ${missing.join(", ")}`);
  console.error(
    "check-first-publish: finish the first publish in One-Time Setup (docs/development/release.md) before running " +
      "Version Packages. pnpm version -r consumes the changesets either way, and publishing a package name that " +
      "does not exist yet fails at the npm trusted-publishing exchange."
  );
  process.exit(1);
}
console.log(`check-first-publish: ok (${names.join(", ")} have versions on npm)`);
