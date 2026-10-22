import { fmt, lint } from "@perfectpan/lint-config/vite-plus";
import { defineConfig } from "vite-plus";

export default defineConfig({
  // The generated changelog is release output, not a repository source; dist is build output.
  fmt: { ...fmt, ignorePatterns: ["CHANGELOG.*"] },
  lint: { ...lint, ignorePatterns: ["dist/**"] },
  pack: {
    // One entry per subpath export: "." builds src/index.ts into dist/index.js with its declarations.
    entry: { index: "./src/index.ts" },
    format: "esm",
    // The Node platform resolves node: built-ins and their bare spellings; "neutral" would emit
    // UNRESOLVED_IMPORT warnings for them, which `pnpm run check` reports and fails on.
    platform: "node",
    // Extensionless output keeps dist/index.js and dist/index.d.ts, matching the exports map.
    fixedExtension: false,
    // TypeScript 7 has no stable compiler API, so declarations come from Oxc's generator.
    dts: { generator: "oxc" }
  }
});
