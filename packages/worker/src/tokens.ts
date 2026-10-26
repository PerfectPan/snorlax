/**
 * Device token rules (plan 3.8): device tokens are 32 random bytes in base64url, and D1 stores only their
 * SHA-256 hex, so lookup goes by hash. Everything here uses WebCrypto primitives that exist in both Node 24
 * and workerd. The admin token is compared by Hono's `bearerAuth` in `http/app.ts`.
 */

const encoder = new TextEncoder();

const sha256 = async (value: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

const toHex = (bytes: Uint8Array): string => {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
};

/** The SHA-256 hex digest a device token is stored and looked up by. */
export const hashToken = async (token: string): Promise<string> => toHex(await sha256(token));

/** A fresh device token: 32 random bytes, base64url without padding (43 characters). */
export const generateDeviceToken = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let base64 = "";
  for (const byte of bytes) {
    base64 += String.fromCharCode(byte);
  }
  return btoa(base64).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};
