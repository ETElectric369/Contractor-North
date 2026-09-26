import { describe, it, expect } from "vitest";
import { docFileName, docPageTitle, docPlace, placeSlug, projectionPlace, rowPlace, withPlace } from "./doc-place";
import { contentDisposition } from "./content-disposition";
import { getOrgSettings, orgDocUrl } from "./org-settings";

describe("docPlace — the street number and name, without the street label", () => {
  it("Erik's two examples", () => {
    expect(docPlace("235 Timbercreek Court")).toBe("235 Timbercreek");
    expect(docPlace("3245 West Lake Boulevard")).toBe("3245 West Lake");
  });

  it("drops a trailing type word, full or abbreviated, with or without a dot", () => {
    const cases: [string, string][] = [
      ["235 Timbercreek Ct", "235 Timbercreek"],
      ["10816 West River Street", "10816 West River"],
      ["10244 Schaffer Dr", "10244 Schaffer"],
      ["12633 Prosser Dam Road", "12633 Prosser Dam"],
      ["5659 Rhodesia Rd", "5659 Rhodesia"],
      ["14161 Tanager Lane", "14161 Tanager"],
      ["1370 Sequoia Avenue", "1370 Sequoia"],
      ["300 W Lake Blvd", "300 W Lake"],
      ["3245 W. Lake Blvd.", "3245 W. Lake"],
      ["13897 Herringbone Way", "13897 Herringbone"],
      ["1386 Mineral Springs Trail", "1386 Mineral Springs"],
      ["12 Aspen Cir", "12 Aspen"],
      ["85 Whitney Pl", "85 Whitney"],
      ["40 Donner Pass Hwy", "40 Donner Pass"],
      ["9 Northstar Loop", "9 Northstar"],
      ["2772 Lake Terrace Avenue", "2772 Lake Terrace"],
    ];
    for (const [input, place] of cases) expect(docPlace(input), input).toBe(place);
  });

  it("leaves a street with no type word alone", () => {
    expect(docPlace("11301 Purple Sage")).toBe("11301 Purple Sage");
    expect(docPlace("94248 California 70")).toBe("94248 California 70");
    expect(docPlace("94248 CA-70, Chilcoot, CA 96105, USA")).toBe("94248 CA-70");
  });

  it("never cuts down to the bare house number", () => {
    expect(docPlace("94248 Highway 70")).toBe("94248 Highway 70");
    expect(docPlace("100 Loop")).toBe("100 Loop");
  });

  it("takes the first line only: the city, state and zip never ride along", () => {
    expect(docPlace("235 Timbercreek Ct, Reno, NV 89511, USA")).toBe("235 Timbercreek");
    expect(docPlace("1860 Tahoe Park Heights Dr, Tahoe City, CA 96145, USA")).toBe("1860 Tahoe Park Heights");
    // The comma-less blobs on file: the town follows the street label.
    expect(docPlace("13897 Herringbone Way Truckee  CA 96161")).toBe("13897 Herringbone");
    expect(docPlace("1871 Apache Ct Olympic Valley CA 96146 United States")).toBe("1871 Apache");
    expect(docPlace("300 W Lake Blvd\nTahoe City")).toBe("300 W Lake");
    // No street label and a ZIP: the town can't be found, so no place rather than the town.
    expect(docPlace("123 Main Truckee CA 96161")).toBe("");
    expect(docPlace("PO Box 44 Loyalton CA 96118")).toBe("");
    expect(docPlace("12 Eagle Ridge Truckee CA 96161")).toBe("");
    // A route number is the street's name: it stays, the town goes.
    expect(docPlace("94248 Highway 70 Portola CA 96122")).toBe("94248 Highway 70");
    expect(docPlace("12 Old Hwy 40 Truckee CA")).toBe("12 Old Hwy 40");
  });

  it("a street that only looks like a unit is still the street", () => {
    expect(docPlace("123 Ste Marie Rd")).toBe("123 Ste Marie");
    expect(docPlace("100 Outer Space Way")).toBe("100 Outer Space");
    expect(docPlace("123 Apt 4")).toBe("123 Apt 4");
  });

  it("drops a unit suffix", () => {
    expect(docPlace("300 W Lake Blvd #11")).toBe("300 W Lake");
    expect(docPlace("300 W Lake Blvd Apt 2")).toBe("300 W Lake");
    expect(docPlace("300 W Lake Blvd Unit B, Tahoe City")).toBe("300 W Lake");
    expect(docPlace("12 Main St Suite 100")).toBe("12 Main");
    expect(docPlace("12 Main St Ste. 5")).toBe("12 Main");
    expect(docPlace("12 Main #4")).toBe("12 Main");
    expect(docPlace("12 Main St Apt 2B")).toBe("12 Main");
  });

  it("falls back in order, and is empty with no address at all", () => {
    expect(docPlace(null, "", "  ", "235 Timbercreek Ct")).toBe("235 Timbercreek");
    expect(docPlace("13897 Herringbone Way", "235 Timbercreek Ct")).toBe("13897 Herringbone");
    expect(docPlace()).toBe("");
    expect(docPlace(null, undefined, "")).toBe("");
  });

  it("rowPlace: the quote's own site, the job's, the lead's, then the customer's; never the name", () => {
    const customers = { name: "Tao Zhu", address: "235 Timbercreek Ct" };
    expect(rowPlace({ jobs: { address: "235 Timbercreek Court" }, customers })).toBe("235 Timbercreek");
    expect(rowPlace({ jobs: null, customers })).toBe("235 Timbercreek");
    expect(rowPlace({ jobs: [{ address: "3245 West Lake Boulevard" }], customers: [customers] })).toBe("3245 West Lake");
    expect(rowPlace({ address: "13897 Herringbone Way", jobs: { address: "1 Other St" } })).toBe("13897 Herringbone");
    expect(rowPlace({ inquiry: { address: "600 White Fir Court" }, customers })).toBe("600 White Fir");
    const noAddress = { name: "Tao Zhu", address: null };
    expect(rowPlace({ customers: noAddress })).toBe("");
    expect(rowPlace(null)).toBe("");
  });

  it("projectionPlace reads public_invoice / public_quote, null candidates included", () => {
    const data = {
      site_candidates: [null, { source: "job", parts: { address: "235 Timbercreek Court" } }],
      customer: { name: "Tao Zhu", address: "9 Elsewhere Rd" },
    };
    expect(projectionPlace(data)).toBe("235 Timbercreek");
    expect(projectionPlace({ site_candidates: [null], customer: data.customer })).toBe("9 Elsewhere");
    const nameOnly: { name: string; address?: string | null } = { name: "Tao Zhu" };
    expect(projectionPlace({ customer: nameOnly })).toBe("");
    expect(projectionPlace(null)).toBe("");
  });
});

