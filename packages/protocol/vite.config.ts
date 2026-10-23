import { fmt, lint } from "@perfectpan/lint-config/vite-plus";
import { defineConfig } from "vite-plus";

// schema/ and fixtures/ are generated, committed output: their canonical format is what scripts/generate.ts
// writes, so the formatter leaves them alone (CI instead fails when regeneration changes them).
export default defineConfig({
  fmt: { ...fmt, ignorePatterns: ["node_modules/**", "schema/**", "fixtures/**"] },
  lint: { ...lint, ignorePatterns: ["node_modules/**"] }
});
