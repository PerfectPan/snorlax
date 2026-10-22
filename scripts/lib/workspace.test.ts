import { describe, expect, it } from "vite-plus/test";

import {
  isPublishable,
  parseWorkspaceEntries,
  type ReleaseInput,
  releaseErrors,
  splitScriptArgs
} from "./workspace.ts";

describe("splitScriptArgs", () => {
  it("drops the -- separator pnpm forwards verbatim", () => {
    expect(splitScriptArgs(["--", "v1.2.3", "--repository", "owner/repo"])).toEqual([
      "v1.2.3",
      "--repository",
      "owner/repo"
    ]);
  });

  it("keeps argv without a separator", () => {
    expect(splitScriptArgs(["v1.2.3", "--verify-git"])).toEqual(["v1.2.3", "--verify-git"]);
  });
});

describe("parseWorkspaceEntries", () => {
  it("maps pnpm ls output to workspace-relative directories", () => {
    const json = JSON.stringify([
      { name: "project-template-pnpm", path: "/repo", private: true },
      { name: "@scope/example", version: "1.0.0", path: "/repo/packages/example", private: false },
      { name: "repo-scripts", version: "0.0.0", path: "/repo/scripts", private: true }
    ]);
    expect(parseWorkspaceEntries("/repo", json)).toEqual([
      { dir: "." },
      { dir: "packages/example" },
      { dir: "scripts" }
    ]);
  });
});

describe("isPublishable", () => {
  it("is false for private packages", () => {
    expect(isPublishable({ dir: "packages/example", manifest: { name: "@scope/example", private: false } })).toBe(true);
    expect(isPublishable({ dir: "scripts", manifest: { name: "repo-scripts", private: true } })).toBe(false);
  });
});

function input(overrides: Partial<ReleaseInput> = {}): ReleaseInput {
  return {
    tag: "v1.2.3",
    repository: "owner/repo",
    packages: [
      {
        dir: "packages/lib",
        manifest: {
          name: "@scope/lib",
          version: "1.2.3",
          files: ["dist"],
          publishConfig: { access: "public" },
          repository: { url: "git+https://github.com/owner/repo.git" }
        }
      }
    ],
    pendingChangesets: [],
    ...overrides
  };
}

describe("releaseErrors", () => {
  it("accepts a consistent release", () => {
    expect(releaseErrors(input())).toEqual([]);
  });

  it("skips private packages", () => {
    expect(
      releaseErrors(input({ packages: [{ dir: "scripts", manifest: { name: "repo-scripts", private: true } }] })).some(
        (error) => error.includes("repo-scripts")
      )
    ).toBe(false);
  });

  it("requires a publishable package", () => {
    expect(releaseErrors(input({ packages: [] }))).toContain("the workspace has no published packages");
  });

  it("rejects a tag that does not match the packages' shared version and points at the tag", () => {
    expect(releaseErrors(input({ tag: "v1.2.4" }))).toEqual([
      "release tag v1.2.4 does not match @scope/lib@1.2.3; check the release tag against the shared version of the published packages"
    ]);
  });

  it("rejects two published packages that carry different versions", () => {
    const second = {
      dir: "packages/other",
      manifest: {
        name: "@scope/other",
        version: "2.0.0",
        files: ["dist"],
        publishConfig: { access: "public" },
        repository: { url: "git+https://github.com/owner/repo.git" }
      }
    };
    expect(releaseErrors(input({ packages: [...input().packages, second] }))).toEqual([
      "release tag v1.2.3 does not match @scope/other@2.0.0 (all published packages release at one shared version; add every published package to the versioning.fixed group in pnpm-workspace.yaml)"
    ]);
  });

  it("reports a missing tag once", () => {
    expect(releaseErrors(input({ tag: "" }))).toEqual(["release tag is required"]);
  });

  it("rejects a prerelease version", () => {
    const pkg = { ...input().packages[0]!, manifest: { ...input().packages[0]!.manifest, version: "1.2.3-rc.0" } };
    expect(releaseErrors(input({ tag: "v1.2.3-rc.0", packages: [pkg] }))).toContain(
      '@scope/lib version must be a stable x.y.z release, got "1.2.3-rc.0"'
    );
  });

  it("rejects a manifest from another repository and pending changesets", () => {
    const [entry] = input().packages;
    const pkg = { ...entry!, manifest: { ...entry!.manifest, repository: "https://github.com/other/repo" } };
    expect(releaseErrors(input({ packages: [pkg], pendingChangesets: ["next-feature.md"] }))).toEqual([
      "@scope/lib repository.url must identify github.com/owner/repo",
      "unreleased changesets remain; run Version Packages first: next-feature.md"
    ]);
  });
});
