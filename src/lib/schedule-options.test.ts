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
  unitForName,
  unitStreetKeys,
  usualBillingKind,
  workWordsForName,
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
    expect(toNewJobCustomerOptions([{ id: "c3", name: "Pat Lee", company_name: "Alder Ridge HOA", type: "commercial" }])).toEqual([
      { id: "c3", name: "Pat Lee", address: null, company_name: "Alder Ridge HOA", type: "commercial" },
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

describe("defaultJobName — street number and name, as always (Erik 2026-09-28)", () => {
  const todayStr = "2026-09-27";
  it("with a street: the street number and name only, never the person or the town", () => {
    expect(defaultJobName({ customer: { name: "Rita Smith" }, street: "1871 Acacia Ct", todayStr })).toBe("1871 Acacia Ct");
    expect(defaultJobName({ customer: { name: "Bob & Mary Smith Jr." }, street: " 12  Pine St ", todayStr })).toBe("12 Pine St");
    expect(defaultJobName({ customer: { name: "Pat Lee", company_name: "Test Tavern HOA" }, street: "300 W Garnet Blvd", todayStr })).toBe("300 W Garnet Blvd");
    expect(defaultJobName({ customer: null, street: "12 Elm St, Testville, CA 96161", todayStr })).toBe("12 Elm St");
  });
  it("the street wins over a source's work words", () => {
    expect(defaultJobName({ customer: { name: "Rita Smith" }, street: "1871 Acacia Ct", work: "Panel Upgrade", todayStr })).toBe("1871 Acacia Ct");
  });
  it("a unit rides on the street as #<unit>, however it was typed, never twice", () => {
    for (const unit of ["56", "#56", "# 56", "Unit 56", "unit #56", "Apt 56", "Suite 56"]) {
      expect(defaultJobName({ customer: null, street: "300 West Garnet Boulevard", unit, todayStr }), unit).toBe("300 West Garnet Boulevard #56");
    }
    expect(defaultJobName({ customer: null, street: "300 West Garnet Boulevard #56", unit: "56", todayStr })).toBe("300 West Garnet Boulevard #56");
    expect(defaultJobName({ customer: null, street: "300 West Garnet Boulevard", unit: "  ", todayStr })).toBe("300 West Garnet Boulevard");
    // No street: a unit alone says nothing.
    expect(defaultJobName({ customer: { name: "Rita Smith" }, street: null, unit: "56", todayStr })).toBe("Rita Smith");
  });
  it("a street line that already spells the unit gets no second one", () => {
    for (const [street, unit] of [
      ["12 Elm St Apt 5", "Apt 5"],
      ["12 Elm St Apt 5", "5"],
      ["12 Elm St Unit 4", "Unit 4"],
      ["12 Elm St # 4", "4"],
      ["12 Elm St Apt. #4B", "4B"],
      ["12 Elm St Suite 200", "Suite 200"],
      ["12 Elm St Ste 200", "200"],
    ]) {
      expect(defaultJobName({ customer: null, street, unit, todayStr }), `${street} + ${unit}`).toBe(street);
    }
    // Only a designator before the same unit counts: "Apt 45" is not unit 5, and a number isn't one.
    expect(defaultJobName({ customer: null, street: "12 Elm St Apt 45", unit: "5", todayStr })).toBe("12 Elm St Apt 45 #5");
    expect(defaultJobName({ customer: null, street: "Crest 5", unit: "5", todayStr })).toBe("Crest 5 #5");
    // The New Job form's live line: a typed street with the unit in it, and the Unit box filled too.
    expect(defaultJobName({ customer: { name: "Rita Smith" }, street: "12 Elm St Apt 4", unit: "4", todayStr })).toBe("12 Elm St Apt 4");
  });
  it("a PO box is no street: who and the work instead", () => {
    for (const box of ["PO Box 123", "P.O. Box 123, Testville", "po box 9", "P O Box 44 Testville CA 96118", "Post Office Box 7"]) {
      expect(defaultJobName({ customer: { name: "Rita Smith" }, street: box, work: "Panel Upgrade", todayStr }), box).toBe("Rita Smith · Panel Upgrade");
    }
    expect(defaultJobName({ customer: null, street: "PO Box 123", todayStr })).toBe("New Job · Sep 27");
    // A street that merely starts with the letters stays a street.
    expect(defaultJobName({ customer: null, street: "Post Office Lane", todayStr })).toBe("Post Office Lane");
    expect(defaultJobName({ customer: null, street: "Poplar Boxwood Rd", todayStr })).toBe("Poplar Boxwood Rd");
    expect(defaultJobName({ customer: null, street: "12 Box Canyon Rd", todayStr })).toBe("12 Box Canyon Rd");
  });
  it("no street: who as written, the whole name or the company, then the work words", () => {
    expect(defaultJobName({ customer: { name: "Marla Test" }, street: "", todayStr })).toBe("Marla Test");
    expect(defaultJobName({ customer: { name: "Bob Moss Jr." }, street: null, todayStr })).toBe("Bob Moss Jr.");
    expect(defaultJobName({ customer: { name: "Truckee Lumber Co", type: "commercial" }, street: null, todayStr })).toBe("Truckee Lumber Co");
    expect(defaultJobName({ customer: { name: "Pat Lee", company_name: "Test Tavern HOA" }, street: null, todayStr })).toBe("Test Tavern HOA");
    expect(defaultJobName({ customer: { name: "Marla Test" }, street: null, work: "Panel Upgrade", todayStr })).toBe("Marla Test · Panel Upgrade");
    expect(defaultJobName({ customer: { name: "Marla Test" }, street: null, work: "  ", todayStr })).toBe("Marla Test");
  });
  it("neither: New Job on the company's day (the work words alone when that is all there is)", () => {
    expect(defaultJobName({ customer: null, street: null, todayStr })).toBe("New Job · Sep 27");
    expect(defaultJobName({ customer: { name: "  " }, street: " ", todayStr: "2027-01-02" })).toBe("New Job · Jan 2");
    expect(defaultJobName({ customer: null, street: null, work: "Kitchen rewire", todayStr })).toBe("Kitchen rewire");
  });
  it("customerNamePart: the company, else the whole name as written", () => {
    expect(customerNamePart({ name: "Cher" })).toBe("Cher");
    expect(customerNamePart({ name: " Rita   Smith ", type: "residential" })).toBe("Rita Smith");
    expect(customerNamePart({ name: "Pat Lee", company_name: "Test HOA" })).toBe("Test HOA");
    expect(customerNamePart(null)).toBe("");
  });
  it("unitForName and workWordsForName", () => {
    expect(unitForName("Apt. B")).toBe("B");
    expect(unitForName("Bldg C")).toBe("Bldg C");
    expect(unitForName(null)).toBe("");
    expect(workWordsForName("Panel Upgrade")).toBe("Panel Upgrade");
    const long = "Replace the panel, add two circuits, move the meter and patch the drywall";
    const cut = workWordsForName(long);
    expect(cut).toBe("Replace the panel, add two circuits");
    expect(cut.length).toBeLessThanOrEqual(40);
    expect(workWordsForName("Replace the panel, add two circuits, mov and more")).toBe("Replace the panel, add two circuits, mov");
    expect(workWordsForName("x".repeat(60))).toBe("x".repeat(40));
    // Counted in characters: an emoji is one, and is never cut in half.
    expect(workWordsForName("Replace kitchen lights and add dimmers 💡")).toBe("Replace kitchen lights and add dimmers 💡");
    const run = workWordsForName(`${"a".repeat(39)}🔌more`);
    expect(run).toBe(`${"a".repeat(39)}🔌`);
    expect(workWordsForName("💡".repeat(50))).toBe("💡".repeat(40));
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
    { address: "300 W. Garnet Blvd", unit: "224" },
    { address: "300 W Garnet Blvd", unit: "12" },
    { address: "9 Pine Rd", unit: null },
    { address: null, unit: "3" },
  ]);
  it("reads the streets that carry a unit, once each, whatever the spelling", () => {
    expect(keys).toEqual(["300 w garnet blvd"]);
    expect(streetKey("300  W. Garnet Blvd,")).toBe("300 w garnet blvd");
  });
  it("a matching street suggests More Options; others don't", () => {
    expect(streetHasUnits("300 w garnet blvd", keys)).toBe(true);
    expect(streetHasUnits("9 Pine Rd", keys)).toBe(false);
    expect(streetHasUnits("", keys)).toBe(false);
  });
});
