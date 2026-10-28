import "server-only";
import { requireStaff } from "@/lib/staff-guard";
import { ownerFirstName } from "@/lib/lapse-words";

/**
 * WHO MAY DOWNLOAD EVERYTHING THE COMPANY HAS (cn-v1138): the owner, and only the owner. Built on
 * requireStaff (signed in, staff, not deactivated) with one more step, the role it answers. Each
 * refusal is a status and ONE sentence naming one action:
 *   · not signed in → 401, "Sign in to …";
 *   · not staff (a tech, a customer's portal seat), deactivated, or staff with no company → 403,
 *     "Ask the owner to …" (requireStaff's own refusal; whose owner is not known here);
 *   · an office or admin seat → 403, "Ask <first name> to …", through THE owner read
 *     (lib/lapse-words ownerFirstName; "the owner" when it fails or there is none).
 * This reads NO subscription state on purpose: a lapsed company's owner must still be able to take
 * their data out (the lapse policy keeps the books open).
 */
export type OwnerExportVerdict = { ok: true; orgId: string; profileId: string } | { ok: false; status: number; words: string };

export const SIGN_IN_WORDS = "Sign in to download the company's data.";
export const OWNER_ONLY_WORDS = "Ask the owner to download the company's data.";

export async function requireOwnerExport(): Promise<OwnerExportVerdict> {
  const ctx = await requireStaff();
  if ("error" in ctx) {
    if (ctx.error === "Not signed in.") return { ok: false, status: 401, words: SIGN_IN_WORDS };
    return { ok: false, status: 403, words: OWNER_ONLY_WORDS };
  }
  if (!ctx.orgId) return { ok: false, status: 403, words: OWNER_ONLY_WORDS };
  if (ctx.role !== "owner") {
    const first = await ownerFirstName(ctx.orgId);
    return { ok: false, status: 403, words: `Ask ${first ?? "the owner"} to download the company's data.` };
  }
  return { ok: true, orgId: ctx.orgId, profileId: ctx.userId };
}
