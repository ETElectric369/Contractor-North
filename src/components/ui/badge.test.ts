import { describe, it, expect } from "vitest";
import { statusTone, toneClasses } from "@/components/ui/badge";

describe("statusTone — THE one status→color palette", () => {
  it("money/positive statuses are green", () => {
    for (const s of ["accepted", "complete", "approved", "paid", "signed", "active", "in_progress"]) {
      expect(statusTone(s)).toBe("green");
    }
  });
  it("in-flight / awaiting statuses are amber", () => {
    for (const s of ["draft", "estimate", "pending", "open", "unpaid", "partial", "lead"]) {
      expect(statusTone(s)).toBe("amber");
    }
  });
  it("sent/scheduled are blue (the portal reconciliation: 'sent' is blue app-wide, not amber)", () => {
    expect(statusTone("sent")).toBe("blue");
    expect(statusTone("scheduled")).toBe("blue");
  });
  it("dead/negative statuses are red — including overdue", () => {
    for (const s of ["cancelled", "declined", "expired", "overdue", "inactive"]) {
      expect(statusTone(s)).toBe("red");
    }
  });
  it("unknown → slate", () => {
    expect(statusTone("something_new")).toBe("slate");
  });
});

describe("toneClasses — bare spans pull from the same palette", () => {
  it("bills: paid→green classes, unpaid→amber classes (the ex-ternary, now centralized)", () => {
    expect(toneClasses(statusTone("paid"))).toBe("bg-green-100 text-green-700");
    expect(toneClasses(statusTone("unpaid"))).toBe("bg-amber-100 text-amber-800");
  });
});
