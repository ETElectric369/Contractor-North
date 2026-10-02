import { describe, it, expect } from "vitest";
import { docFileName, docPageTitle, docPlace, placeSlug, projectionPlace, rowPlace, withPlace } from "./doc-place";
import { contentDisposition } from "./content-disposition";
import { getOrgSettings, orgDocUrl } from "./org-settings";

describe("docPlace — the street number and name, without the street label", () => {
  it("Erik's two examples", () => {
    expect(docPlace("235 Thistlewood Court")).toBe("235 Thistlewood");
    expect(docPlace("3245 West Garnet Boulevard")).toBe("3245 West Garnet");
  });

  it("drops a trailing type word, full or abbreviated, with or without a dot", () => {
    const cases: [string, string][] = [
      ["235 Thistlewood Ct", "235 Thistlewood"],
      ["10816 East Meadow Street", "10816 East Meadow"],
      ["10244 Snowbell Dr", "10244 Snowbell"],
      ["12633 Plover Dam Road", "12633 Plover Dam"],
      ["5659 Fernhill Rd", "5659 Fernhill"],
      ["14161 Tupelo Lane", "14161 Tupelo"],
      ["1370 Sycamore Avenue", "1370 Sycamore"],
      ["300 W Garnet Blvd", "300 W Garnet"],
      ["3245 W. Garnet Blvd.", "3245 W. Garnet"],
      ["13897 Honeysuckle Way", "13897 Honeysuckle"],
      ["1386 Mallow Springs Trail", "1386 Mallow Springs"],
      ["12 Aspen Cir", "12 Aspen"],
      ["41 Larkspur Pl", "41 Larkspur"],
      ["40 Donner Pass Hwy", "40 Donner Pass"],
      ["9 Northstar Loop", "9 Northstar"],
      ["2772 Larch Terrace Avenue", "2772 Larch Terrace"],
    ];
    for (const [input, place] of cases) expect(docPlace(input), input).toBe(place);
  });

  it("leaves a street with no type word alone", () => {
    expect(docPlace("11301 Pinyon Sage")).toBe("11301 Pinyon Sage");
    expect(docPlace("94248 California 70")).toBe("94248 California 70");
    expect(docPlace("94248 CA-70, Chilcoot, CA 96105, USA")).toBe("94248 CA-70");
  });

  it("never cuts down to the bare house number", () => {
    expect(docPlace("94248 Highway 70")).toBe("94248 Highway 70");
    expect(docPlace("100 Loop")).toBe("100 Loop");
  });

  it("takes the first line only: the city, state and zip never ride along", () => {
    expect(docPlace("235 Thistlewood Ct, Reno, NV 89511, USA")).toBe("235 Thistlewood");
    expect(docPlace("1860 Cedar Park Heights Dr, Tahoe City, CA 96145, USA")).toBe("1860 Cedar Park Heights");
    // The comma-less blobs on file: the town follows the street label.
    expect(docPlace("13897 Honeysuckle Way Truckee  CA 96161")).toBe("13897 Honeysuckle");
    expect(docPlace("1871 Acacia Ct Olympic Valley CA 96146 United States")).toBe("1871 Acacia");
    expect(docPlace("300 W Garnet Blvd\nTahoe City")).toBe("300 W Garnet");
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
    expect(docPlace("300 W Garnet Blvd #11")).toBe("300 W Garnet");
    expect(docPlace("300 W Garnet Blvd Apt 2")).toBe("300 W Garnet");
    expect(docPlace("300 W Garnet Blvd Unit B, Tahoe City")).toBe("300 W Garnet");
    expect(docPlace("12 Main St Suite 100")).toBe("12 Main");
    expect(docPlace("12 Main St Ste. 5")).toBe("12 Main");
    expect(docPlace("12 Main #4")).toBe("12 Main");
    expect(docPlace("12 Main St Apt 2B")).toBe("12 Main");
  });

  it("falls back in order, and is empty with no address at all", () => {
    expect(docPlace(null, "", "  ", "235 Thistlewood Ct")).toBe("235 Thistlewood");
    expect(docPlace("13897 Honeysuckle Way", "235 Thistlewood Ct")).toBe("13897 Honeysuckle");
    expect(docPlace()).toBe("");
    expect(docPlace(null, undefined, "")).toBe("");
  });

  it("rowPlace: the quote's own site, the job's, the lead's, then the customer's; never the name", () => {
    const customers = { name: "Tess Zane", address: "235 Thistlewood Ct" };
    expect(rowPlace({ jobs: { address: "235 Thistlewood Court" }, customers })).toBe("235 Thistlewood");
    expect(rowPlace({ jobs: null, customers })).toBe("235 Thistlewood");
    expect(rowPlace({ jobs: [{ address: "3245 West Garnet Boulevard" }], customers: [customers] })).toBe("3245 West Garnet");
    expect(rowPlace({ address: "13897 Honeysuckle Way", jobs: { address: "1 Other St" } })).toBe("13897 Honeysuckle");
    expect(rowPlace({ inquiry: { address: "600 Wild Plum Court" }, customers })).toBe("600 Wild Plum");
    const noAddress = { name: "Tess Zane", address: null };
    expect(rowPlace({ customers: noAddress })).toBe("");
    expect(rowPlace(null)).toBe("");
  });

  it("projectionPlace reads public_invoice / public_quote, null candidates included", () => {
    const data = {
      site_candidates: [null, { source: "job", parts: { address: "235 Thistlewood Court" } }],
      customer: { name: "Tess Zane", address: "9 Elsewhere Rd" },
    };
    expect(projectionPlace(data)).toBe("235 Thistlewood");
    expect(projectionPlace({ site_candidates: [null], customer: data.customer })).toBe("9 Elsewhere");
    const nameOnly: { name: string; address?: string | null } = { name: "Tess Zane" };
    expect(projectionPlace({ customer: nameOnly })).toBe("");
    expect(projectionPlace(null)).toBe("");
  });
});

