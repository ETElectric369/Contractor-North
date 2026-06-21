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
