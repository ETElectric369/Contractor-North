// The unified Action Registry — ONE canonical, named, typed entry per capability.
// Every UI button, voice intent, and (later) Claude chat tool resolves a capability
// through this registry, so "anything the user can do, Claude can do" is structural,
// not maintained by hand. Each handler just wraps the EXISTING server action.

import type { z } from "zod";

/** Everything every server action already returns, plus optional agent extras. */
export type ActionResult = {
  ok: boolean;
  error?: string;
  data?: unknown;
  /** Driver-friendly sentence for voice/TTS read-back. */
  speak?: string;
  /** Set by executeAction when a confirm/tier-2 action was invoked by the agent/voice
   *  WITHOUT explicit consent — the surface must read confirmPrompt back and re-call
   *  with `confirmed: true`. The action did NOT run. */
  needsConfirm?: boolean;
  /** Human sentence describing what will happen, for the confirm read-back. */
  confirmPrompt?: string;
};

/** Resolved caller context, built once per execute() call. */
export type ActionCtx = {
  userId: string | null;
  orgId: string | null;
  role: string | null;
};

export type ActionAuth = "any" | "staff" | "owner";
export type ActionEffect = "read" | "write";
export type ActionConfirm = "destructive" | "financial";

/** Risk tier (agent-security framework §3):
 *  0 = read (safe), 1 = reversible single-record write (optimistic + undo),
 *  2 = money / PII / billing-affecting (confirm + fresh step-up re-auth),
 *  3 = delete/export another subscriber's data or move money out (human-only).
 *  Derived from effect+confirm via actionRisk() unless set explicitly. */
export type ActionRisk = 0 | 1 | 2 | 3;

export interface ActionDef<I = any> {
  /** Canonical id, e.g. "bill.update", "task.complete". group.verb. */
  name: string;
  /** Entity group, e.g. "bill" — for search/listing. */
  group: string;
  /** Human affordance label, e.g. "Edit bill". */
  label: string;
  /** Model-facing: when to use it (becomes the tool description later). */
  description: string;
  /** Zod schema → runtime validation AND (later) the generated tool input schema. */
  input: z.ZodType<I>;
  /** Role gate, enforced in execute(). */
  auth: ActionAuth;
  /** read = safe to auto-run; write = a mutation. */
  effect: ActionEffect;
  /** Forces a confirm step for the agent / a confirm modal in the UI. */
  confirm?: ActionConfirm;
  /** Risk tier (0-3). Optional — actionRisk() derives a safe default from
   *  effect+confirm. Set explicitly to escalate (e.g. a tier-3 human-only action). */
  risk?: ActionRisk;
  /** The implementation — wraps an existing server action. */
  handler: (input: I, ctx: ActionCtx) => Promise<ActionResult>;
}
