import { fmt, lint } from "@perfectpan/lint-config/vite-plus";
import { defineConfig } from "vite-plus";

// The Worker bundle is `cf build`'s job (plan 2.4 D13); vite-plus carries only the lint, format and
// test configuration every package has.
export default defineConfig({
  fmt,
  lint: { ...lint, ignorePatterns: ["node_modules/**"] }
});
