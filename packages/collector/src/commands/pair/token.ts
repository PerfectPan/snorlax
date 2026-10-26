/**
 * The admin token from stdin (plan 3.4.2). One trailing newline is removed, and a CR before that newline
 * goes with it, so a CRLF counts as one newline. Any other whitespace stays, including a second newline.
 */
export const adminTokenText = (text: string): string => {
  if (!text.endsWith("\n")) {
    return text;
  }
  const withoutNewline = text.slice(0, -1);
  return withoutNewline.endsWith("\r") ? withoutNewline.slice(0, -1) : withoutNewline;
};
