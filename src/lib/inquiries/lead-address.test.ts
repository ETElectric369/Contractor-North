import { describe, it, expect } from "vitest";
import { splitLeadAddress, customerAddressFrom } from "./lead-address";

/**
 * The rule that keeps a customer's home address off a contractor's estimate as the job site.
 *
 * Every "unchanged" assertion here is a backward-compatibility guarantee: 34 leads exist with a
 * null `contact_address`, and three of the four capture doors still only ask once. If those stop
 * behaving exactly as they did, the migration was not additive after all.
 */

describe("splitLeadAddress — the write side", () => {
  const home = { address: "1871 Apache Ct", city: "Olympic Valley", state: "CA", zip: "96146" };

  it("no site given → the site IS the home address, exactly as this door worked before 0189", () => {
    const { site, contact } = splitLeadAddress({ contact: home, site: null });
    expect(site).toEqual(home);
    expect(contact).toEqual(home);
  });

  it("a site given → the two are kept apart", () => {
    const lot = { address: "300 W Lake Blvd", city: "Tahoe City", state: "CA", zip: "96145" };
    const { site, contact } = splitLeadAddress({ contact: home, site: lot });
    expect(site).toEqual(lot);
    expect(contact).toEqual(home);
  });

  it("a site with a city but NO street is not a site — a job located in a town and nowhere else", () => {
    const { site } = splitLeadAddress({ contact: home, site: { address: "  ", city: "Truckee" } });
    expect(site).toEqual(home);
    expect(site.city).toBe("Olympic Valley"); // never the orphan city
  });

  it("never merges the two — the address that exists on no record", () => {
    // The failure lib/site-address.ts' pickSite was built to refuse, in the other direction.
    const { site } = splitLeadAddress({ contact: home, site: { address: "300 W Lake Blvd" } });
    expect(site).toEqual({ address: "300 W Lake Blvd", city: null, state: null, zip: null });
  });

  it("trims, caps, and turns blank into null rather than empty string", () => {
    const { contact } = splitLeadAddress({ contact: { address: "  x  ", city: "   ", state: "", zip: undefined } });
    expect(contact).toEqual({ address: "x", city: null, state: null, zip: null });
    expect(splitLeadAddress({ contact: { address: "y".repeat(400) } }).contact.address).toHaveLength(300);
  });

  it("an empty payload does not throw", () => {
    expect(splitLeadAddress({ contact: {} })).toEqual({
      site: { address: null, city: null, state: null, zip: null },
      contact: { address: null, city: null, state: null, zip: null },
    });
  });
});

describe("customerAddressFrom — the read side at conversion", () => {
  it("a pre-0189 lead gives the customer exactly what it always did", () => {
    const old = { address: "5659 Rhodesia Rd", city: "Carnelian Bay", state: "CA", zip: "96140" };
    expect(customerAddressFrom(old)).toEqual(old);
  });

  it("a two-address lead gives the customer the PERSON's address, not the site", () => {
    const got = customerAddressFrom({
      address: "300 W Lake Blvd", city: "Tahoe City", state: "CA", zip: "96145",
      contact_address: "1871 Apache Ct", contact_city: "Olympic Valley", contact_state: "CA", contact_zip: "96146",
    });
    expect(got).toEqual({ address: "1871 Apache Ct", city: "Olympic Valley", state: "CA", zip: "96146" });
    expect(got.city).not.toBe("Tahoe City"); // J-018's real mismatch, the other way round
  });

  it("all-or-nothing: a contact street with no parts does NOT borrow the site's city", () => {
    const got = customerAddressFrom({
      address: "300 W Lake Blvd", city: "Tahoe City", state: "CA", zip: "96145",
      contact_address: "1871 Apache Ct",
    });
    expect(got).toEqual({ address: "1871 Apache Ct", city: null, state: null, zip: null });
  });

  it("a lead with no address at all is nulls, not undefined", () => {
    expect(customerAddressFrom({})).toEqual({ address: null, city: null, state: null, zip: null });
  });
});

describe("the round trip — what the door writes is what the conversion reads", () => {
  it("one address in, one address out, on both records", () => {
    const { site, contact } = splitLeadAddress({ contact: { address: "10410 Badger Lane", city: "Truckee", state: "CA", zip: "96161" } });
    const row = { ...site, contact_address: contact.address, contact_city: contact.city, contact_state: contact.state, contact_zip: contact.zip };
    expect(customerAddressFrom(row)).toEqual(contact);
    expect(row.address).toBe("10410 Badger Lane"); // the site, i.e. what the job gets
  });

  it("two addresses in, the job keeps the lot and the customer keeps the house", () => {
    const { site, contact } = splitLeadAddress({
      contact: { address: "1871 Apache Ct", city: "Olympic Valley", state: "CA", zip: "96146" },
      site: { address: "Lot 42 Prosser Lakeview", city: "Truckee", state: "CA", zip: "96161" },
    });
    const row = { ...site, contact_address: contact.address, contact_city: contact.city, contact_state: contact.state, contact_zip: contact.zip };
    expect(row.address).toBe("Lot 42 Prosser Lakeview");
    expect(customerAddressFrom(row).address).toBe("1871 Apache Ct");
  });
});
