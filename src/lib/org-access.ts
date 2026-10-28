import "server-only";
import { createServiceClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observe";
import { accessState, type AccessState, BILLING_COLUMNS } from "@/lib/subscription";
import { billingEnabled } from "@/lib/stripe";

/**
 * THE SERVER'S ONE READ OF A COMPANY'S STANDING (cn-v1137). Nort's chat route, the voice gate, the
 * public site chat, the texting doors and the AI ceiling all ask this before they spend a cent on a
 * company's behalf. It reads the billing columns on the service client (the caller holds a bare org
 * id, not the row) and answers accessState — never a second rule.
 *
 * FAILS OPEN: a billing read that fails must never lock a contractor out of their own assistant
 * mid-job (the layout's wall and the AI ceiling make the same call). The failure is filed.
 * BILLING OFF (no Stripe key) = everyone is active: there is nothing to lapse from.
 */
/** THE BILLING COLUMNS AND THE ID, nothing more: this read sits on the hot path of every chat turn,
 *  voice call and paper read, and nothing reads `.org` for anything but the standing (skeptic #43,
 *  S8 — the name, the email, the settings blob and the Stripe ids rode along unread). */
export const ORG_ACCESS_COLUMNS = `id, ${BILLING_COLUMNS.join(", ")}`;

export type OrgAccessRow = {
  id: string;
  subscription_status: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
  comped_until: string | null;
};

export type OrgAccess = { state: AccessState; org: OrgAccessRow | null; readFailed: boolean };

const OPEN: AccessState = { active: true, reason: "active", daysLeft: null, compedBy: null };

export async function orgAccess(orgId: string | null | undefined, nowMs = Date.now()): Promise<OrgAccess> {
  if (!orgId) return { state: OPEN, org: null, readFailed: false };
  if (!billingEnabled) return { state: OPEN, org: null, readFailed: false };
  try {
    const sb = createServiceClient();
    const { data, error } = await sb.from("organizations").select(ORG_ACCESS_COLUMNS).eq("id", orgId).maybeSingle();
    if (error) throw error;
    if (!data) return { state: OPEN, org: null, readFailed: false };
    const org = data as unknown as OrgAccessRow;
    return { state: accessState(org, { nowMs }), org, readFailed: false };
  } catch (e) {
    reportError("org-access:read", e, { orgId });
    return { state: OPEN, org: null, readFailed: true };
  }
}

/**
 * THE REFUSAL, in the company's own words (no merry-go-round: one action). The owner is told the
 * door; everyone else is told who holds the key.
 */
export function refusalWords(
  state: AccessState,
  role: string | null | undefined,
  ownerFirstName?: string | null,
): string {
  const what =
    state.reason === "trial_ended"
      ? "This company's free trial has ended"
      : state.reason === "grace_spent"
        ? "This company's card was not updated in time"
        : "This company's plan has ended";
  const canFix = role === "owner" || role === "admin";
  if (canFix) return `${what}, so Nort is paused. Pick a plan in Settings › Getting Paid.`;
  const who = ownerFirstName?.trim() ? ownerFirstName.trim() : "the owner";
  return `${what}, so Nort is paused. Ask ${who} to pick a plan.`;
}
