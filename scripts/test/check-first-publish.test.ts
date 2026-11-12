import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

const script = resolve(import.meta.dirname, "../check-first-publish.ts");
const workspaces: string[] = [];
const queried: string[] = [];
let published = new Map<string, string[]>();
let registryFailure = false;
const registry = createServer((request, response) => {
  const name = decodeURIComponent(request.url?.slice(1) ?? "");
  queried.push(name);
  response.setHeader("content-type", "application/json");
  const versions = published.get(name);
  if (registryFailure || versions === undefined) {
    response.statusCode = registryFailure ? 503 : 404;
    response.end(JSON.stringify({ error: registryFailure ? "Registry unavailable" : "Not found" }));
    return;
  }
  response.end(
    JSON.stringify({
      name,
      "dist-tags": { latest: versions.at(-1) },
      versions: Object.fromEntries(versions.map((version) => [version, { name, version }]))
    })
  );
});

beforeAll(() => new Promise<void>((done) => registry.listen(0, "127.0.0.1", done)));
afterAll(() => new Promise<void>((done) => registry.close(() => done())));
afterEach(() => {
  for (const root of workspaces.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  queried.length = 0;
  published = new Map();
  registryFailure = false;
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "snorlax-first-publish-"));
  workspaces.push(root);
  const write = (path: string, content: unknown) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), typeof content === "string" ? content : JSON.stringify(content));
  };
  write("package.json", { name: "root", private: true });
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  for (const name of ["a", "b", "ignored", "private"]) {
    write(`packages/${name}/package.json`, { name, version: "0.1.0", private: name === "private" });
  }
  write(".changeset/config.json", {
    changelog: false,
    fixed: [],
    ignore: ["ignored"],
    privatePackages: { version: false, tag: false }
  });
  write(".changeset/record.md", '---\n"a": patch\n---\n\nNote.\n');
  return root;
}

function check(root: string, mode: "version" | "publish") {
  return new Promise<{ status: number | null; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, [script, mode], {
      cwd: root,
      env: {
        ...process.env,
        RELEASE_REGISTRY: `http://127.0.0.1:${(registry.address() as AddressInfo).port}/`,
        // A per-workspace cache keeps npm from answering one test with another test's registry response.
        npm_config_cache: join(root, ".npm"),
        npm_config_fetch_retries: "0",
        // The update check would query the test registry for `npm` itself.
        npm_config_update_notifier: "false"
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", reject);
    child.on("close", (status) => done({ status, stderr }));
  });
}

describe("check-first-publish", () => {
  it("allows an existing package's version PR despite an unrelated new package", async () => {
    published.set("a", ["0.0.0"]);
    const result = await check(workspace(), "version");

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(queried).toEqual(["a"]);
  });

  it("accepts a package with several published versions", async () => {
    published.set("a", ["0.0.0", "0.1.0"]);
    const result = await check(workspace(), "version");

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("blocks a release candidate that still needs its first publish", async () => {
    const result = await check(workspace(), "version");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no version on npm yet for a");
  });

  it("checks new names before publishing while skipping private and ignored packages", async () => {
    published.set("a", ["0.0.0"]);
    const result = await check(workspace(), "publish");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no version on npm yet for b");
    expect(queried).toEqual(["a", "b"]);
  });

  it("distinguishes registry failures from a missing package", async () => {
    registryFailure = true;
    const result = await check(workspace(), "version");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("registry lookup failed for a");
    expect(result.stderr).not.toContain("no version on npm yet");
  });
});
