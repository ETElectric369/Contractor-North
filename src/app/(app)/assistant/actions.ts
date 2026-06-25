"use server";

import { executeAction } from "@/lib/actions/execute";
import { AGENT_WRITE_ALLOWED } from "@/lib/actions/agent-tools";
import type { AgentDraft } from "@/lib/assistant-protocol";

/** Save the live quote draft the user was watching build — their tap on Save IS the consent
 *  (source:"ui"), so it runs through the staff role gate + audit without a separate confirm.
 *  Returns the new quote id so the client can flip to the real quote page. */
export async function saveQuoteFromDraft(
  draft: AgentDraft,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const res = await executeAction(
    "quote.create",
    {
      customer_id: draft.customer_id ?? null,
      job_id: draft.job_id ?? null,
      title: draft.title ?? "",
      notes: "",
      tax_rate: draft.tax_rate ?? 0,
      valid_until: null,
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
