import { describe, it, expect } from "vitest";
import { addressHasCityStateZipTail, pickSite, siteLines, siteIsIncomplete } from "./site-address";

/**
 * THE STRINGS THAT KILLED THE PARSER. Every "must return false" here is a case where a naive
 * splitter wrote a FALSE city or state against real Truckee-area data. The boolean is allowed to
 * exist only because it writes nothing — these tests are what keeps it that way.
 */
describe("addressHasCityStateZipTail — display only, and it must under-claim", () => {
  it.each([
    ["1871 Apache Ct Olympic Valley CA 96146 United States", true],
    ["13897 Herringbone Way Truckee  CA 96161", true],
    ["300 W Lake Blvd, Tahoe City, CA 96145, USA", true],
    ["94248 CA-70, Chilcoot, CA 96105, USA", true],
    ["1 Main St, Reno, NV 89501-1234", true],
  ])("%s → %s", (s, want) => expect(addressHasCityStateZipTail(s)).toBe(want));

  it("a street that IS a state word must never read as a state", () => {
    // The single rule that killed 8 of 8 confirmed fabrications.
    expect(addressHasCityStateZipTail("1420 Nevada St Truckee")).toBe(false);
    expect(addressHasCityStateZipTail("55 Washington Ave")).toBe(false);
  });

  it("a directional is not Nebraska", () => {
    expect(addressHasCityStateZipTail("1200 Industrial Way NE 68001")).toBe(false);
    expect(addressHasCityStateZipTail("40 Riverside Dr SW 30301")).toBe(false);
  });

  it("a bare 5-digit run with no state before it is not an address tail", () => {
    expect(addressHasCityStateZipTail("PO Box 12345")).toBe(false);
    expect(addressHasCityStateZipTail("10410 Badger Lane unit 96146")).toBe(false);
    expect(addressHasCityStateZipTail("Lot 42 Prosser Lakeview 96161")).toBe(false);
  });

  it("refuses Canadian postcodes EXPLICITLY, not by luck", () => {
    expect(addressHasCityStateZipTail("120 Bloor St E, Toronto, ON M4W 1B7")).toBe(false);
  });

  it("no tail, empty and junk are all false", () => {
    expect(addressHasCityStateZipTail("10410 Badger Lane")).toBe(false);
    expect(addressHasCityStateZipTail("")).toBe(false);
    expect(addressHasCityStateZipTail(null)).toBe(false);
  });
});

describe("pickSite — most specific first, whole records only", () => {
  const job = { source: "job", parts: { address: "10410 Badger Lane", city: "Truckee", state: "CA", zip: "96161" } };
  const cust = { source: "customer", parts: { address: "1 Elsewhere Rd", city: "Reno", state: "NV", zip: "89501" } };

  it("the first candidate with an address wins", () => {
    expect(pickSite([job, cust])?.source).toBe("job");
  });

  it("falls through a record with no address", () => {
    expect(pickSite([{ source: "quote", parts: null }, { source: "job", parts: {} }, cust])?.source).toBe("customer");
  });

  it("NEVER merges fields across records — the address that exists in no town", () => {
    // A per-field coalesce would give "1871 Apache Ct" + "Reno". This must not happen.
    const partial = { source: "job", parts: { address: "1871 Apache Ct" } };
    const got = pickSite([partial, cust]);
    expect(got?.address).toBe("1871 Apache Ct");
    expect(got?.city).toBeNull();
    expect(got?.state).toBeNull();
  });

  it("a blob carrying its own tail counts as COMPLETE even with empty parts columns", () => {
    // Jason Waldow's live row. It prints fine today; flagging it as a gap would be a false alarm.
    const blob = { source: "customer", parts: { address: "1871 Apache Ct Olympic Valley CA 96146 United States" } };
    expect(pickSite([blob])?.complete).toBe(true);
    expect(siteIsIncomplete(pickSite([blob]))).toBe(false);
  });

  it("a street with no city anywhere is INCOMPLETE and says so", () => {
    const thin = { source: "job", parts: { address: "13631 Northwoods" } };
    expect(pickSite([thin])?.complete).toBe(false);
    expect(siteIsIncomplete(pickSite([thin]))).toBe(true);
  });

  it("nothing anywhere is null, not an empty shell", () => {
    expect(pickSite([{ source: "job", parts: {} }])).toBeNull();
    expect(pickSite([])).toBeNull();
  });
});

