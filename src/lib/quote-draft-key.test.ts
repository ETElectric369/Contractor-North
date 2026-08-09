import { describe, it, expect } from "vitest";
import { quoteDraftKey } from "./quote-draft-key";

/** THE COLLISION THIS FILE EXISTS FOR: two walk-throughs, no job, no customer, no lead. */
describe("quoteDraftKey — two inspections must never share a slot", () => {
  const moraine = { captureId: "266f0778", jobId: null, customerId: null, inquiryId: null };
  const cain = { captureId: "4314d903", jobId: null, customerId: null, inquiryId: null };

  it("keeps two customer-less, job-less inspections apart", () => {
    expect(quoteDraftKey(moraine)).not.toBe(quoteDraftKey(cain));
  });

  it("neither of them lands in the shared 'new' slot", () => {
    expect(quoteDraftKey(moraine)).not.toContain(":new");
    expect(quoteDraftKey(cain)).not.toContain(":new");
  });

  it("the appointment outranks the others — one job can hold several walk-throughs", () => {
    const a = quoteDraftKey({ captureId: "appt-1", jobId: "job-9" });
    const b = quoteDraftKey({ captureId: "appt-2", jobId: "job-9" });
    expect(a).not.toBe(b);
  });

  it("falls through job → customer → lead when there is no walk-through", () => {
    expect(quoteDraftKey({ jobId: "j1", customerId: "c1" })).toContain("j1");
    expect(quoteDraftKey({ customerId: "c1", inquiryId: "i1" })).toContain("c1");
    expect(quoteDraftKey({ inquiryId: "i1" })).toContain("i1");
  });

  it("a genuinely blank estimate still gets the shared slot, and only it", () => {
    expect(quoteDraftKey({})).toBe("quote-builder:v2:new");
  });

  it("the version prefix evicts pre-fix drafts", () => {
    expect(quoteDraftKey({ jobId: "j1" }).startsWith("quote-builder:v2:")).toBe(true);
  });
});
