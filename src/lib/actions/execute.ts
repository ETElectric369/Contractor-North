"use server";

import { REGISTRY } from "./registry";
import { actionRisk, needsConsent } from "./risk";
import { stepUpGate } from "@/lib/webauthn/stepup";
import { roleCanRun } from "./perms";
import { buildActionCtx } from "./context";
import { createClient } from "@/lib/supabase/server";
import type { ActionCtx, ActionDef, ActionResult } from "./types";

type ActionSource = "ui" | "voice" | "agent";

/**
 * Append a best-effort audit row for a WRITE action (framework Pillar 6). Reads are
 * not logged (high-volume, low audit value). Records ONLY the input keys + a record
 * id — never PII or secret values. Never throws: auditing must not break the action.
 */
async function logAction(
  def: ActionDef,
  ctx: ActionCtx,
  source: ActionSource,
  input: unknown,
  result: ActionResult,
): Promise<void> {
  if (def.effect !== "write") return;
  try {
    const supabase = await createClient();
    const obj = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    await supabase.from("agent_audit_log").insert({
      org_id: ctx.orgId,
      user_id: ctx.userId,
      action: def.name,
      risk: actionRisk(def),
      effect: def.effect,
      ok: result.ok,
      error: result.ok ? null : (result.error ?? "").slice(0, 500) || null,
      input_summary: { keys: Object.keys(obj), id: (obj as { id?: unknown }).id ?? null },
      source,
    });
  } catch {
    /* audit is best-effort — never surface to the caller */
  }
}

/**
 * The ONE write entrypoint for the whole app. Look up the named action, build the
 * caller context server-side (never client-trusted), enforce the per-action role
 * gate, validate the input against the action's Zod schema, run its handler, and
 * append an audit row. UI buttons, voice, and (later) the Claude chat tool-loop all
 * call this by name — `opts.source` records which surface invoked it.
 */
export async function executeAction(
  name: string,
  rawInput: unknown,
  opts?: { source?: ActionSource; confirmed?: boolean; stepUpAssertion?: unknown },
): Promise<ActionResult> {
  const source = opts?.source ?? "ui";
  const def = REGISTRY[name];
  if (!def) return { ok: false, error: `Unknown action: ${name}` };

  // Context is always resolved server-side so a client can't spoof its role.
  const ctx = await buildActionCtx();
  if (!ctx.userId) return { ok: false, error: "Not signed in." };
  // Same predicate that filters the offer (actionsForRole) gates execution here —
  // least privilege can't drift between what's shown and what's allowed.
  if (!roleCanRun(ctx.role, def.auth)) {
    const denied: ActionResult = {
      ok: false,
      error: def.auth === "owner" ? "This action is owner-only." : "This action is staff-only.",
    };
    await logAction(def, ctx, source, rawInput, denied);
    return denied;
  }

  const parsed = def.input.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  // Step-up + confirm gate (framework §3) — makes def.confirm / the risk tier load-bearing
  // instead of advisory. For the AGENT / VOICE (the UI is exempt — its own modal is the
  // consent + a human is directly clicking):
  //  · MONEY actions (financial / tier-2+) require a fresh WebAuthn assertion when the
  //    caller has a passkey — the unforgeable consent (C2). Not enrolled → the confirm
  //    read-back below applies instead.
  //  · everything else confirm-flagged (e.g. destructive) needs the explicit consent flag.
  if (source !== "ui") {
    const su = await stepUpGate(ctx.userId, def, parsed.data, source, opts?.stepUpAssertion);
    if (su.kind === "block") {
      await logAction(def, ctx, source, parsed.data, su.result);
      return su.result;
    }
    if (su.kind !== "pass" && needsConsent(def, source, opts?.confirmed)) {
      const blocked: ActionResult = {
        ok: false,
        needsConfirm: true,
        // Descriptive read-back when the action provides one (e.g. the dollar amount), so a
        // spoken confirm states WHAT is being approved — never just "Add cost".
        confirmPrompt: def.describe ? def.describe(parsed.data) : `${def.label} — say yes to confirm.`,
        // Carry the VALIDATED input (not the raw model output) across the confirm boundary, so
        // what the card shows == what actually runs, with no Zod-coercion desync.
        data: parsed.data,
        error: `${def.label} needs confirmation.`,
      };
      await logAction(def, ctx, source, parsed.data, blocked);
      return blocked;
    }
  }

  let result: ActionResult;
  try {
    result = await def.handler(parsed.data, ctx);
  } catch (e: any) {
    result = { ok: false, error: e?.message ?? "Action failed." };
  }
  await logAction(def, ctx, source, parsed.data, result);
  return result;
}
