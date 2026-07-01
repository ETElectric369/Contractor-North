"use server";

import { executeAction } from "@/lib/actions/execute";
import { AGENT_WRITE_ALLOWED } from "@/lib/actions/agent-tools";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";
import { getOrgSettings } from "@/lib/org-settings";
import type { AgentDraft } from "@/lib/assistant-protocol";

type StoredMsg = { role: "user" | "assistant"; content: string };

export type PickerContact = { id: string; name: string; company: string | null; city: string | null; type: string };

/** Search contacts for the on-screen picker the assistant pops (the request_contact handoff).
 *  Staff-only + RLS-scoped to the org. Returns the lightweight fields the picker shows. */
export async function searchContacts(query: string, type?: string): Promise<PickerContact[]> {
  const ctx = await requireStaff();
  if ("error" in ctx) return [];
  let q = ctx.supabase.from("customers").select("id, name, company_name, city, type").order("name").limit(25);
  const s = String(query ?? "").trim().replace(/[%_]/g, "");
  if (s) q = q.or(`name.ilike.%${s}%,company_name.ilike.%${s}%`);
  if (type && ["residential", "commercial", "industrial", "subcontractor"].includes(type)) q = q.eq("type", type);
  const { data } = await q;
  return (data ?? []).map((c: any) => ({ id: c.id, name: c.name, company: c.company_name, city: c.city, type: c.type }));
}

/** Restore the user's saved conversation + live quote draft (pick up where you left off). */
export async function loadConversation(): Promise<{ messages: StoredMsg[]; draft: AgentDraft | null }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { messages: [], draft: null };
  const { data } = await supabase.from("assistant_state").select("messages, draft").eq("user_id", user.id).maybeSingle();
  return { messages: (data?.messages as StoredMsg[]) ?? [], draft: (data?.draft as AgentDraft | null) ?? null };
}

/** Persist the conversation + draft (RLS-private to this user) so it survives a close. */
export async function saveConversation(messages: StoredMsg[], draft: AgentDraft | null): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false };
  const capped = (messages ?? []).slice(-40).map((m) => ({ role: m.role, content: String(m.content ?? "").slice(0, 8000) }));
  // The glass drawer opens FRESH (it doesn't load the message backlog into state) but still restores
  // an open draft — its first auto-save would then upsert messages: [] and WIPE the saved history.
  // Guard: never overwrite a non-empty stored history with an empty in-memory list; update only the
  // draft. (New chat still clears via clearConversation, which deletes the row.)
  if (capped.length === 0) {
    const { data: existing } = await supabase.from("assistant_state").select("messages").eq("user_id", user.id).maybeSingle();
    if (((existing?.messages as StoredMsg[] | null) ?? []).length > 0) {
      const { error } = await supabase
        .from("assistant_state")
        .update({ draft: draft ?? null, updated_at: new Date().toISOString() })
        .eq("user_id", user.id);
      return { ok: !error };
    }
  }
  const { error } = await supabase.from("assistant_state").upsert({
    user_id: user.id,
    messages: capped,
    draft: draft ?? null,
    updated_at: new Date().toISOString(),
  });
  return { ok: !error };
}

/** Start fresh — forget the current conversation (memory facts are kept). */
export async function clearConversation(): Promise<{ ok: boolean }> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { ok: false };
  await supabase.from("assistant_state").delete().eq("user_id", user.id);
  return { ok: true };
}

/** Save the live quote draft the user was watching build — their tap on Save IS the consent
 *  (source:"ui"), so it runs through the staff role gate + audit without a separate confirm.
 *  Returns the new quote id so the client can flip to the real quote page. */
export async function saveQuoteFromDraft(
  draft: AgentDraft,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const supabase = await createClient();
  // Nort builds an estimate "for Jackie Burks" (a NAME) but may not carry her customer_id — so the
  // saved quote was landing "No customer attached". Resolve the name to a real customer: match an
  // existing one first (case-insensitive, exact then contains), and only create a new record if there's
  // genuinely no match. That way the quote is always attached and we don't spawn duplicate customers.
  let customerId = draft.customer_id ?? null;
  const custName = (draft.customer_name ?? "").trim();
  if (!customerId && custName) {
    const esc = custName.replace(/[\\%_]/g, (m) => "\\" + m);
    const exact = await supabase.from("customers").select("id").ilike("name", esc).limit(1).maybeSingle();
    customerId = (exact.data as { id?: string } | null)?.id ?? null;
    if (!customerId) {
      const partial = await supabase.from("customers").select("id").ilike("name", `%${esc}%`).limit(1).maybeSingle();
      customerId = (partial.data as { id?: string } | null)?.id ?? null;
    }
    if (!customerId) {
      const made = await executeAction("customer.create", { name: custName }, { source: "ui" });
      if (made.ok) customerId = (made.data as { id?: string } | undefined)?.id ?? null;
    }
  }

  // The manual builder (quotes/new) seeds tax from the org's DEFAULT tax rate and expiry from
  // quote_expiry_days — the agent path was saving a thinner document (tax 0, no expiry). Mirror
  // those org defaults here, but only where the draft doesn't already carry a value.
  const [{ data: defTax }, { data: org }] = await Promise.all([
    supabase.from("tax_rates").select("rate").eq("is_default", true).limit(1).maybeSingle(),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
  ]);
  const taxRate =
    draft.tax_rate != null ? draft.tax_rate : defTax ? Number((defTax as { rate: number }).rate) / 100 : 0;
  const expiryDays = getOrgSettings((org as { settings?: unknown } | null)?.settings).quote_expiry_days;
  const validUntil = (() => {
    const d = new Date();
    d.setDate(d.getDate() + (expiryDays || 30));
    return d.toISOString().slice(0, 10);
  })();

  const res = await executeAction(
    "quote.create",
    {
      customer_id: customerId,
      job_id: draft.job_id ?? null,
      title: draft.title ?? "",
      notes: "",
      tax_rate: taxRate,
      valid_until: validUntil,
      items: (draft.items ?? []).map((i) => ({
        description: i.description,
        quantity: Number(i.quantity) || 1,
        unit: i.unit || "ea",
        unit_price: Number(i.unit_price) || 0,
      })),
    },
    { source: "ui" },
  );
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, id: (res.data as { id?: string } | undefined)?.id };
}

/**
 * Run an agent-proposed action AFTER the user explicitly confirmed it in the chat (the
 * confirm card / a spoken "yes"). This is the chat analogue of confirmVoiceAction: the
 * model can only PROPOSE a confirm-gated action (executeAction returns needsConfirm for
 * source:"agent" without consent); the action only actually runs through HERE, which is
 * called by client code gated behind the user's real yes — so a prompt-injection that
 * makes the model propose still can't execute anything. The role gate + RLS + audit inside
 * executeAction still apply (e.g. a tech is denied bill.create regardless).
 */
export async function confirmAgentAction(
  name: string,
  input: Record<string, unknown>,
): Promise<{ ok: boolean; message: string }> {
  if (!AGENT_WRITE_ALLOWED.has(name)) {
    return { ok: false, message: "That action can't be done from here." };
  }
  const res = await executeAction(name, input, { source: "agent", confirmed: true });
  // Money-MOVEMENT would need a WebAuthn tap; none of the agent-allowed set is, but guard.
  if (res.needsStepUp) {
    return { ok: false, message: "That one needs a Face ID tap, which isn't wired into chat yet." };
  }
  if (!res.ok) {
    return { ok: false, message: res.error ? `Sorry — ${res.error}` : "That didn't work." };
  }
  return { ok: true, message: res.speak ?? "Done." };
}
