/** The message of an unknown thrown value, for embedding in failure and log lines. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
