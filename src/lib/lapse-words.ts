import "server-only";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observe";
import { refusalWords } from "@/lib/org-access";
import { accessState, type AccessState, type BillingOrg } from "@/lib/subscription";
import { billingEnabled } from "@/lib/stripe";
import { canPickPlan } from "@/lib/lapse-doors";

/**
 * THE LAPSE REFUSAL'S WORDS, WITH THE PERSON IN THEM (cn-v1137, decision 3). refusalWords
 * (lib/org-access) builds the sentence from the company's standing and the asker's role; the two
 * reads that make it personal live here, so every paused door — Nort's chat, the AI reads, the
 * voice gate, the texting doors — asks ONE helper and says the same thing:
 *
 *   owner / admin:  "… Pick a plan in Settings › Getting Paid."
 *   everyone else:  "… Ask <the owner's first name> to pick a plan."
 *
 * Both reads are best-effort and NEVER throw: a refusal must come out even when the profile read
 * fails — with "the owner" standing in for a name, and the ask-the-owner line for a role nobody
 * could read (the owner is told the door the moment his role reads; a tech is never told to pick
 * a plan he cannot). A failed owner read is filed (lapse-words:owner-read) and reads "the owner".
 *
 * ownerFirstName is THE owner read: /subscribe's subline and the Settings plan card for someone
 * who cannot pick a plan ask it too (skeptic #43, S12 — /subscribe carried its own copy).
 */

const OPEN: AccessState = { active: true, reason: "active", daysLeft: null, compedBy: null };

/** orgAccess's rule for a company row a door has ALREADY read with the billing columns (Nort's chat
 *  route reads them beside the settings): billing off, or no row, is open; otherwise accessState. One
 *  read, never a second trip to the same table. */
export function accessOfRow(org: BillingOrg | null | undefined, nowMs = Date.now()): AccessState {
  if (!billingEnabled || !org) return OPEN;
  return accessState(org, { nowMs });
}

/** May this role pick a plan? THE wall's own rule (lib/lapse-doors), never a second spelling. */
export { canPickPlan };

/** The signed-in person's role, read for the refusal alone; null when there is nobody or it fails. */
export async function callerRole(): Promise<string | null> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;
    const { data } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
    const role = (data as { role?: string | null } | null)?.role;
    return typeof role === "string" && role ? role : null;
  } catch {
    return null;
  }
}

/** The company's active owner's first name (service client: a tech's RLS may not see the owner's
 *  row); null when there is none or the read fails — the words then say "the owner", and a failed
 *  read is filed, never thrown. */
export async function ownerFirstName(orgId: string | null | undefined): Promise<string | null> {
  if (!orgId) return null;
  try {
    const sb = createServiceClient();
    const { data, error } = await sb
      .from("profiles")
      .select("full_name")
      .eq("org_id", orgId)
      .eq("role", "owner")
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const full = (data as { full_name?: string | null } | null)?.full_name?.trim() ?? "";
    const first = full.split(/\s+/)[0] ?? "";
    return first ? first.slice(0, 40) : null;
  } catch (e) {
    reportError("lapse-words:owner-read", e, { orgId });
    return null;
  }
}

/** Nort's own refusal for a paused company: refusalWords with the owner named when the asker
 *  cannot pick a plan. One small read, only on that path. */
export async function nortPausedWords(
  state: AccessState,
  role: string | null | undefined,
  orgId: string | null | undefined,
): Promise<string> {
  if (canPickPlan(role)) return refusalWords(state, role);
  return refusalWords(state, role, await ownerFirstName(orgId));
}

/** The texting doors' refusal (Text on an estimate, Text on an invoice): nothing was sent. */
export function textingPausedWords(role: string | null | undefined, owner?: string | null): string {
  if (canPickPlan(role)) return "Texting is paused until a plan is picked. Pick a plan in Settings › Getting Paid.";
  const who = owner?.trim() ? owner.trim() : "the owner";
  return `Texting is paused until a plan is picked. Ask ${who} to pick a plan.`;
}

/** textingPausedWords for the signed-in person: the role and, when needed, the owner's name read here. */
export async function textingPausedWordsFor(orgId: string | null | undefined, role?: string | null): Promise<string> {
  const r = role === undefined ? await callerRole() : role;
  if (canPickPlan(r)) return textingPausedWords(r);
  return textingPausedWords(r, await ownerFirstName(orgId));
}
