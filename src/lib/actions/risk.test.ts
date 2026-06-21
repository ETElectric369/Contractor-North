import { describe, it, expect } from "vitest";
import { actionRisk } from "./risk";

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
