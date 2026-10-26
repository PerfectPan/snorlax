import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

/**
 * `security -i` and `secret-tool` stubs. The token stays on stdin. `STUB_FAIL_STORE=1` and
 * `STUB_FAIL_DELETE=1` make that operation exit 1 with text on stderr. Tests point
 * `SNORLAX_SECURITY` / `SNORLAX_SECRET_TOOL` here and never start the real binaries.
 */

const securityStubSource = (): string => `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv: process.argv, stdin }) + "\\n");
  const parts = stdin.trim().split(/\\s+/).filter((part) => part !== "");
  const flag = (name) => {
    const index = parts.indexOf(name);
    return index >= 0 ? parts[index + 1] : undefined;
  };
  const storePath = process.env.STUB_STORE;
  const items = existsSync(storePath) ? JSON.parse(readFileSync(storePath, "utf8")) : {};
  const account = flag("-a");
  const op = parts[0];
  if (op === "add-generic-password") {
    if (process.env.STUB_FAIL_STORE === "1") {
      process.stderr.write("store refused\\n");
      process.exit(1);
    }
    items[account] = flag("-w") ?? "";
    writeFileSync(storePath, JSON.stringify(items));
    process.exit(0);
  }
  if (op === "find-generic-password") {
    if (items[account] === undefined) process.exit(44);
    process.stdout.write(String(items[account]) + "\\n");
    process.exit(0);
  }
  if (op === "delete-generic-password") {
    if (process.env.STUB_FAIL_DELETE === "1") {
      process.stderr.write("delete refused\\n");
      process.exit(1);
    }
    if (items[account] === undefined) process.exit(44);
    delete items[account];
    writeFileSync(storePath, JSON.stringify(items));
    process.exit(0);
  }
  process.stderr.write("unknown command\\n");
  process.exit(2);
});
`;

const secretToolStubSource = (): string => `#!${process.execPath}
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
});
process.stdin.on("end", () => {
  appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv: process.argv, stdin }) + "\\n");
  const storePath = process.env.STUB_STORE;
  const items = existsSync(storePath) ? JSON.parse(readFileSync(storePath, "utf8")) : {};
  const args = process.argv.slice(2);
  const accountAt = args.indexOf("account");
  const account = accountAt >= 0 ? args[accountAt + 1] : undefined;
  const op = args[0];
  if (op === "store") {
    if (process.env.STUB_FAIL_STORE === "1") {
      process.stderr.write("store refused\\n");
      process.exit(1);
    }
    items[account] = stdin;
    writeFileSync(storePath, JSON.stringify(items));
    process.exit(0);
  }
  if (op === "lookup") {
    if (items[account] === undefined) process.exit(1);
    process.stdout.write(String(items[account]) + "\\n");
    process.exit(0);
  }
  if (op === "clear") {
    if (process.env.STUB_FAIL_DELETE === "1") {
      process.stderr.write("delete refused\\n");
      process.exit(1);
    }
    if (items[account] === undefined) process.exit(1);
    delete items[account];
    writeFileSync(storePath, JSON.stringify(items));
    process.exit(0);
  }
  process.stderr.write("unknown command\\n");
  process.exit(2);
});
`;

/** Writes both stubs and an empty invocation log. The item store is created on the first store. */
export const writeSecretStubs = async (
  dir: string
): Promise<{
  readonly security: string;
  readonly secretTool: string;
  readonly logPath: string;
  readonly storePath: string;
}> => {
  const security = join(dir, "security-stub");
  const secretTool = join(dir, "secret-tool-stub");
  await writeFile(security, securityStubSource());
  await writeFile(secretTool, secretToolStubSource());
  await chmod(security, 0o755);
  await chmod(secretTool, 0o755);
  const logPath = join(dir, "security.log");
  await writeFile(logPath, "");
  return { security, secretTool, logPath, storePath: join(dir, "items.json") };
};
