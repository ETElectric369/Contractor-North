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
};

/** Resolved caller context, built once per execute() call. */
export type ActionCtx = {
  userId: string | null;
  role: string | null;
  isStaff: boolean;
};

export type ActionAuth = "any" | "staff" | "owner";
export type ActionEffect = "read" | "write";
export type ActionConfirm = "destructive" | "financial";

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
  /** The implementation — wraps an existing server action. */
  handler: (input: I, ctx: ActionCtx) => Promise<ActionResult>;
}
