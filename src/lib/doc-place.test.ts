import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { docFileName, docPageTitle, docPlace, placeSlug, projectionPlace, rowPlace, withPlace } from "./doc-place";
import { contentDisposition } from "./content-disposition";
import { getOrgSettings, orgDocUrl } from "./org-settings";
import { pickSite } from "./site-address";
import { bornFromEstimateCandidates, quoteSiteCandidates } from "./quote-site";

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

  /**
   * AN INVOICE MADE FROM AN ESTIMATE IS NAMED FOR THE PLACE ITS PAPER PRINTS (cn-v1160, skeptic #61).
   * A bill made straight from an estimate that never became a job prints that estimate's site, then
   * its lead's, before the customer's own address. The link and the file used to skip both, so a bill
   * for a customer's second building was named for the customer's own street over a sheet that said
   * the other address. Every name and street here is invented.
   */
  describe("rowPlace: an invoice read with the estimate it was made from", () => {
    const job = { address: "9 Bayberry Lane" };
    const est = { address: "40 Snowbell Court" };
    const lead = { address: "16 Larkspur Circle" };
    const customers = { name: "Dana Rook", address: "12 Thistlewood Way" };

    it("the job's, then the estimate's own site, that estimate's lead's, then the customer's", () => {
      expect(rowPlace({ jobs: job, quotes: { ...est, inquiries: lead }, customers })).toBe("9 Bayberry");
      expect(rowPlace({ jobs: null, quotes: { ...est, inquiries: lead }, customers })).toBe("40 Snowbell");
      expect(rowPlace({ jobs: { address: null }, quotes: { address: null, inquiries: lead }, customers })).toBe("16 Larkspur");
      expect(rowPlace({ jobs: null, quotes: { address: "  ", inquiries: { address: "" } }, customers })).toBe("12 Thistlewood");
      // Nobody has an address: no place at all, and never the customer's name in its stead.
      const nameOnly = { name: "Dana Rook", address: null };
      expect(rowPlace({ jobs: null, quotes: { address: null, inquiries: null }, customers: nameOnly })).toBe("");
    });

    const KEYS = ["job", "quote", "lead", "customer"] as const;
    const SITES = { job, quote: est, lead, customer: customers };
    const PAPERS = Array.from({ length: 16 }, (_, bits): [string, Record<(typeof KEYS)[number], boolean>] => {
      const has = { job: !!(bits & 8), quote: !!(bits & 4), lead: !!(bits & 2), customer: !!(bits & 1) };
      return [KEYS.filter((k) => has[k]).join(" + ") || "no address anywhere", has];
    });

    it.each(PAPERS)("the same order as the paper (%s)", (_name, has) => {
      const at = (k: (typeof KEYS)[number]) => (has[k] ? SITES[k] : { address: null });
      const row = { jobs: at("job"), quotes: { ...at("quote"), inquiries: at("lead") }, customers: at("customer") };
      // What the bill's sheet prints: the one order (lib/quote-site), first record with an address.
      const printed = pickSite(bornFromEstimateCandidates({ job: at("job"), quote: at("quote"), lead: at("lead"), customer: at("customer") }));
      expect(rowPlace(row)).toBe(docPlace(printed?.address));
      // …and it is a real street whenever anybody has one.
      expect(rowPlace(row) !== "").toBe(KEYS.some((k) => has[k]));
    });

    it("read without the embed, or made from no estimate: named exactly as before", () => {
      expect(rowPlace({ jobs: job, customers })).toBe("9 Bayberry");
      expect(rowPlace({ jobs: null, customers })).toBe("12 Thistlewood");
      // The embed arrives as null when the bill was made from no estimate.
      expect(rowPlace({ jobs: null, quotes: null, customers })).toBe("12 Thistlewood");
      expect(rowPlace({ jobs: job, quotes: null, customers })).toBe("9 Bayberry");
      expect(rowPlace({ jobs: null, quotes: undefined, customers })).toBe("12 Thistlewood");
    });

    it("the embed in the shapes it can arrive in: a list, an empty list, the lead under its alias", () => {
      expect(rowPlace({ jobs: [], quotes: [{ ...est, inquiries: [lead] }], customers: [customers] })).toBe("40 Snowbell");
      expect(rowPlace({ quotes: [{ address: null, inquiries: [lead] }], customers })).toBe("16 Larkspur");
      expect(rowPlace({ quotes: { address: null, inquiry: lead }, customers })).toBe("16 Larkspur");
      expect(rowPlace({ quotes: [], customers })).toBe("12 Thistlewood");
    });

    it("only the street: never the customer's name, the unit or the town", () => {
      const row = { jobs: null, quotes: { address: "40 Snowbell Court #14, Testville, CA 96161", inquiries: null }, customers };
      expect(rowPlace(row)).toBe("40 Snowbell");
      expect(docFileName("INV-090", rowPlace(row))).toBe("INV-090_40 Snowbell.pdf");
      expect(withPlace("/i/tok", rowPlace(row))).toBe("/i/tok/40-snowbell");
    });
  });

  describe("rowPlace: an estimate row keeps its own order", () => {
    const KEYS = ["quote", "job", "lead", "customer"] as const;
    const SITES = { quote: { address: "40 Snowbell Court" }, job: { address: "9 Bayberry Lane" }, lead: { address: "16 Larkspur Circle" }, customer: { address: "12 Thistlewood Way" } };
    const PAPERS = Array.from({ length: 16 }, (_, bits): [string, Record<(typeof KEYS)[number], boolean>] => {
      const has = { quote: !!(bits & 8), job: !!(bits & 4), lead: !!(bits & 2), customer: !!(bits & 1) };
      return [KEYS.filter((k) => has[k]).join(" + ") || "no address anywhere", has];
    });

    it.each(PAPERS)("its own site, the job's, the lead's, the customer's (%s)", (_name, has) => {
      const at = (k: (typeof KEYS)[number]) => (has[k] ? SITES[k] : { address: null });
      // An estimate's readers name no quotes(…) embed: the row is its own address and three embeds.
      const row = { address: at("quote").address, jobs: at("job"), inquiries: at("lead"), customers: at("customer") };
      const printed = pickSite(quoteSiteCandidates({ quote: at("quote"), job: at("job"), lead: at("lead"), customer: at("customer") }));
      expect(rowPlace(row)).toBe(docPlace(printed?.address));
      // The same row read with the lead under its alias (the reminder's and the send's selects).
      expect(rowPlace({ address: row.address, jobs: row.jobs, inquiry: row.inquiries, customers: row.customers })).toBe(docPlace(printed?.address));
    });

    it("its own site still outranks the job's: the invoice's order did not leak into it", () => {
      expect(rowPlace({ address: "40 Snowbell Court", jobs: { address: "9 Bayberry Lane" } })).toBe("40 Snowbell");
      expect(rowPlace({ address: null, jobs: { address: "9 Bayberry Lane" }, inquiries: { address: "16 Larkspur Circle" } })).toBe("9 Bayberry");
    });
  });

  describe("every invoice reader that names a place reads the estimate the bill was made from", () => {
    const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
    const EMBED = "quotes(address, inquiries(address))";
    /** Each file that names an invoice's place, and how many invoice reads in it do. */
    const READERS: [string, number][] = [
      ["src/app/(app)/billing/actions.ts", 4], // the share sheet, the review sheet, the text, the Pay Now sheet's receipt link
      ["src/app/print/invoice/[id]/page.tsx", 1], // the page title Save As PDF offers
      ["src/app/api/share-pdf/[token]/route.ts", 1], // the customer's download
      ["src/app/api/pdf/[doc]/[id]/route.ts", 1], // the office's download
      ["src/lib/reminders-engine.ts", 1], // the overdue reminder's link
      ["src/lib/invoice-email.ts", 1], // the emailed link
    ];
    /** Every select in a file that reads a place: it names the job's address embed. */
    const placeSelects = (src: string) => [...src.matchAll(/\.select\(\s*"([^"]*jobs\(address\)[^"]*)"/g)].map((m) => m[1]);
    const isEstimateRead = (select: string) => /\bquote_number\b/.test(select);

    it.each(READERS)("%s: %i invoice read(s), each with the embed", (file, count) => {
      const selects = placeSelects(read(file));
      const invoices = selects.filter((s) => !isEstimateRead(s));
      expect(invoices).toHaveLength(count);
      for (const select of invoices) {
        // A column you do not select is a column you cannot rank: without the embed rowPlace falls
        // straight from the job's street to the customer's, as it did.
        expect(select).toContain(EMBED);
        expect(select).toContain("customers(");
      }
      // An estimate's own read is as it was: its own address column, the job's, the lead's, the customer's.
      for (const select of selects.filter(isEstimateRead)) {
        expect(select).not.toContain("quotes(");
        const ownColumns = select.replace(/\([^()]*\)/g, "").split(",").map((c) => c.trim());
        expect(ownColumns).toContain("address");
        expect(select).toMatch(/inquir(ies|y:inquiry_id)\(address\)/);
        expect(select).toContain("customers(");
      }
    });

    it("the list is every file that calls rowPlace: a new reader of an invoice's place has to join it", () => {
      const callers: string[] = [];
      const walk = (dir: string) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && /\browPlace\(/.test(readFileSync(p, "utf8"))) callers.push(relative(process.cwd(), p));
        }
      };
      walk(join(process.cwd(), "src"));
      // The two that read ESTIMATES only (the estimate's own send doors, and its print page).
      const estimatesOnly = ["src/app/(app)/quotes/actions.ts", "src/app/print/quote/[id]/page.tsx"];
      expect(callers.filter((f) => f !== "src/lib/doc-place.ts").sort()).toEqual([...READERS.map(([f]) => f), ...estimatesOnly].sort());
    });

    it("the embed is the one rowPlace reads: the estimate's own address, and its lead's inside it", () => {
      expect(rowPlace({ jobs: null, quotes: { address: "40 Snowbell Court", inquiries: { address: "16 Larkspur Circle" } }, customers: { address: "12 Thistlewood Way" } })).toBe("40 Snowbell");
      const lib = read("src/lib/doc-place.ts");
      expect(lib).toContain("`quotes(address, inquiries(address))`");
      // The rule file stays a leaf: it imports nothing, so a customer's page pulls no dictionary through it.
      expect(lib).not.toMatch(/^import /m);
    });
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
