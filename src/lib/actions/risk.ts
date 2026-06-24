import type { ActionDef, ActionRisk } from "./types";

/** The risk tier for an action (agent-security framework §3). Explicit `risk` wins;
 *  otherwise a safe default is derived: reads → 0, confirm-gated (financial /
 *  destructive) → 2, any other write → 1. Tier 3 (human-only) is always opt-in,
 *  never derived. Pure (no registry/server imports) so it stays unit-testable. */
export function actionRisk(def: Pick<ActionDef, "effect" | "confirm" | "risk">): ActionRisk {
  if (def.risk !== undefined) return def.risk;
  if (def.effect === "read") return 0;
  if (def.confirm) return 2;
  return 1;
}

/** The Phase C confirm gate: does an AGENT/VOICE call have to be refused until the
 *  human has explicitly consented? A confirm-flagged or tier-2+ action does. The UI is
 *  exempt — its own confirm modal IS the consent, and a human is directly clicking.
 *  Pure (no server imports) so the security gate has unit coverage. */
export function needsConsent(
  def: Pick<ActionDef, "effect" | "confirm" | "risk">,
  source: "ui" | "voice" | "agent",
  confirmed: boolean | undefined,
): boolean {
  const confirmRequired = def.confirm != null || actionRisk(def) >= 2;
  return confirmRequired && source !== "ui" && !confirmed;
}

/** Whether an action needs the unforgeable WebAuthn step-up (C2): money MOVEMENT
 *  (an explicit `stepUp` flag — pay / refund / send funds) or a tier-3 action. A cost
 *  RECORD (confirm:"financial", e.g. bill.create) is confirm-only, NOT step-up; deletes
 *  are confirm-only too. When this is true, step-up is MANDATORY for the agent/voice
 *  (an un-enrolled caller is blocked, not waved through). Pure. */
export function requiresStepUp(def: Pick<ActionDef, "confirm" | "risk" | "stepUp">): boolean {
  return def.stepUp === true || (def.risk ?? 0) >= 3;
}
