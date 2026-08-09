import type { Need } from "./types";

/**
 * A FINGERPRINT OF A SET OF QUESTIONS, computed identically on the client and the server.
 *
 * Erik and Andrew were both editing Vivian Builders' intake playbook at the same time. Two changes
 * were written and verified in a live browser; Andrew then pressed Save on a page that had loaded
 * BEFORE that write, and his stale copy went straight over the top. No error, no warning, nothing
 * in either UI — it looked successful to both of us and the questions simply reverted. That is the
 * silent-write law wearing a different hat: the row updated fine, it just updated to the wrong
 * thing.
 *
 * It lives in ONE file because the guard only works if both sides hash the same bytes. Two copies
 * of "roughly this hash" is a guard that refuses every save on some forms and none on others.
 */
export function stampNeeds(needs: Need[] | null | undefined): string {
  const s = JSON.stringify(needs ?? []);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return String(h);
}
