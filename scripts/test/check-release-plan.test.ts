import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(record: string, options: { ignore?: string[]; version?: string; privateVersioning?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "release-plan-"));
  roots.push(root);
  mkdirSync(join(root, ".changeset"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  writeFileSync(
    join(root, ".changeset/config.json"),
    JSON.stringify({
      changelog: false,
      fixed: [],
      linked: [],
      access: "public",
      baseBranch: "main",
      updateInternalDependencies: "patch",
      ignore: options.ignore ?? [],
      privatePackages: { version: options.privateVersioning ?? false, tag: false }
    })
  );
  for (const [name, isPrivate] of [
    ["public", false],
    ["private", true],
    ["ignored", false]
  ] as const) {
    mkdirSync(join(root, "packages", name), { recursive: true });
    writeFileSync(
      join(root, "packages", name, "package.json"),
      JSON.stringify({ name: `@fixture/${name}`, version: options.version ?? "0.1.0", private: isPrivate })
    );
  }
  writeFileSync(join(root, ".changeset/pending.md"), `---\n${record}\n---\n\nRelease note.\n`);
  return root;
}

function check(root: string) {
  return spawnSync(process.execPath, [fileURLToPath(new URL("../check-release-plan.mjs", import.meta.url))], {
    cwd: root,
    encoding: "utf8"
  });
}

describe("release-plan CLI", () => {
  it.each(["patch", "none"])("rejects a private package with a %s entry", (bump) => {
    const result = check(fixture(`"@fixture/private": ${bump}`));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("@fixture/private, which is not versioned");
  });

  it("rejects an ignored package even with a none entry", () => {
    const result = check(fixture('"@fixture/ignored": none', { ignore: ["@fixture/ignored"] }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("@fixture/ignored, which is not versioned");
  });

  it("rejects a mixed record containing a private none entry", () => {
    const result = check(fixture('"@fixture/public": patch\n"@fixture/private": none'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Found mixed changeset pending");
    expect(result.stderr).toContain("@fixture/private");
  });

  it("accepts public none entries and empty changesets", () => {
    expect(check(fixture('"@fixture/public": none')).status).toBe(0);
    expect(check(fixture("")).status).toBe(0);
  });

  it("follows configured private-package versioning", () => {
    expect(check(fixture('"@fixture/private": patch', { privateVersioning: true })).status).toBe(0);
  });

  it("allows a deliberate major release", () => {
    expect(check(fixture('"@fixture/public": major')).status).toBe(0);
  });
});
