import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * THE HELD SEAL'S OWN KEY (cn-v1139). A clock-in that wakes a held job writes one sealed line onto
 * its own punch (timeclock/actions.ts noteHeldBefore), and the take-back puts the hold back only
 * when the seal checks (heldBefore). Until cn-v1139 the seal was keyed with the Supabase
 * service-role key, so rotating THAT key broke every take-back of a line written before the
 * rotation. The seal has a key of its own now:
 *
 *   sign    HELD_SEAL_SECRET when set; else the service-role key — today's behaviour, byte for
 *           byte, until the new name is pasted into the environment.
 *   verify  the current key first, then HELD_SEAL_SECRET_PREVIOUS when set, then the service-role
 *           key — so a line sealed before a rotation still restores for as long as the old value is
 *           kept under _PREVIOUS, and a line sealed under the service key alone (before
 *           HELD_SEAL_SECRET existed) still restores after it arrives.
 *
 * To rotate: move the current value to HELD_SEAL_SECRET_PREVIOUS, paste a new one into
 * HELD_SEAL_SECRET, drop _PREVIOUS a week later (a take-back is a two-minute window). Every compare
 * is constant-time (timingSafeEqual). No key is ever logged, returned or put in an error: the two
 * functions answer a seal, or yes/no, and nothing else.
 */

/** A seal is the first 16 hex characters of HMAC-SHA256("<punch id>|<the line's JSON>") (lib/held-crumb's pattern). */
const SEAL_LENGTH = 16;

const sealWith = (key: string, entryId: string, json: string): string =>
  createHmac("sha256", key).update(`${entryId}|${json}`).digest("hex").slice(0, SEAL_LENGTH);

const present = (v: string | undefined): v is string => typeof v === "string" && v.length > 0;

/** The key a NEW seal is written with: HELD_SEAL_SECRET, else the service key; null when neither is set. */
function signingKey(): string | null {
  const own = process.env.HELD_SEAL_SECRET;
  if (present(own)) return own;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return present(service) ? service : null;
}

/** The keys a seal is checked against, in order, each once: the current key, the previous one, the service key. */
function verifyingKeys(): string[] {
  const keys: string[] = [];
  for (const k of [signingKey() ?? undefined, process.env.HELD_SEAL_SECRET_PREVIOUS, process.env.SUPABASE_SERVICE_ROLE_KEY]) {
    if (present(k) && !keys.includes(k)) keys.push(k);
  }
  return keys;
}

/** The seal for this punch's line, or null when the environment holds no key to seal with (no line is written then). */
export function sealHeld(entryId: string, json: string): string | null {
  const key = signingKey();
  return key ? sealWith(key, entryId, json) : null;
}

/** Is this seal the one the line was written with, under any key still honoured? Constant-time per key. */
export function heldSealOk(entryId: string, json: string, seal: string): boolean {
  if (typeof seal !== "string" || seal.length !== SEAL_LENGTH) return false;
  const given = Buffer.from(seal);
  for (const key of verifyingKeys()) {
    const want = Buffer.from(sealWith(key, entryId, json));
    if (want.length === given.length && timingSafeEqual(given, want)) return true;
  }
  return false;
}
