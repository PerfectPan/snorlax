import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

export const CHANGES_DIRECTORY = ".changeset";

export interface PackageManifest {
  name?: string;
  version?: string;
  private?: boolean;
  files?: string[];
  publishConfig?: { access?: string };
  repository?: string | { url?: string };
}

/** One entry of `pnpm ls -r --depth -1 --json`: pnpm decides workspace membership, not the scripts. */
export interface WorkspaceEntry {
  /** Workspace-relative directory with forward slashes; "." for the workspace root. */
  dir: string;
}

export interface WorkspacePackage {
  dir: string;
  manifest: PackageManifest;
}

/**
 * `pnpm run release:check -- <args>` forwards the `--` separator verbatim, and parseArgs would treat it as the
 * end-of-options marker and turn the flags behind it into positionals.
 */
export function splitScriptArgs(argv: readonly string[]): string[] {
  const separator = argv.indexOf("--");
  if (separator === -1) {
    return [...argv];
  }
  return [...argv.slice(0, separator), ...argv.slice(separator + 1)];
}

/** The absolute repository root, resolved so that it matches the paths `pnpm ls` reports. */
export function findRepositoryRoot(): string {
  return realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim());
}

/** Parses `pnpm ls -r --depth -1 --json` output into workspace entries with workspace-relative directories. */
export function parseWorkspaceEntries(root: string, json: string): WorkspaceEntry[] {
  const parsed = JSON.parse(json) as { path: string }[];
  return parsed.map(({ path }) => ({ dir: relative(root, path).split("\\").join("/") || "." }));
}

/** Reads each workspace member's package.json; pnpm's entry carries the membership, the manifest the release fields. */
export function readManifests(root: string, entries: readonly WorkspaceEntry[]): WorkspacePackage[] {
  return entries.map((entry) => ({
    dir: entry.dir,
    manifest: JSON.parse(readFileSync(join(root, entry.dir, "package.json"), "utf8")) as PackageManifest
  }));
}

/** Lists the workspace members through pnpm and reads their manifests. */
export function readWorkspacePackages(root: string): WorkspacePackage[] {
  const lsOutput = execFileSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  return readManifests(root, parseWorkspaceEntries(root, lsOutput));
}

/** A package publishes when it is not private; pnpm's own commands skip private packages on publish. */
export function isPublishable(pkg: WorkspacePackage): boolean {
  return pkg.manifest.private !== true;
}

/**
 * Pending changesets are the `.changeset/*.md` intent files `pnpm version -r` consumes; README and pnpm's own
 * state files stay. Leftover files mean the version PR has not run since the last change.
 */
export function pendingChangesets(root: string): string[] {
  try {
    return readdirSync(join(root, CHANGES_DIRECTORY), { encoding: "utf8" })
      .filter((name) => name.endsWith(".md") && !name.startsWith("README"))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function repositoryUrl(manifest: PackageManifest): string | undefined {
  return typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
}

export function identifiesRepository(url: string | undefined, repository: string): boolean {
  return [
    `git+https://github.com/${repository}.git`,
    `https://github.com/${repository}.git`,
    `https://github.com/${repository}`,
    `git+ssh://git@github.com/${repository}.git`
  ].includes(url ?? "");
}

export interface ReleaseInput {
  tag: string | undefined;
  repository: string;
  packages: WorkspacePackage[];
  pendingChangesets: string[];
}

/**
 * Returns every reason the release cannot be published; an empty list means the release set is valid. All
 * published packages release at one shared version through the `versioning.fixed` group, so one release tag
 * covers the set.
 */
export function releaseErrors({ tag, repository, packages, pendingChangesets }: ReleaseInput): string[] {
  const errors: string[] = [];
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    errors.push(`repository must be owner/name, got "${repository}"`);
  }
  const published = packages.filter(isPublishable);
  if (published.length === 0) {
    errors.push("the workspace has no published packages");
  }

  if (tag === undefined || tag.length === 0) {
    errors.push("release tag is required");
  }

  // A mismatch between one consistent version and the tag means the tag is wrong; versions that disagree with
  // each other mean a published package is missing from the fixed group.
  const sharedVersions = new Set(published.map(({ manifest }) => manifest.version));
  const versionsAgree = sharedVersions.size <= 1;

  for (const { dir, manifest } of published) {
    const name = manifest.name ?? dir;
    if (manifest.version === undefined || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
      errors.push(`${name} version must be a stable x.y.z release, got "${manifest.version ?? "(missing)"}"`);
    } else if (tag !== undefined && tag.length > 0 && tag !== `v${manifest.version}`) {
      errors.push(
        versionsAgree
          ? `release tag ${tag} does not match ${name}@${manifest.version}; check the release tag against the ` +
              "shared version of the published packages"
          : `release tag ${tag} does not match ${name}@${manifest.version} (all published packages release at one ` +
              "shared version; add every published package to the versioning.fixed group in pnpm-workspace.yaml)"
      );
    }
    if (manifest.publishConfig?.access !== "public") {
      errors.push(`${name} publishConfig.access must be "public"`);
    }
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      errors.push(`${name} must list published files in "files"`);
    }
    // npm provenance rejects a package whose repository does not match the workflow's repository.
    if (!identifiesRepository(repositoryUrl(manifest), repository)) {
      errors.push(`${name} repository.url must identify github.com/${repository}`);
    }
  }

  if (pendingChangesets.length > 0) {
    errors.push(`unreleased changesets remain; run Version Packages first: ${pendingChangesets.join(", ")}`);
  }
  return errors;
}
