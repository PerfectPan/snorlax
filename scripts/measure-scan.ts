import process from "node:process";

import { createNodePlatform } from "@rivus/agent-kit/node";

import { measureScan } from "./lib/measure-scan.ts";

/**
 * Measures `scanUsage` over the current user's agent homes and prints counts only.
 * The owner runs it: `node scripts/measure-scan.ts`. Tests point HOME at a temporary directory.
 */
async function main(): Promise<void> {
  const report = await measureScan(createNodePlatform());
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : "unknown";
  process.stderr.write(`measure-scan: failed (${name})\n`);
  process.exit(1);
});
