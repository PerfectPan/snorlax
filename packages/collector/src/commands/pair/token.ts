import * as z from "zod/mini";

/**
 * RFC 6750 `b64token` (plan 3.2.4, 3.4.2). The hyphen sits at the end of the class so it is not a range, and
 * `=` is only a suffix. A space, a newline, a carriage return, or a NUL cannot pass and later be placed in
 * an Authorization header. The empty string fails the `+`, and `pair` reports it with its own message.
 */
export const adminTokenSchema = z.string().check(z.regex(/^[A-Za-z0-9._~+/-]+=*$/));

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