describe("the link: /i/<token>/<street>", () => {
  it("slugs to lowercase ASCII and dashes", () => {
    expect(placeSlug("235 Thistlewood")).toBe("235-thistlewood");
    expect(placeSlug("3245 W. Garnet")).toBe("3245-w-garnet");
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
    expect(withPlace("/i/tok", "235 Thistlewood")).toBe("/i/tok/235-thistlewood");
  });

  it("orgDocUrl carries it, on the org's own domain", () => {
    const ET = getOrgSettings({ custom_domain: "etelectricity.com" });
    expect(orgDocUrl(ET, "i", "tok", "235 Thistlewood")).toBe("https://etelectricity.com/i/tok/235-thistlewood");
    expect(orgDocUrl(ET, "q", "tok", "13897 Honeysuckle")).toBe("https://etelectricity.com/q/tok/13897-honeysuckle");
    expect(orgDocUrl(ET, "i", "tok")).toBe("https://etelectricity.com/i/tok");
  });
});

describe("the filename: INV-080_235 Thistlewood.pdf", () => {
  it("number, then street", () => {
    expect(docFileName("INV-080", "235 Thistlewood")).toBe("INV-080_235 Thistlewood.pdf");
    expect(docFileName("E-017", "13897 Honeysuckle")).toBe("E-017_13897 Honeysuckle.pdf");
    expect(docFileName("INV-080", "")).toBe("INV-080.pdf");
    expect(docFileName(null, null)).toBe("document.pdf");
    expect(docPageTitle("INV-080", "235 Thistlewood")).toBe("INV-080_235 Thistlewood");
  });

  it("drops what a filesystem or a header refuses", () => {
    expect(docFileName("INV-080", '12 A/B "Main": St?')).toBe("INV-080_12 A B Main St.pdf");
    expect(docFileName("INV-080\r\n", "12 Main")).toBe("INV-080_12 Main.pdf");
  });

  it("rides Content-Disposition as ASCII plus RFC 5987 UTF-8", () => {
    expect(contentDisposition(docFileName("INV-080", "235 Thistlewood"))).toBe(
      `inline; filename="INV-080_235 Thistlewood.pdf"; filename*=UTF-8''INV-080_235%20Thistlewood.pdf`,
    );
    const v = contentDisposition(docFileName("E-017", "12 Peña"));
    expect(v).toContain('filename="E-017_12 Pea.pdf"');
    expect(decodeURIComponent(v.split("filename*=UTF-8''")[1])).toBe("E-017_12 Peña.pdf");
  });
});
