"use server";

import { REGISTRY } from "./registry";
import { buildActionCtx } from "./context";
import type { ActionResult } from "./types";

/**
 * The ONE write entrypoint for the whole app. Look up the named action, build the
 * caller context server-side (never client-trusted), enforce the per-action role
 * gate, validate the input against the action's Zod schema, then run its handler.
 * UI buttons, voice, and (later) the Claude chat tool-loop all call this by name.
 */
export async function executeAction(name: string, rawInput: unknown): Promise<ActionResult> {
  const def = REGISTRY[name];
  if (!def) return { ok: false, error: `Unknown action: ${name}` };

  // Context is always resolved server-side so a client can't spoof its role.
  const ctx = await buildActionCtx();
  if (!ctx.userId) return { ok: false, error: "Not signed in." };
  if (def.auth === "staff" && !ctx.isStaff) return { ok: false, error: "This action is staff-only." };
  if (def.auth === "owner" && ctx.role !== "owner") return { ok: false, error: "This action is owner-only." };

  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  try {
    return await def.handler(parsed.data, ctx);
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Action failed." };
  }
}
