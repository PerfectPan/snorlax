import { execFileSync } from "node:child_process";
import process from "node:process";
import { parseArgs } from "node:util";

import {
  type ReleaseInput,
  findRepositoryRoot,
  isPublishable,
  readWorkspacePackages,
  releaseErrors,
  splitScriptArgs,
  pendingChangesets
} from "./lib/workspace.ts";

const USAGE = "usage: node scripts/check-release.ts <tag> [--repository owner/name] [--verify-git]";

const { positionals, values } = parseArgs({
  args: splitScriptArgs(process.argv.slice(2)),
  allowPositionals: true,
  options: {
    repository: { type: "string" },
    "verify-git": { type: "boolean" },
    help: { type: "boolean", short: "h" }
  }
});
if (values.help === true) {
  console.log(USAGE);
  process.exit(0);
}

const root = findRepositoryRoot();
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const tag = positionals[0] ?? process.env.RELEASE_TAG;
const repository = values.repository ?? process.env.GITHUB_REPOSITORY ?? "";

const input: ReleaseInput = {
  tag,
  repository,
  packages: readWorkspacePackages(root),
  pendingChangesets: pendingChangesets(root)
};

const errors = releaseErrors(input);

if (values["verify-git"] === true) {
  const head = git("rev-parse", "HEAD");
  try {
    const tagged = git("rev-parse", `refs/tags/${tag}^{commit}`);
    if (tagged !== head) {
      errors.push(`HEAD ${head} is not the commit tagged ${tag} (${tagged})`);
    }
  } catch {
    errors.push(`tag ${tag} does not exist locally`);
  }
  if (git("status", "--porcelain") !== "") {
    errors.push("worktree must be clean");
  }
  try {
    git("merge-base", "--is-ancestor", "HEAD", "origin/main");
  } catch {
    errors.push("release commit must be on origin/main");
  }
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`check-release: ${error}`);
  }
  process.exit(1);
}
const names = input.packages
  .filter(isPublishable)
  .map((pkg) => pkg.manifest.name)
  .join(", ");
console.log(`check-release: ok (${tag}: ${names})`);
