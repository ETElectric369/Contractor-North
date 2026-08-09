import { describe, it, expect } from "vitest";
import { quoteDraftKey, quoteDraftLegacyKeys } from "./quote-draft-key";

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

/**
 * THE RECOVERY. cn-v680's "v2:" prefix orphaned every pre-fix draft, and an unsaved hand-built
 * Moraine Rd estimate was in the slot it orphaned. A key rename must carry its own way back.
 */
describe("quoteDraftLegacyKeys — a rename must not strand unsaved work", () => {
  it("looks in the shared 'new' slot for a walk-through estimate — where the lost work is", () => {
    const keys = quoteDraftLegacyKeys({ captureId: "266f0778", jobId: null, customerId: null, inquiryId: null });
    expect(keys).toContain("quote-builder:new");
  });

  it("looks under the old scheme for a job-sourced estimate", () => {
    expect(quoteDraftLegacyKeys({ jobId: "j1" })).toContain("quote-builder:j1");
  });

  it("a capture-sourced estimate that ALSO had a job checks both old homes", () => {
    const keys = quoteDraftLegacyKeys({ captureId: "a1", jobId: "j1" });
    expect(keys).toEqual(["quote-builder:j1", "quote-builder:new"]);
  });

  it("never returns the current key — that would make the fallback a no-op loop", () => {
    const ids = { captureId: "a1", jobId: null, customerId: null, inquiryId: null };
    expect(quoteDraftLegacyKeys(ids)).not.toContain(quoteDraftKey(ids));
  });
});
