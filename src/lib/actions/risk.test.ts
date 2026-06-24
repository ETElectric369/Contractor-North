import { describe, it, expect } from "vitest";
import { actionRisk, needsConsent, requiresStepUp } from "./risk";

describe("actionRisk — agent-security tier derivation (framework §3)", () => {
  it("reads are tier 0 (safe, no confirm)", () => {
    expect(actionRisk({ effect: "read" })).toBe(0);
  });
  it("an ordinary write is tier 1 (reversible)", () => {
    expect(actionRisk({ effect: "write" })).toBe(1);
  });
  it("a financial write escalates to tier 2 (confirm + step-up)", () => {
    expect(actionRisk({ effect: "write", confirm: "financial" })).toBe(2);
  });
  it("a destructive write escalates to tier 2", () => {
    expect(actionRisk({ effect: "write", confirm: "destructive" })).toBe(2);
  });
  it("an explicit risk always wins (tier 3 is opt-in, never derived)", () => {
    expect(actionRisk({ effect: "write", risk: 3 })).toBe(3);
    expect(actionRisk({ effect: "write", confirm: "financial", risk: 0 })).toBe(0);
    expect(actionRisk({ effect: "read", risk: 2 })).toBe(2);
  });
});

describe("needsConsent — Phase C confirm gate", () => {
  const financial = { effect: "write" as const, confirm: "financial" as const };
  const destructive = { effect: "write" as const, confirm: "destructive" as const };
  const plainWrite = { effect: "write" as const };
  const read = { effect: "read" as const };

  it("BLOCKS a financial action from voice with no consent", () => {
    expect(needsConsent(financial, "voice", undefined)).toBe(true);
  });
  it("BLOCKS a destructive action from the agent with no consent", () => {
    expect(needsConsent(destructive, "agent", false)).toBe(true);
  });
  it("ALLOWS once the human consented (confirmed: true)", () => {
    expect(needsConsent(financial, "voice", true)).toBe(false);
    expect(needsConsent(destructive, "agent", true)).toBe(false);
  });
  it("EXEMPTS the UI — its own modal is the consent", () => {
    expect(needsConsent(financial, "ui", undefined)).toBe(false);
    expect(needsConsent(destructive, "ui", undefined)).toBe(false);
  });
  it("does NOT gate tier-0/1 actions (reads + ordinary writes) from any surface", () => {
    expect(needsConsent(read, "voice", undefined)).toBe(false);
    expect(needsConsent(plainWrite, "voice", undefined)).toBe(false);
    expect(needsConsent(plainWrite, "agent", undefined)).toBe(false);
  });
  it("gates an explicitly tier-2 action even without a confirm flag", () => {
    expect(needsConsent({ effect: "write", risk: 2 }, "voice", undefined)).toBe(true);
    expect(needsConsent({ effect: "write", risk: 2 }, "voice", true)).toBe(false);
  });
});

describe("requiresStepUp — Phase C2 (which actions need the Face ID tap)", () => {
  it("financial actions require step-up", () => {
    expect(requiresStepUp({ confirm: "financial" })).toBe(true);
  });
  it("explicit tier-2+ requires step-up", () => {
    expect(requiresStepUp({ risk: 2 })).toBe(true);
    expect(requiresStepUp({ risk: 3 })).toBe(true);
  });
  it("destructive is confirm-only — NOT step-up (deleting a task shouldn't need Face ID)", () => {
    expect(requiresStepUp({ confirm: "destructive" })).toBe(false);
  });
  it("ordinary writes / reads never need step-up", () => {
    expect(requiresStepUp({})).toBe(false);
    expect(requiresStepUp({ risk: 1 })).toBe(false);
  });
});
