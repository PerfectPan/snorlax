import { chmod } from "node:fs/promises";

import { fmt, lint } from "@perfectpan/lint-config/vite-plus";
import { defineConfig } from "vite-plus";

/**
 * Builds the whole collector into one ESM file, `dist/snorlax.mjs`, with every dependency inlined
 * (plan 2.4 D9): the app bundles exactly this file and runs it with the user's Node. Node builtins stay
 * external; the shebang banner makes the file work as the `snorlax` bin. The package version comes from
 * `src/modules/version/version.ts`'s JSON import, which the bundler inlines.
 */
export default defineConfig({
  fmt,
  lint: { ...lint, ignorePatterns: ["node_modules/**", "dist/**"] },
  build: {
    target: "node22.13",
    // The bundle stays readable and unminified (plan 2.4 D9 keeps a debuggable single file), but
    // rolldown drops the inlined dependencies' doc comments — about half the bytes — while keeping
    // legal ones. minify would reformat the whole file into long lines; comments alone do not.
    minify: false,
    outDir: "dist",
    // The inlined packages' notices ship with the bundle: Vite lists every package the bundle's modules come from,
    // with its license field and LICENSE file. Our own workspace packages are not in node_modules and stay out.
    license: { fileName: "THIRD_PARTY_LICENSES.md" },
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
      output: {
        banner: "#!/usr/bin/env node",
        comments: { legal: true, annotation: false, jsdoc: false }
      }
    }
  }
});
