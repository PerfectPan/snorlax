import { execFileSync } from "node:child_process";
import process from "node:process";

import { readConfig } from "@changesets/config";
import { getReleasePlan } from "@changesets/get-release-plan";
import { shouldSkipPackage } from "@changesets/should-skip-package";
import { getPackages } from "@manypkg/get-packages";
import * as z from "zod/mini";

// OIDC Trusted Publishing cannot create a package name, so every name a run would version or publish must already
// exist on npm. The Release workflow passes the mode `changesets/action/select-mode` chose.
const ReleaseMode = z.enum(["version", "publish"]);
const NpmVersions = z.array(z.string());
const NpmFailure = z.object({ stderr: z.string() });

const mode = ReleaseMode.parse(process.argv[2] ?? "version");
const registry = process.env.RELEASE_REGISTRY ?? "https://registry.npmjs.org/";

const packages = await getPackages(process.cwd());
const { config, errors } = await readConfig(packages.rootDir, packages);
if (!config) {
  throw new Error(errors.join("\n"));
}
// A version PR only needs setup for its release candidates; another new package must not block it.
const plan = mode === "version" ? await getReleasePlan(packages.rootDir, undefined, config) : undefined;
const candidates =
  plan && new Set(plan.releases.filter((release) => release.type !== "none").map((release) => release.name));
const names = packages.packages
  .filter((pkg) => !shouldSkipPackage(pkg, { ignore: config.ignore, allowPrivatePackages: false }))
  .map((pkg) => pkg.packageJson.name)
  .filter((name) => !candidates || candidates.has(name));

const missing: string[] = [];
for (const name of names) {
  let output: string;
  try {
    output = execFileSync("npm", ["view", name, "versions", "--json", "--registry", registry], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const stderr = NpmFailure.safeParse(error).data?.stderr ?? "";
    if (!stderr.includes("E404")) {
      // A network or registry failure is not evidence that the package is unpublished; say so and stop.
      console.error(`check-first-publish: registry lookup failed for ${name}: ${stderr.trim().split("\n")[0]}`);
      process.exit(1);
    }
    missing.push(name);
    continue;
  }
  const versions = NpmVersions.parse(JSON.parse(output));
  if (versions.length === 0) {
    missing.push(name);
  }
}

if (missing.length > 0) {
  console.error(`check-first-publish: no version on npm yet for ${missing.join(", ")}`);
  console.error(
    "check-first-publish: finish One-Time Setup in docs/development/release.md before creating the version PR or publishing."
  );
  process.exit(1);
}
console.log(`check-first-publish: ok (${names.length} package(s))`);
