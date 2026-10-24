import type { Platform } from "@rivus/agent-kit/platform";

/**
 * Reads a whole file as text through the platform. Resolves undefined when nothing is at `path`, so callers
 * treat "missing" separately from "present but unreadable" without catching errors at the call site.
 */
export async function readTextFile(platform: Pick<Platform, "fs">, path: string): Promise<string | undefined> {
  const chunks: Uint8Array[] = [];
  try {
    for await (const chunk of platform.fs.read(path)) {
      chunks.push(chunk);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  let length = 0;
  for (const chunk of chunks) {
    length += chunk.byteLength;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
