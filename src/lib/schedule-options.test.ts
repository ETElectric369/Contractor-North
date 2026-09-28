import { describe, expect, it } from "vitest";
import {
  addressPrefillOnCustomerPick,
  customerNamePart,
  defaultJobName,
  jobLabel,
  jobSiteLabel,
  statusFromDate,
  streetHasUnits,
  streetKey,
  toNewJobCustomerOptions,
  unitStreetKeys,
  usualBillingKind,
} from "./schedule-options";

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

  it("falls back to jobLabel when the job has neither part", () => {
    const bare = { job_number: "J-0012", name: "Panel swap" };
    expect(jobSiteLabel(bare)).toBe(jobLabel(bare));
    // jobLabel now leads with the NAME (cn-v590) — both owners navigate by address, and the
    // number ate the width the address needed. jobSiteLabel still agrees with it on a bare job.
    expect(jobSiteLabel({ ...bare, address: "", customer_name: null })).toBe("Panel swap");
    // The number is the LAST resort — an unnamed job still has to label itself somehow.
    expect(jobSiteLabel({ job_number: "J-0012", name: null, address: "", customer_name: null })).toBe("J-0012");
  });
});

/**
 * The new-job customer→address prefill (bug 07-12: "customer choice doesn't apply
 * address to job"). Two pinned behaviors: the option mapper builds the canonical
 * one-line address, and the prefill decision NEVER clobbers typed input.
 */

describe("toNewJobCustomerOptions", () => {
  it("builds the canonical one-line address from the customer's parts, and keeps the parts (W1-22)", () => {
    expect(
      toNewJobCustomerOptions([
        { id: "c1", name: "Ann", address: "123 Main St", city: "Chilcoot", state: "CA", zip: "96105" },
      ]),
    ).toEqual([
      { id: "c1", name: "Ann", address: "123 Main St, Chilcoot, CA 96105", street: "123 Main St", city: "Chilcoot", state: "CA", zip: "96105" },
    ]);
  });

  it("drops empty parts and yields null when the customer has no address at all", () => {
    expect(
      toNewJobCustomerOptions([
        { id: "c1", name: "Ann", address: "123 Main St", city: null, state: "CA", zip: null },
        { id: "c2", name: "Bob", address: null, city: null, state: null, zip: null },
      ]),
    ).toEqual([
      { id: "c1", name: "Ann", address: "123 Main St, CA", street: "123 Main St", city: null, state: "CA", zip: null },
      { id: "c2", name: "Bob", address: null, street: null, city: null, state: null, zip: null },
    ]);
  });

  it("carries the company name and the kind when the query read them (the It'll Be Called line)", () => {
    expect(toNewJobCustomerOptions([{ id: "c3", name: "Pat Lee", company_name: "Tahoe Tavern HOA", type: "commercial" }])).toEqual([
      { id: "c3", name: "Pat Lee", address: null, company_name: "Tahoe Tavern HOA", type: "commercial" },
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

/**
 * NEW JOB IN FOUR FIELDS (W1-22): what the server works out when the form doesn't ask, from the
 * company's today (never the server's UTC day, never the phone's).
 */
describe("statusFromDate", () => {
  const today = "2026-09-27";
  it("today or earlier is In Progress, a later day Scheduled, no day To Be Scheduled", () => {
    expect(statusFromDate(today, today)).toBe("in_progress");
    expect(statusFromDate("2026-09-20", today)).toBe("in_progress");
    expect(statusFromDate("2026-09-28", today)).toBe("scheduled");
    expect(statusFromDate("", today)).toBe("to_be_scheduled");
    expect(statusFromDate(null, today)).toBe("to_be_scheduled");
    expect(statusFromDate("not a day", today)).toBe("to_be_scheduled");
  });
});

describe("defaultJobName — the person and the place, the number second", () => {
  const todayStr = "2026-09-27";
  it("a person's last name · the street line", () => {
    expect(defaultJobName({ customer: { name: "Rita Smith" }, street: "1871 Apache Ct", todayStr })).toBe("Smith · 1871 Apache Ct");
    expect(defaultJobName({ customer: { name: "Bob & Mary Smith Jr." }, street: " 12  Pine St ", todayStr })).toBe("Smith · 12 Pine St");
  });
  it("a business by its own name", () => {
    expect(defaultJobName({ customer: { name: "Pat Lee", company_name: "Tahoe Tavern HOA" }, street: "300 W Lake Blvd", todayStr })).toBe(
      "Tahoe Tavern HOA · 300 W Lake Blvd",
    );
    expect(defaultJobName({ customer: { name: "Truckee Lumber Co", type: "commercial" }, street: null, todayStr })).toBe("Truckee Lumber Co");
  });
  it("either half alone, and with neither, New Job on the company's day", () => {
    expect(defaultJobName({ customer: null, street: "1871 Apache Ct", todayStr })).toBe("1871 Apache Ct");
    expect(defaultJobName({ customer: { name: "Rita Smith" }, street: "", todayStr })).toBe("Smith");
    expect(defaultJobName({ customer: null, street: null, todayStr })).toBe("New Job · Sep 27");
    expect(defaultJobName({ customer: { name: "  " }, street: " ", todayStr: "2027-01-02" })).toBe("New Job · Jan 2");
  });
  it("customerNamePart: a one-word name is the name", () => {
    expect(customerNamePart({ name: "Cher" })).toBe("Cher");
    expect(customerNamePart(null)).toBe("");
  });
});

describe("usualBillingKind — the kind most of this company's jobs use", () => {
  it("the majority wins; Time & Material on a tie or with none", () => {
    expect(usualBillingKind({ tm: 3, fixed: 9 })).toBe("fixed");
    expect(usualBillingKind({ tm: 9, fixed: 3 })).toBe("tm");
    expect(usualBillingKind({ tm: 4, fixed: 4 })).toBe("tm");
    expect(usualBillingKind({})).toBe("tm");
  });
});

describe("the unit hint: another job at this street has a unit", () => {
  const keys = unitStreetKeys([
    { address: "300 W. Lake Blvd", unit: "224" },
    { address: "300 W Lake Blvd", unit: "12" },
    { address: "9 Pine Rd", unit: null },
    { address: null, unit: "3" },
  ]);
  it("reads the streets that carry a unit, once each, whatever the spelling", () => {
    expect(keys).toEqual(["300 w lake blvd"]);
    expect(streetKey("300  W. Lake Blvd,")).toBe("300 w lake blvd");
  });
  it("a matching street suggests More Options; others don't", () => {
    expect(streetHasUnits("300 w lake blvd", keys)).toBe(true);
    expect(streetHasUnits("9 Pine Rd", keys)).toBe(false);
    expect(streetHasUnits("", keys)).toBe(false);
  });
});
