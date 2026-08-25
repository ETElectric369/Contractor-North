import { describe, it, expect } from "vitest";
import { carryFromCustomer, matchKnownCustomer, type KnownCustomer } from "./known-customer";

const cust = (over: Partial<KnownCustomer> = {}): KnownCustomer => ({
  id: "c1",
  name: "Jackie Burks",
  phone: "(530) 555-0142",
  email: "jackie@example.com",
  address: "1180 Bear Run",
  city: "Truckee",
  state: "CA",
  zip: "96161",
  ...over,
});

describe("matchKnownCustomer — does the app already know this person?", () => {
  it("matches the way a person reads a name, not the way a database does", () => {
    const m = matchKnownCustomer("  jackie   BURKS ", [cust()]);
    expect(m.kind).toBe("one");
  });

  it("says nothing when there is no match", () => {
    expect(matchKnownCustomer("Braden Lang", [cust()]).kind).toBe("none");
  });

  it("REFUSES TO GUESS between two people with the same name", () => {
    // Production has two "Chris Taylor" rows. Attaching a lead to the wrong person's history is
    // far more expensive than not attaching it at all.
    const m = matchKnownCustomer("Chris Taylor", [
      cust({ id: "a", name: "Chris Taylor" }),
      cust({ id: "b", name: "chris taylor" }),
    ]);
    expect(m).toEqual({ kind: "ambiguous", count: 2 });
  });

  it("an empty name matches nothing — a bare phone lead stays unlinked", () => {
    expect(matchKnownCustomer("   ", [cust()]).kind).toBe("none");
  });
});

describe("carryFromCustomer — fill the blanks, never overwrite", () => {
  it("brings across what the lead is missing", () => {
    // Erik's real case: he typed a name and got a lead he could not call, while the phone sat
    // one table away.
    const c = carryFromCustomer({ phone: null, email: null }, cust());
    expect(c.patch.phone).toBe("(530) 555-0142");
    expect(c.patch.email).toBe("jackie@example.com");
    expect(c.note).toContain("Linked to Jackie Burks");
    expect(c.note).toContain("phone");
  });

  it("WHAT HE TYPED WINS — a different phone is him correcting the record", () => {
    const c = carryFromCustomer({ phone: "(530) 555-9999" }, cust());
    expect(c.patch.phone).toBeUndefined();
  });

  it("address is ALL-OR-NOTHING — never a customer's street under a typed city", () => {
    // A street from one place under a city from another is a plausible address that does not
    // exist. Same rule pickSite applies everywhere else.
    const c = carryFromCustomer({ city: "Graeagle" }, cust());
    expect(c.patch.address).toBeUndefined();
    expect(c.patch.state).toBeUndefined();
    expect(c.patch.zip).toBeUndefined();
    // …but non-place fields still carry.
    expect(c.patch.phone).toBe("(530) 555-0142");
  });

  it("carries the whole place when the lead named none of it", () => {
    const c = carryFromCustomer({}, cust());
    expect(c.patch).toMatchObject({ address: "1180 Bear Run", city: "Truckee", state: "CA", zip: "96161" });
  });

  it("says nothing when there was nothing to bring", () => {
    const c = carryFromCustomer({ phone: "x", email: "y" }, cust({ address: null, city: null, state: null, zip: null, company_name: null }));
    expect(c.patch).toEqual({});
    expect(c.note).toBe("");
  });

  it("blank strings count as empty, not as an answer", () => {
    const c = carryFromCustomer({ phone: "   " }, cust());
    expect(c.patch.phone).toBe("(530) 555-0142");
  });

  it("the sentence reads like English for one, two and three fields", () => {
    const one = carryFromCustomer({ email: "e", address: "a" }, cust({ company_name: null }));
    expect(one.note).toMatch(/brought their phone across\.$/);
    const two = carryFromCustomer({ address: "a" }, cust({ company_name: null }));
    expect(two.note).toMatch(/phone and email across\.$/);
  });
});
