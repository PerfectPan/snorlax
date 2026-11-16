import type { Platform } from "@rivus/agent-kit/platform";

/** Every chunk a platform file or child stream yields, concatenated in order. */
export const concatChunks = (chunks: readonly Uint8Array[]): Uint8Array => {
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
  return bytes;
};

/** The UTF-8 text of concatenated chunks. */
export const decodeChunks = (chunks: readonly Uint8Array[]): string => new TextDecoder().decode(concatChunks(chunks));

/** Everything a `ReadableStream` of bytes yields, in order. */
export const readAllChunks = async (stream: ReadableStream<Uint8Array>): Promise<Uint8Array[]> => {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      return chunks;
    }
    chunks.push(next.value);
  }
};

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
  return decodeChunks(chunks);
}
