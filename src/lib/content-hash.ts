/**
 * THE FILE'S FINGERPRINT, TAKEN BEFORE IT IS UPLOADED (0295).
 *
 * "The same FILE is never filed twice" is a promise about bytes, not names: he renames files
 * ("85 Whit.pdf"), the portal re-downloads the same invoice under a new name, and a phone hands a
 * photo over as IMG_0412.jpg the first time and IMG_0412 2.jpg the second. So the key is SHA-256
 * of the ORIGINAL bytes, hashed in the browser with Web Crypto (Safari, iOS and Node 22 all have
 * it), before any resize or re-encode could make the same paper hash differently twice.
 *
 * It is exactly the same FILE, and says nothing about the same PAPER photographed twice. Re-shot
 * paper is caught by its printed number and by a person looking at the list, never by this.
 */

const HEX = /^[0-9a-f]{64}$/;

/** A well-formed lowercase SHA-256 hex digest. The database checks the same shape (0295). */
export function isSha256(value: unknown): value is string {
  return typeof value === "string" && HEX.test(value);
}

/** SHA-256 of the bytes, lowercase hex. */
export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("This browser can't fingerprint files.");
  const view = data instanceof Uint8Array ? data : new Uint8Array(data);
  // A fresh ArrayBuffer-backed copy: digest() refuses a SharedArrayBuffer-backed view, and a view
  // into a larger buffer would hash the whole buffer rather than the bytes it shows.
  const bytes = new Uint8Array(view.byteLength);
  bytes.set(view);
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
