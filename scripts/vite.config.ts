import { fmt, lint } from "@perfectpan/lint-config/vite-plus";
import { defineConfig } from "vite-plus";

export default defineConfig({ fmt, lint: { ...lint, ignorePatterns: ["node_modules/**"] } });
