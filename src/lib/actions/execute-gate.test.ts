import { describe, it, expect, vi, beforeEach } from "vitest";

// executeAction is the ONE write entrypoint; its security gate (role → step-up → confirm) is what
// stands between the chat agent and the database. registry.test.ts checks the gate PREDICATES on
// hand-picked actions; this file adds the two things it doesn't: (1) a SYSTEMATIC invariant over
// the WHOLE agent whitelist (so a future entry with a wrong/missing flag fails CI, not in the
// field), and (2) an end-to-end proof that executeAction actually ENFORCES the gate — by stubbing
// the three server-bound deps so the gate can run in plain Node without a DB.

const { buildActionCtx, stepUpGate } = vi.hoisted(() => ({
  buildActionCtx: vi.fn(),
  stepUpGate: vi.fn(),
}));
vi.mock("./context", () => ({ buildActionCtx }));
vi.mock("@/lib/webauthn/stepup", () => ({ stepUpGate }));
// The only DB touch in the gate paths is the best-effort audit insert — stub it so it no-ops.
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ from: () => ({ insert: async () => ({ error: null }) }) })),
}));

import { executeAction } from "./execute";
import { REGISTRY } from "./registry";
import { AGENT_WRITE_ALLOWED, agentWriteToolsForRole } from "./agent-tools";
import { actionRisk, needsConsent } from "./risk";

const WHITELIST = [...AGENT_WRITE_ALLOWED];
const toName = (t: string) => t.replace(/__/g, ".");

describe("agent write whitelist — whole-set invariants (every entry, not a sample)", () => {
  it("every whitelisted name is a real WRITE action in the registry", () => {
    for (const n of WHITELIST) {
      const def = REGISTRY[n];
      expect(def, `${n} is whitelisted but missing from REGISTRY`).toBeDefined();
      expect(def.effect, `${n} is whitelisted but not a write`).toBe("write");
    }
  });

  it("no whitelisted action is money-MOVEMENT (step-up) or tier-3 (human-only)", () => {
    for (const n of WHITELIST) {
      const def = REGISTRY[n];
      expect(Boolean(def.stepUp), `${n} requires step-up — must never be agent-reachable`).toBe(false);
      expect(actionRisk(def), `${n} is tier-3 (human-only) — must never be agent-reachable`).toBeLessThan(3);
    }
  });

  it("every whitelisted action actually passes the offer filter — no dead/misconfigured entry", () => {
    // Mirrors agentWriteToolsForRole's filter exactly: a tier-2 action that forgot its `confirm`
    // flag would be risk>=2 with confirm==null → dropped here → caught as a dead whitelist entry.
    for (const n of WHITELIST) {
      const def = REGISTRY[n];
      const offerable = (actionRisk(def) <= 1 || def.confirm != null) && !def.stepUp && actionRisk(def) < 3;
      expect(offerable, `${n} is whitelisted but the offer filter would silently drop it`).toBe(true);
    }
  });

  it("an owner is offered exactly the whitelisted set (offer ⊇ whitelist)", () => {
    const offered = new Set(agentWriteToolsForRole("owner").tools.map((t) => toName(t.name)));
    for (const n of WHITELIST) expect(offered.has(n), `${n} is whitelisted but not offered to owner`).toBe(true);
  });

  it("a tech is never offered a staff/owner-only whitelisted action", () => {
    const tech = new Set(agentWriteToolsForRole("tech").tools.map((t) => toName(t.name)));
    for (const n of WHITELIST) {
      const def = REGISTRY[n];
      if (def.auth !== "any") expect(tech.has(n), `${n} (auth=${def.auth}) leaked into a tech's tools`).toBe(false);
    }
  });

  it("every confirm-gated whitelisted action fires the consent gate for the agent and clears on an explicit yes; the UI is always exempt", () => {
    for (const n of WHITELIST) {
      const def = REGISTRY[n];
      if (def.confirm != null) {
        expect(needsConsent(def, "agent", false), `${n} is confirm-flagged but doesn't block the agent`).toBe(true);
        expect(needsConsent(def, "agent", true), `${n} consent isn't cleared by an explicit yes`).toBe(false);
      }
      expect(needsConsent(def, "ui", false), `${n} should be UI-exempt (the modal is the consent)`).toBe(false);
    }
  });
});

describe("executeAction — the gate is wired into the entrypoint", () => {
  beforeEach(() => {
    buildActionCtx.mockReset();
    stepUpGate.mockReset();
    // Default: not a money/passkey action → fall through to the confirm gate.
    stepUpGate.mockResolvedValue({ kind: "skip" });
  });

  it("an unknown action is rejected before any context is built", async () => {
    const r = await executeAction("nope.nope", {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/unknown action/i);
    expect(buildActionCtx).not.toHaveBeenCalled();
  });

  it("a signed-out caller is blocked", async () => {
    buildActionCtx.mockResolvedValue({ userId: null, orgId: null, role: null });
    const r = await executeAction("task.create", { title: "x" }, { source: "agent" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/signed in/i);
  });

  it("a TECH calling a staff-only action is denied by the role gate before the handler runs", async () => {
    buildActionCtx.mockResolvedValue({ userId: "u1", orgId: "o1", role: "tech" });
    const r = await executeAction("payment.record", { invoice_id: "i1", amount: 100 }, { source: "agent", confirmed: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/staff-only/i);
  });

  it("a confirm-gated financial action BLOCKS until the user confirms (agent source, confirmed:false)", async () => {
    buildActionCtx.mockResolvedValue({ userId: "u1", orgId: "o1", role: "owner" });
    const r = await executeAction("payment.record", { invoice_id: "i1", amount: 100 }, { source: "agent", confirmed: false });
    expect(r.ok).toBe(false);
    expect(r.needsConfirm).toBe(true);
    expect(r.confirmPrompt && r.confirmPrompt.length).toBeTruthy();
  });

  it("a step-up BLOCK from the gate stops the action even when confirmed:true", async () => {
    buildActionCtx.mockResolvedValue({ userId: "u1", orgId: "o1", role: "owner" });
    stepUpGate.mockResolvedValue({ kind: "block", result: { ok: false, error: "Passkey required." } });
    const r = await executeAction("payment.record", { invoice_id: "i1", amount: 100 }, { source: "agent", confirmed: true });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/passkey/i);
  });
});
