import { describe, expect, it } from "vite-plus/test";

import { launcherPath, NODE_FALLBACKS, NODE_PATH_FILE, renderNodePathSeed, renderRefreshLauncher } from "./launcher.ts";

/**
 * The launcher script's fixed layout (plan 0001 section 7): Node from `node-path` first, then the fixed
 * fallbacks, never a `PATH` — and the data directory and CLI are sh-quoted, so spaces and quotes stay
 * one word. What the script does when it runs is pinned by the bundle test that executes it with a stub
 * Node; the fallback half of the resolution depends on the host's installed Nodes, so only the text
 * pins the candidate list here.
 */

describe("renderRefreshLauncher", () => {
  const script = renderRefreshLauncher({ dataDir: "/tmp/data", cliPath: "/opt/snorlax/snorlax.mjs" });

  it("reads node-path first, then the fixed fallbacks, and never a PATH", () => {
    expect(script).toContain(`saved=$(head -n 1 "$data_dir/${NODE_PATH_FILE}" 2>/dev/null)`);
    for (const fallback of NODE_FALLBACKS) {
      expect(script).toContain(`  for candidate in ${NODE_FALLBACKS.join(" ")}; do`);
      expect(script).toContain(fallback);
    }
    expect(script).not.toContain("$PATH");
  });

  it("execs the resolved Node on the CLI with refresh", () => {
    expect(script.trimEnd().endsWith('exec "$node" "$cli" refresh')).toBe(true);
  });

  it("quotes the data directory and CLI so spaces and quotes stay one sh word", () => {
    const odd = renderRefreshLauncher({
      dataDir: "/tmp/my 'data'/dir",
      cliPath: "/opt/snorlax & co/snorlax.mjs"
    });
    // One quote in a path becomes the four characters `'\''`.
    const escaped = "'\\''";
    expect(odd).toContain(`data_dir='/tmp/my ${escaped}data${escaped}/dir'`);
    expect(odd).toContain(`cli='/opt/snorlax & co/snorlax.mjs'`);
  });

  it("exits 127 naming every checked location when no candidate is executable", () => {
    expect(script).toContain(
      `echo "snorlax: node not found (checked $data_dir/${NODE_PATH_FILE}, then ${NODE_FALLBACKS.join(" ")})" >&2`
    );
    expect(script).toContain("exit 127");
  });
});

describe("renderNodePathSeed", () => {
  it("writes the Node path as the file's one line", () => {
    expect(renderNodePathSeed("/opt/homebrew/bin/node")).toBe("/opt/homebrew/bin/node\n");
  });
});

describe("launcherPath", () => {
  it("is refresh.sh in the data directory", () => {
    expect(launcherPath("/tmp/data")).toBe("/tmp/data/refresh.sh");
  });
});
