import { describe, expect, it } from "vitest";
import { addressPrefillOnCustomerPick, jobLabel, jobSiteLabel, toNewJobCustomerOptions } from "./schedule-options";

/**
 * The codes-off job identity label (org setting timeclock_job_codes = false): the
 * timeclock identifies work by "customer · street address", never a fork per surface.
 */
describe("jobSiteLabel — the codes-off customer · address identity", () => {
  const job = { job_number: "J-0012", name: "Panel swap", address: "123 Main St", customer_name: "Smith" };

  it("leads with customer · street address", () => {
    expect(jobSiteLabel(job)).toBe("Smith · 123 Main St");
  });

  it("degrades to whichever half exists", () => {
    expect(jobSiteLabel({ ...job, address: null })).toBe("Smith");
    expect(jobSiteLabel({ ...job, customer_name: "" })).toBe("123 Main St");
    expect(jobSiteLabel({ ...job, customer_name: "  " })).toBe("123 Main St"); // whitespace ≠ a name
  });

  it("falls back to the number · name jobLabel when the job has neither part", () => {
    const bare = { job_number: "J-0012", name: "Panel swap" };
    expect(jobSiteLabel(bare)).toBe(jobLabel(bare));
    expect(jobSiteLabel({ ...bare, address: "", customer_name: null })).toBe("J-0012 · Panel swap");
  });
});

/**
 * The new-job customer→address prefill (bug 07-12: "customer choice doesn't apply
 * address to job"). Two pinned behaviors: the option mapper builds the canonical
 * one-line address, and the prefill decision NEVER clobbers typed input.
 */

describe("toNewJobCustomerOptions", () => {
  it("builds the canonical one-line address from the customer's parts", () => {
    expect(
      toNewJobCustomerOptions([
        { id: "c1", name: "Ann", address: "123 Main St", city: "Chilcoot", state: "CA", zip: "96105" },
      ]),
    ).toEqual([{ id: "c1", name: "Ann", address: "123 Main St, Chilcoot, CA 96105" }]);
  });

  it("drops empty parts and yields null when the customer has no address at all", () => {
    expect(
      toNewJobCustomerOptions([
        { id: "c1", name: "Ann", address: "123 Main St", city: null, state: "CA", zip: null },
        { id: "c2", name: "Bob", address: null, city: null, state: null, zip: null },
      ]),
    ).toEqual([
      { id: "c1", name: "Ann", address: "123 Main St, CA" },
      { id: "c2", name: "Bob", address: null },
    ]);
  });

  it("maps null/undefined rows to an empty list", () => {
    expect(toNewJobCustomerOptions(null)).toEqual([]);
    expect(toNewJobCustomerOptions(undefined)).toEqual([]);
  });
});

describe("addressPrefillOnCustomerPick", () => {
  const A = "123 Main St, Chilcoot, CA 96105";
  const B = "9 Pine Rd, Truckee, CA 96161";

  it("fills an empty field from the picked customer", () => {
    expect(addressPrefillOnCustomerPick("", "", A)).toBe(A);
  });

  it("leaves the field alone when the pick has no address and the field is empty", () => {
    expect(addressPrefillOnCustomerPick("", "", "")).toBeNull();
  });

  it("replaces the PREVIOUS pick's prefill when switching customers", () => {
    expect(addressPrefillOnCustomerPick(A, A, B)).toBe(B);
  });

  it("clears a stale prefill when the new pick has no address (never rides to the wrong customer)", () => {
    expect(addressPrefillOnCustomerPick(A, A, "")).toBe("");
  });

  it("never clobbers typed input", () => {
    expect(addressPrefillOnCustomerPick("456 Custom Ave", "", A)).toBeNull();
    // ...including a prefill the user then edited.
    expect(addressPrefillOnCustomerPick(A + " unit 2", A, B)).toBeNull();
  });

  it("no-ops when the pick's address already matches the field", () => {
    expect(addressPrefillOnCustomerPick(A, A, A)).toBeNull();
  });
});
