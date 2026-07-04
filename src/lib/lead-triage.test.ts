import { describe, it, expect } from "vitest";
import { classifyLead, DEFAULT_SITE_INSPECTION_THRESHOLD } from "@/lib/lead-triage";

const contact = { name: "Bob", email: "b@x.com", phone: "555", address: "1 Main" };

describe("classifyLead — buckets", () => {
  it("A: has engineered plans", () => {
    expect(classifyLead({ hasPlans: true, estimateTotal: 15000 }).bucket).toBe("A");
  });
  it("B: no plans but a sketch or dimensions", () => {
    expect(classifyLead({ hasPlans: false, hasSketch: true, estimateTotal: 12000 }).bucket).toBe("B");
    expect(classifyLead({ hasPlans: false, hasDimensions: true, estimateTotal: 12000 }).bucket).toBe("B");
  });
  it("C: needs design help, or unsure/combination, or nothing to go on", () => {
    expect(classifyLead({ needsDesignHelp: true, hasPlans: true }).bucket).toBe("C"); // help wins even over plans
    expect(classifyLead({ projectType: "unsure", hasPlans: true }).bucket).toBe("C");
    expect(classifyLead({ hasPlans: false, hasSketch: false, hasDimensions: false }).bucket).toBe("C");
  });
});

describe("classifyLead — the $20k gate", () => {
  it("over threshold → site inspection required, no instant price (even for a plan-ready lead)", () => {
    const t = classifyLead({ hasPlans: true, plansApproved: "yes", estimateTotal: 25000, contact });
    expect(t.siteInspectionRequired).toBe(true);
    expect(t.showInstantPrice).toBe(false);
  });
  it("exactly at the threshold is NOT over it", () => {
    expect(classifyLead({ hasPlans: true, estimateTotal: DEFAULT_SITE_INSPECTION_THRESHOLD }).siteInspectionRequired).toBe(false);
  });
  it("the threshold is tunable per-org", () => {
    expect(classifyLead({ hasPlans: true, estimateTotal: 8000 }, { inspectionThreshold: 5000 }).siteInspectionRequired).toBe(true);
  });
});

describe("classifyLead — instant price is earned", () => {
  it("shows for a ready lead (A/B) under threshold with a real number", () => {
    expect(classifyLead({ hasPlans: true, estimateTotal: 12000 }).showInstantPrice).toBe(true);
    expect(classifyLead({ hasSketch: true, estimateTotal: 9000 }).showInstantPrice).toBe(true);
  });
  it("never for a design-consult (C) lead", () => {
    expect(classifyLead({ needsDesignHelp: true, estimateTotal: 9000 }).showInstantPrice).toBe(false);
  });
  it("never when there's no configured estimate", () => {
    expect(classifyLead({ hasPlans: true, estimateTotal: 0 }).showInstantPrice).toBe(false);
  });
});

describe("classifyLead — priority ordering", () => {
  it("a big, plan-approved, reachable lead outranks a small vague one", () => {
    const hot = classifyLead({ hasPlans: true, plansApproved: "yes", estimateTotal: 35000, contact });
    const cold = classifyLead({ needsDesignHelp: true, estimateTotal: 2000, contact: {} });
    expect(hot.priority).toBeGreaterThan(cold.priority);
  });
  it("readiness breaks ties at the same job size", () => {
    const ready = classifyLead({ hasPlans: true, estimateTotal: 10000 });
    const consult = classifyLead({ needsDesignHelp: true, estimateTotal: 10000 });
    expect(ready.priority).toBeGreaterThan(consult.priority);
  });
});