describe("siteLines — never prints the city twice", () => {
  it("splits parts onto a second line", () => {
    expect(siteLines(pickSite([{ source: "job", parts: { address: "10410 Badger Lane", city: "Truckee", state: "CA", zip: "96161" } }])))
      .toEqual(["10410 Badger Lane", "Truckee, CA 96161"]);
  });

  it("suppresses the second line when the blob already carries the tail", () => {
    // Erik's OWN customer row: address ends in "Chilcoot, CA 96105, USA" AND city = "Chilcoot-Vinton".
    // Today that prints the town twice on every document.
    expect(siteLines(pickSite([{ source: "customer", parts: { address: "94248 CA-70, Chilcoot, CA 96105, USA", city: "Chilcoot-Vinton", state: "CA", zip: "96105" } }])))
      .toEqual(["94248 CA-70, Chilcoot, CA 96105, USA"]);
  });

  it("a street with no parts is one line, not a line and a blank", () => {
    expect(siteLines(pickSite([{ source: "job", parts: { address: "13631 Northwoods" } }]))).toEqual(["13631 Northwoods"]);
  });

  it("no site is no lines", () => {
    expect(siteLines(null)).toEqual([]);
  });
});

/**
 * THE UNIT. Four Tahoe Tavern jobs at 300 W Lake Blvd, the number living only in the job NAME
 * ("TTP #11", "#56", "#224") — so every document named the building and not the dwelling, on two
 * already-paid invoices. Erik: "yes for unit field for TTP, that is key for us and them."
 */
describe("the unit — its own line, never appended to a blob", () => {
  it("prints under the street, ABOVE the city line", () => {
    expect(siteLines(pickSite([{ source: "job", parts: { address: "300 W Lake Blvd", unit: "224", city: "Tahoe City", state: "CA", zip: "96145" } }])))
      .toEqual(["300 W Lake Blvd", "Unit 224", "Tahoe City, CA 96145"]);
  });

  it("NEVER lands after the ZIP on a blob address — the failure the own-line rule exists to stop", () => {
    const lines = siteLines(pickSite([{ source: "job", parts: { address: "300 W Lake Blvd, Tahoe City, CA 96145, USA", unit: "11" } }]));
    expect(lines).toEqual(["300 W Lake Blvd, Tahoe City, CA 96145, USA", "Unit 11"]);
    expect(lines[lines.length - 1]).toBe("Unit 11");
  });

  it("does not re-label a unit a human already labelled", () => {
    expect(siteLines(pickSite([{ source: "job", parts: { address: "1 Main St", unit: "#224" } }]))[1]).toBe("#224");
    expect(siteLines(pickSite([{ source: "job", parts: { address: "1 Main St", unit: "Apt B" } }]))[1]).toBe("Apt B");
    expect(siteLines(pickSite([{ source: "job", parts: { address: "1 Main St", unit: "Suite 200" } }]))[1]).toBe("Suite 200");
  });

  it("no unit is no line at all, not a blank one", () => {
    expect(siteLines(pickSite([{ source: "job", parts: { address: "1 Main St", unit: "  " } }]))).toEqual(["1 Main St"]);
  });

  it("a unit never travels without its own record's street", () => {
    // All-or-nothing: the job wins whole, so the customer's unit must not ride along.
    const got = pickSite([
      { source: "job", parts: { address: "300 W Lake Blvd" } },
      { source: "customer", parts: { address: "1 Elsewhere", unit: "99", city: "Reno" } },
    ]);
    expect(got?.unit).toBeNull();
  });

  it("survives the literal nulls public_quote actually returns", () => {
    // json_build_array puts a bare null where a sub-select matched nothing — verified live.
    const got = pickSite([null as never, { source: "job", parts: { address: "300 W Lake Blvd", unit: "56" } }, null as never]);
    expect(got?.unit).toBe("56");
  });
});
