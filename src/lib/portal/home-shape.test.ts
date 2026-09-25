import { describe, it, expect } from "vitest";
import { portalHomeOrg, portalHomeRunning } from "./home-shape";

const JOB = "8760a051-b6f8-4a6b-b3a5-6ac7078f9ac1";

describe("the portal home (customer_portal, 0323)", () => {
  it("wears the org's own glass color, and a missing or bad one is left to the default (DD2)", () => {
    expect(portalHomeOrg({ name: "ET Electric", glass_tint: "#006D8F" }).tint).toBe("#006d8f");
    expect(portalHomeOrg({ name: "ET Electric" }).tint).toBeNull();
    expect(portalHomeOrg({ name: "ET Electric", glass_tint: "red; background:url(x)" }).tint).toBeNull();
    expect(portalHomeOrg(null)).toEqual({ name: "Your contractor", logoUrl: null, phone: null, email: null, license: null, tint: null });
  });

  it("the org header carries exactly what the page shows", () => {
    const withExtra = { name: "X", brand_color: "#000000" } as unknown as Parameters<typeof portalHomeOrg>[0];
    expect(Object.keys(portalHomeOrg(withExtra)).sort()).toEqual(["email", "license", "logoUrl", "name", "phone", "tint"]);
  });

  it("Andrew's running bill: 13897 Herringbone, $9,590.89 less $6,760 paid is $2,830.89 left", () => {
    expect(portalHomeRunning([{ job_id: JOB, job_name: "13897 Herringbone", job_number: "J-011", total: 9590.89, amount_paid: 6760 }])).toEqual([
      { jobId: JOB, name: "13897 Herringbone", number: "J-011", total: 9590.89, paid: 6760, balance: 2830.89 },
    ]);
  });

  it("paid ahead reads below zero, never floored; a row with no real job id is dropped", () => {
    expect(portalHomeRunning([{ job_id: JOB, job_name: "A", total: "100.10", amount_paid: "150" }])[0].balance).toBe(-49.9);
    expect(portalHomeRunning([{ job_id: "not-a-job", total: 1, amount_paid: 0 }, { job_id: null }])).toEqual([]);
    expect(portalHomeRunning(null)).toEqual([]);
  });
});
