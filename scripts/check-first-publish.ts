import { spawnSync } from "node:child_process";
import process from "node:process";

import { readConfig } from "@changesets/config";
import { getReleasePlan } from "@changesets/get-release-plan";
import { shouldSkipPackage } from "@changesets/should-skip-package";
import { getPackages } from "@manypkg/get-packages";
import * as z from "zod/mini";

const mode = z.enum(["version", "publish"]).parse(process.argv[2]);
const packages = await getPackages(process.cwd());
const configResult = await readConfig(packages.rootDir, packages);
if (!configResult.config) {
  throw new Error(configResult.errors.join("\n"));
}
const config = configResult.config;
const candidates =
  mode === "version"
    ? new Set(
        (await getReleasePlan(packages.rootDir)).releases
          .filter((release) => release.type !== "none")
          .map((release) => release.name)
      )
    : undefined;
const names = packages.packages
  .filter((pkg) => !shouldSkipPackage(pkg, { ignore: config.ignore, allowPrivatePackages: false }))
  .map((pkg) => pkg.packageJson.name)
  .filter((name) => candidates === undefined || candidates.has(name));
const registry = process.env.RELEASE_REGISTRY ?? "https://registry.npmjs.org/";
const versionsSchema = z.union([z.string().check(z.minLength(1)), z.array(z.string()).check(z.minLength(1))]);
const missing: string[] = [];

for (const name of names) {
  const result = spawnSync("npm", ["view", name, "versions", "--json", "--registry", registry], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status !== 0) {
    if (!result.stderr.includes("E404")) {
      console.error(
        `check-first-publish: registry lookup failed for ${name}: ${result.error?.message ?? result.stderr.trim()}`
      );
      process.exit(1);
    }
    missing.push(name);
    continue;
  }
  if (!versionsSchema.safeParse(JSON.parse(result.stdout)).success) {
    missing.push(name);
  }
}

if (missing.length > 0) {
  console.error(`check-first-publish: no version on npm yet for ${missing.join(", ")}`);
  console.error(
    "check-first-publish: finish the first publish and Trusted Publisher setup in docs/development/release.md " +
      "before creating the version PR. OIDC cannot create a package name."
  );
  process.exit(1);
}
console.log(`check-first-publish: ok (${names.length} package(s) already on npm)`);
