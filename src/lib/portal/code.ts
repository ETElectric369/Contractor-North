/**
 * THE PORTAL'S SIGN-IN CODE, AS PURE PARTS (0331).
 *
 * Erik, 2026-09-24, after opening Andrew's link himself: "it opened right up with no email
 * verification". So the link the customer already holds now asks a new device for a 6-digit code,
 * emailed to the address on file, and the right code signs that device in for 30 days.
 *
 * What lives here is everything that can be tested without a database: drawing a code, the salt and
 * the hash, the constant-time comparison, the session secret and its hash, masking an address, and
 * the plain words for every answer. The database (0331) holds what has to be atomic: one live code
 * per link, the send window, the try counter, expiry and the sessions. Neither side ever stores a
 * code or a session id in the clear: the code is sha256(salt:code) with a per-row salt, the cookie's
 * session id is stored as its sha256.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { CODE_DIGITS } from "./code-words";

export * from "./code-words";

/** A 6-digit code, zero-padded, uniform over 000000..999999 (randomInt is rejection-sampled). */
export function generateCode(): string {
  return String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
}

/** 16 random bytes as hex: one per code, stored beside its hash. */
export function newSalt(): string {
  return randomBytes(16).toString("hex");
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** sha256("<salt>:<code>") as hex. The salt makes two customers' identical codes hash apart. */
export function hashCode(code: string, salt: string): string {
  return sha256(`${salt}:${code}`);
}

/** Does `code` match the stored salt + hash? Constant-time over the hash bytes, and a malformed
 *  stored hash is simply no match (never a throw that times differently). */
export function codeMatches(code: string, salt: string, storedHash: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const a = Buffer.from(hashCode(code, salt), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A device's session id: 32 random bytes. Only the cookie holds it; the database holds its hash. */
export function newSessionSecret(): string {
  return randomBytes(32).toString("hex");
}

/** A session id or an office ticket as the database stores it. */
export function hashSecret(secret: string): string {
  return sha256(secret);
}

/** A session secret's shape. Anything else in the cookie is not a session. */
export function isSessionSecret(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
}
