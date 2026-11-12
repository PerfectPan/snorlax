import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

const script = resolve(import.meta.dirname, "../check-release-plan.ts");
const workspaces: string[] = [];

function workspaceWithRecord(releases: Record<string, string>, ignore: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), "snorlax-release-plan-"));
  workspaces.push(root);
  const write = (path: string, content: unknown) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), typeof content === "string" ? content : JSON.stringify(content));
  };
  write("package.json", { name: "root", private: true, version: "0.0.0" });
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write("packages/a/package.json", { name: "a", version: "0.1.0" });
  write("packages/b/package.json", { name: "b", version: "0.1.0" });
  write("packages/u/package.json", { name: "u", private: true, version: "0.0.1" });
  write(".changeset/config.json", {
    changelog: false,
    fixed: [],
    ignore,
    privatePackages: { version: false, tag: false }
  });
  const frontmatter = Object.entries(releases)
    .map(([name, type]) => `"${name}": ${type}`)
    .join("\n");
  write(".changeset/record.md", `---\n${frontmatter}\n---\n\nNote.\n`);
  return root;
}

function check(root: string) {
  return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

afterEach(() => {
  for (const root of workspaces.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("check-release-plan", () => {
  it("accepts minor and patch records", () => {
    const result = check(workspaceWithRecord({ a: "minor", b: "patch" }));

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("accepts a major record", () => {
    const result = check(workspaceWithRecord({ a: "major" }));

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it.each(["patch", "none"])("rejects a private package's %s record", (type) => {
    const result = check(workspaceWithRecord({ u: type }));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".changeset/record.md names u, which is not versioned");
  });

  it("rejects a record that names a private package beside a published one", () => {
    const result = check(workspaceWithRecord({ a: "minor", u: "minor" }));

    // Changesets' own release plan refuses a mixed record before the script's check runs.
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Found ignored packages: u");
  });

  it.each(["patch", "none"])("rejects an ignored package's %s record", (type) => {
    const result = check(workspaceWithRecord({ a: type }, ["a"]));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".changeset/record.md names a, which is not versioned");
  });

  it("accepts a public package's none record", () => {
    const result = check(workspaceWithRecord({ a: "none" }));

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});
