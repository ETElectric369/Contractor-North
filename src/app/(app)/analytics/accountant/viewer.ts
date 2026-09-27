import { getOrgSettings } from "@/lib/org-settings";
import { OWNER_HIDDEN_WHY } from "@/lib/accountant-workbook";

/** Why the totals aren't shown, when a read failed: said in words, never the owner's-switch note. */
export const ORG_UNREAD_WORDS = "Your company's settings couldn't be read just now, so the totals aren't shown. Try again in a moment.";
export const ROLE_UNREAD_WORDS = "Your sign-in couldn't be checked just now, so the totals aren't shown. Try again in a moment.";

/**
 * WHO SEES THE TOTALS ON THE ACCOUNTANT PAGE: the owner, or an office viewer the owner has shared
 * Owner's Draw with (analytics/page.tsx's switch). FAIL CLOSED: a failed read of the company or of
 * the viewer's role shows no totals and says which read failed. Only a role that READ as not the
 * owner, with the switch off, gets the owner's-switch note: the owner is never told "the owner
 * hasn't shared" about themself.
 */
export function accountantPageViewer(
  orgRead: { data: unknown; error: unknown },
  meRead: { data: unknown; error: unknown },
): { showOwner: boolean; why: string | null } {
  const org = orgRead.data as { settings?: unknown } | null;
  if (orgRead.error || !org) return { showOwner: false, why: ORG_UNREAD_WORDS };
  const role = (meRead.data as { role?: string } | null)?.role;
  if (meRead.error || !role) return { showOwner: false, why: ROLE_UNREAD_WORDS };
  if (role === "owner" || getOrgSettings(org.settings).office_sees_owner_money) return { showOwner: true, why: null };
  return { showOwner: false, why: OWNER_HIDDEN_WHY };
}
