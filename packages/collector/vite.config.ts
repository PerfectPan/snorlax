import { chmod } from "node:fs/promises";

import { fmt, lint } from "@perfectpan/lint-config/vite-plus";
import { defineConfig } from "vite-plus";

/**
 * Builds the whole collector into one ESM file, `dist/snorlax.mjs`, with every dependency inlined
 * (plan 2.4 D9): the app bundles exactly this file and runs it with the user's Node. Node builtins stay
 * external; the shebang banner makes the file work as the `snorlax` bin. The package version comes from
 * `src/version.ts`'s JSON import, which the bundler inlines.
 */
export default defineConfig({
  fmt,
  lint: { ...lint, ignorePatterns: ["node_modules/**", "dist/**"] },
  build: {
    target: "node22.13",
    minify: false,
    outDir: "dist",
    lib: {
      entry: "src/cli/bin.ts",
      formats: ["es"],
      fileName: () => "snorlax.mjs"
    },
    rollupOptions: {
      external: [/^node:/],
      plugins: [
        {
          name: "make-bin-executable",
          closeBundle() {
            void chmod("dist/snorlax.mjs", 0o755);
          }
        }
      ],
      output: { banner: "#!/usr/bin/env node" }
    }
  }
});
