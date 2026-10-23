import process from "node:process";

import { createNodePlatform } from "@rivus/agent-kit/node";

import { nodeFileOps } from "../data-dir/node-fs.ts";
import { version } from "../version.ts";
import { runCli } from "./main.ts";

/** The `snorlax` bin: composes the Node platform and runs one command. */
const platform = createNodePlatform();
process.exitCode = await runCli(process.argv.slice(2), {
  platform,
  nodeFiles: nodeFileOps,
  version,
  nodeVersion: process.version,
  stdout: process.stdout,
  stderr: process.stderr
});
