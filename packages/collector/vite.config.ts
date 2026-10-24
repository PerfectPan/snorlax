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
    // Terser with everything off except comment removal: the bundle stays readable and unminified
    // (plan 2.4 D9 keeps a debuggable single file), but the inlined dependencies' doc comments —
    // about 40% of the bytes — go. minify: false would keep every comment.
    minify: "terser",
    terserOptions: {
      compress: false,
      mangle: false,
      format: { comments: false, keep_numbers: true }
    },
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