describe("the link: /i/<token>/<street>", () => {
  it("slugs to lowercase ASCII and dashes", () => {
    expect(placeSlug("235 Timbercreek")).toBe("235-timbercreek");
    expect(placeSlug("3245 W. Lake")).toBe("3245-w-lake");
    expect(placeSlug("12 Peña Ave")).toBe("12-pena-ave");
    expect(placeSlug("  #/?&=  ")).toBe("");
    expect(placeSlug("日本語")).toBe("");
    expect(placeSlug("1 " + "Long ".repeat(30)).length).toBeLessThanOrEqual(60);
    expect(placeSlug("1 " + "Long ".repeat(30))).not.toMatch(/-$/);
  });

  it("no place, no slug: the bare link, exactly as before", () => {
    expect(withPlace("/i/tok", "")).toBe("/i/tok");
    expect(withPlace("/i/tok", null)).toBe("/i/tok");
    expect(withPlace("/i/tok", "日本語")).toBe("/i/tok");
    expect(withPlace("/i/tok", "235 Timbercreek")).toBe("/i/tok/235-timbercreek");
  });

  it("orgDocUrl carries it, on the org's own domain", () => {
    const ET = getOrgSettings({ custom_domain: "etelectricity.com" });
    expect(orgDocUrl(ET, "i", "tok", "235 Timbercreek")).toBe("https://etelectricity.com/i/tok/235-timbercreek");
    expect(orgDocUrl(ET, "q", "tok", "13897 Herringbone")).toBe("https://etelectricity.com/q/tok/13897-herringbone");
    expect(orgDocUrl(ET, "i", "tok")).toBe("https://etelectricity.com/i/tok");
  });
});

describe("the filename: INV-080_235 Timbercreek.pdf", () => {
  it("number, then street", () => {
    expect(docFileName("INV-080", "235 Timbercreek")).toBe("INV-080_235 Timbercreek.pdf");
    expect(docFileName("E-017", "13897 Herringbone")).toBe("E-017_13897 Herringbone.pdf");
    expect(docFileName("INV-080", "")).toBe("INV-080.pdf");
    expect(docFileName(null, null)).toBe("document.pdf");
    expect(docPageTitle("INV-080", "235 Timbercreek")).toBe("INV-080_235 Timbercreek");
  });

  it("drops what a filesystem or a header refuses", () => {
    expect(docFileName("INV-080", '12 A/B "Main": St?')).toBe("INV-080_12 A B Main St.pdf");
    expect(docFileName("INV-080\r\n", "12 Main")).toBe("INV-080_12 Main.pdf");
  });

  it("rides Content-Disposition as ASCII plus RFC 5987 UTF-8", () => {
    expect(contentDisposition(docFileName("INV-080", "235 Timbercreek"))).toBe(
      `inline; filename="INV-080_235 Timbercreek.pdf"; filename*=UTF-8''INV-080_235%20Timbercreek.pdf`,
    );
    const v = contentDisposition(docFileName("E-017", "12 Peña"));
    expect(v).toContain('filename="E-017_12 Pea.pdf"');
    expect(decodeURIComponent(v.split("filename*=UTF-8''")[1])).toBe("E-017_12 Peña.pdf");
  });
});
