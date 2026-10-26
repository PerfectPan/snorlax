import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { bundleEnv } from "./fixtures/bundle.ts";

/**
 * `bundleEnv` always points the store tools under the test directory. This test does not start the bundle, so
 * it cannot reach `/usr/bin/security` or `secret-tool`.
 */

const under = (root: string, path: string): boolean => {
  const rel = relative(root, resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

describe("bundleEnv", () => {
  it("points security and secret-tool under the test directory when the caller omits them", () => {
    const home = join(tmpdir(), "snorlax-bundle-env-guard");
    const env = bundleEnv({ home });
    expect(env.SNORLAX_SECURITY).toBe(join(home, "no-security"));
    expect(env.SNORLAX_SECRET_TOOL).toBe(join(home, "no-secret-tool"));
    expect(under(home, env.SNORLAX_SECURITY ?? "")).toBe(true);
    expect(under(home, env.SNORLAX_SECRET_TOOL ?? "")).toBe(true);
    expect(env.SNORLAX_SECURITY).not.toBe("/usr/bin/security");
    expect(env.SNORLAX_SECRET_TOOL).not.toBe("secret-tool");
  });

  it("keeps an explicit stub and refuses a path outside the temporary directory", () => {
    const home = join(tmpdir(), "snorlax-bundle-env-stub");
    const security = join(home, "security-stub");
    const secretTool = join(home, "secret-tool-stub");
    const env = bundleEnv({
      home,
      security,
      secretTool,
      extraEnv: { SNORLAX_SECURITY: "/usr/bin/security", SNORLAX_SECRET_TOOL: "secret-tool" }
    });
    expect(env.SNORLAX_SECURITY).toBe(security);
    expect(env.SNORLAX_SECRET_TOOL).toBe(secretTool);
    expect(() => bundleEnv({ home, security: "/usr/bin/security" })).toThrow(/security and secret-tool/);
    expect(() => bundleEnv({ home, secretTool: "secret-tool" })).toThrow(/security and secret-tool/);
  });
});
