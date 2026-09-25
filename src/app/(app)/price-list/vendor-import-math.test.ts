import { describe, expect, it } from "vitest";
import {
  buildPreview,
  guessKind,
  guessPerson,
  isBlocked,
  looksLikeHeader,
  notesFor,
  previewHeading,
  rowsFromTable,
  rowsToAdd,
  tableFromLines,
  type ExistingVendor,
  type PreviewRow,
} from "./vendor-import-math";
import { cleanVendorCard, knownVendorNames, listedKind, matchesVendorFilter, vendorFilters, type VendorCard } from "./item-options-math";

/**
 * Import A List, the sorting half (vendor import, Phase 1). Every name here is MADE UP: a real
 * customer's vendor list never goes in this repo (it is public).
 *
 * The laws under test: the app suggests and a person decides (every kind is a labelled guess, a
 * fuzzy match only ever asks, its tick starts off, nothing is merged); an exact name the org already
 * has as a live card can't be added twice; and a subcontractor is never offered as a vendor on an
 * item.
 */

describe("headings: recognised and left out, never a vendor", () => {
  it("'Vendor Name' is a heading; a vendor called 'Supplier Co' is not", () => {
    expect(looksLikeHeader(["Vendor Name"])).toBe(true);
    expect(looksLikeHeader(["Company", "Phone", "E-mail", "Contact Person"])).toBe(true);
    expect(looksLikeHeader(["Supplier Co"])).toBe(false);
    expect(looksLikeHeader(["Granite Peak Plumbing"])).toBe(false);
    expect(looksLikeHeader([""])).toBe(false);
  });

  it("a one-column list with a heading: the heading is skipped and every name kept", () => {
    const t = rowsFromTable([["Vendor Name"], ["Acme, Inc."], ["Granite Peak Plumbing"]]);
    expect(t.headerSkipped).toBe(true);
    expect(t.rows.map((r) => r.name)).toEqual(["Acme, Inc.", "Granite Peak Plumbing"]);
    expect(t.rows[0].line).toBe(2);
  });

  it("a list with no heading: the first row is a vendor", () => {
    const t = rowsFromTable([["Acme, Inc."], ["Granite Peak Plumbing"]]);
    expect(t.headerSkipped).toBe(false);
    expect(t.rows.map((r) => r.name)).toEqual(["Acme, Inc.", "Granite Peak Plumbing"]);
  });

  it("with headings, each column goes where its heading says ('Contact Name' is the contact, not the vendor)", () => {
    const t = rowsFromTable([
      ["Contact Name", "Company", "Phone", "Email", "Street", "City", "State", "Zip"],
      ["Pat Rivera", "Lakeside Windows", "530-555-0101", "pat@lakeside.example", "1 Shore Rd", "Truckee", "CA", "96161"],
    ]);
    expect(t.rows).toEqual([
      {
        line: 2,
        name: "Lakeside Windows",
        contact_name: "Pat Rivera",
        phone: "530-555-0101",
        email: "pat@lakeside.example",
        address: "1 Shore Rd, Truckee, CA 96161",
      },
    ]);
  });

  it("with no headings, emails, phones and websites are found by what the column holds", () => {
    const t = rowsFromTable([
      ["Acme, Inc.", "(530) 555-0100", "office@acme.example", "acme.example"],
      ["Lakeside Windows", "530.555.0101", "hi@lakeside.example", "www.lakeside.example"],
    ]);
    expect(t.rows[1]).toMatchObject({ name: "Lakeside Windows", phone: "530.555.0101", email: "hi@lakeside.example", website: "www.lakeside.example" });
  });

  it("at most 200 rows; the rest are counted and said, never dropped silently", () => {
    const table = [["Vendor"], ...Array.from({ length: 205 }, (_, i) => [`Made Up Vendor ${i}`])];
    const t = rowsFromTable(table);
    expect(t.rows).toHaveLength(200);
    expect(t.overCap).toBe(5);
    expect(previewHeading(200, "List.xlsx", true, 5)).toEqual({
      title: "200 Names In List.xlsx",
      detail: "The heading row was left out. Only the first 200 rows are shown; 5 more were left out. Split the file to add them.",
    });
  });

  it("a PDF's text: one name per line, bullets and numbers off, blank and number-only lines gone", () => {
    expect(tableFromLines("Our Vendors\n\n1. Acme, Inc.\n• Lakeside Windows\n  - Granite Peak Plumbing \n42\n")).toEqual([
      ["Our Vendors"],
      ["Acme, Inc."],
      ["Lakeside Windows"],
      ["Granite Peak Plumbing"],
    ]);
  });
});

describe("guessKind: a keyword table, deterministic, Not Sorted when the name doesn't say", () => {
  const cases: [string, string | null, string | null][] = [
    ["Granite Peak Plumbing", "subcontractor", "Plumbing"],
    ["Birchwood Roofing Inc.", "subcontractor", "Roofing"],
    ["Coldwater Drywall", "subcontractor", "Drywall"],
    ["Birch Concrete Construction", "subcontractor", "Concrete"],
    ["Summit Construction", "subcontractor", "Construction"],
    ["Redfern Heating and Hydronics", "subcontractor", "Heating"],
    ["Brightline Electric", "subcontractor", "Electrical"],
    ["Lakeside Windows", "supplier", "Windows"],
    ["Harbor Door Construction", "supplier", "Doors"],
    ["Northgate Iron", "supplier", "Iron"],
    ["Ridge Plumbing Supply", "supplier", "Plumbing"],
    ["Consolidated Widget Distributors", "supplier", null],
    ["Quartzline Holdings", null, null],
    ["Ridgeline West", null, null],
    ["Heavy Haul", null, null],
  ];
  it.each(cases)("%s → %s · %s", (name, kind, trade) => {
    expect(guessKind(name)).toEqual({ kind, trade });
  });

  it("the same name always guesses the same way", () => {
    expect(guessKind("Granite Peak Plumbing")).toEqual(guessKind("Granite Peak Plumbing"));
  });
});

describe("guessPerson: a person's name, not a company's", () => {
  it.each([
    ["Maria Delgado", true],
    ["Carlos B. Ortega", true],
    ["Ridgeline West", false],
    ["Heavy Haul", false],
    ["Tom Smith Plumbing", false],
    ["Tom Smith LLC", false],
    ["Acme", false],
    ["Maria & Delgado", false],
  ])("%s → %s", (name, person) => {
    expect(guessPerson(name as string)).toBe(person);
  });
});

const card = (over: Partial<ExistingVendor> & { name: string }): ExistingVendor => ({ card: true, archived: false, onItems: false, ...over });
const raw = (names: string[]) => names.map((name, i) => ({ line: i + 2, name }));

describe("the preview: notes in plain words, ticks that leave the deciding to a person", () => {
  it("Already Have: an exact match to a live card (case and edges ignored) is blocked and unticked", () => {
    const rows = buildPreview(raw(["  ACME, INC. "]), [card({ name: "Acme, Inc." })]);
    expect(rows[0].name).toBe("ACME, INC.");
    expect(rows[0].ticked).toBe(false);
    const notes = notesFor(rows[0], rows, [card({ name: "Acme, Inc." })]);
    expect(notes.map((n) => n.text)).toEqual(["Already Have: 'Acme, Inc.' is on your Vendors list."]);
    expect(isBlocked(notes)).toBe(true);
    expect(rowsToAdd(rows, [card({ name: "Acme, Inc." })])).toEqual([]);
  });

  it("Same Company?: a spelling that only differs by punctuation and a legal form asks, tick OFF, never merged", () => {
    const existing = [card({ name: "Zephyr Labs Inc" })];
    const rows = buildPreview(raw(["Zephyr Labs, Inc."]), existing);
    expect(rows[0].ticked).toBe(false);
    expect(notesFor(rows[0], rows, existing).map((n) => n.text)).toEqual(["You already have 'Zephyr Labs Inc'. Same Company?"]);
    // A person ticks it: it's added as its OWN vendor under the name in the file. Nothing merges.
    rows[0].ticked = true;
    expect(rowsToAdd(rows, existing).map((r) => r.name)).toEqual(["Zephyr Labs, Inc."]);
  });

  it("two stores that share a trade word are NOT the same company", () => {
    const existing = [card({ name: "Ace Mountain Hardware" })];
    const rows = buildPreview(raw(["Mountain Hardware and Sports"]), existing);
    expect(rows[0].ticked).toBe(true);
    expect(notesFor(rows[0], rows, existing)).toEqual([]);
  });

  it("an archived card is brought back, and says so; a name only on items gets a card, and says so", () => {
    const existing = [card({ name: "Lakeside Windows", archived: true }), card({ name: "Andersen", card: false, onItems: true })];
    const rows = buildPreview(raw(["Lakeside Windows", "andersen"]), existing);
    expect(rows.map((r) => r.ticked)).toEqual([true, true]);
    expect(notesFor(rows[0], rows, existing)[0].text).toBe("You have 'Lakeside Windows' archived. Adding it brings it back.");
    expect(notesFor(rows[1], rows, existing)[0].text).toBe("'Andersen' is already on your items. Adding it gives it a card.");
  });

  it("in the file twice: kept once, and said", () => {
    const rows = buildPreview(raw(["Acme, Inc.", "acme, inc.", "Granite Peak Plumbing"]), []);
    expect(rows.map((r) => r.name)).toEqual(["Acme, Inc.", "Granite Peak Plumbing"]);
    expect(rows[0].copies).toBe(2);
    expect(notesFor(rows[0], rows, []).map((n) => n.text)).toEqual(["In your file twice. It's added once."]);
  });

  it("two spellings of one company in the file: the first keeps its tick, the second asks", () => {
    const rows = buildPreview(raw(["Zephyr Labs Inc", "Zephyr Labs, Inc."]), []);
    expect(rows.map((r) => r.ticked)).toEqual([true, false]);
    expect(notesFor(rows[1], rows, []).map((n) => n.text)).toEqual(["Looks like 'Zephyr Labs Inc' above. Same Company?"]);
  });

  it("the person flag: a guess, with a note in plain words, and a person can untick it", () => {
    const rows = buildPreview(raw(["Maria Delgado"]), []);
    expect(rows[0]).toMatchObject({ is_person: true, kind: null, kindGuessed: true, ticked: true });
    expect(notesFor(rows[0], rows, [])[0].text).toBe("Maria Delgado looks like a person, not a company. They'll be saved as their own contact.");
    rows[0].is_person = false;
    expect(notesFor(rows[0], rows, [])).toEqual([]);
  });

  it("every row carries its guessed kind and trade, labelled a guess", () => {
    const rows = buildPreview(raw(["Granite Peak Plumbing", "Lakeside Windows", "Quartzline Holdings"]), []);
    expect(rows.map((r) => [r.kind, r.trade, r.kindGuessed])).toEqual([
      ["subcontractor", "Plumbing", true],
      ["supplier", "Windows", true],
      [null, null, true],
    ]);
  });

  it("notes follow an edit: renaming a row onto a live card blocks it", () => {
    const existing = [card({ name: "Acme, Inc." })];
    const rows: PreviewRow[] = buildPreview(raw(["Acme Incorporated Typo"]), existing);
    rows[0].name = "acme, inc.";
    expect(isBlocked(notesFor(rows[0], rows, existing))).toBe(true);
    expect(rowsToAdd(rows, existing)).toEqual([]);
  });

  it("what Add sends: ticked rows only, with the kind, trade and person flag as the preview shows them", () => {
    const rows = buildPreview(raw(["Granite Peak Plumbing", "Lakeside Windows"]), []);
    rows[1].ticked = false;
    rows[0].kind = "supplier";
    rows[0].trade = "  Pipe ";
    expect(rowsToAdd(rows, [])).toEqual([
      {
        name: "Granite Peak Plumbing",
        contact_name: null,
        phone: null,
        email: null,
        website: null,
        address: null,
        kind: "supplier",
        trade: "Pipe",
        is_person: false,
        source_url: null,
        maps_url: null,
      },
    ]);
  });

  it("a LOOKED-UP pick changes only what Add sends: its ticked fields and where they were found (Phase 2)", () => {
    const rows = buildPreview(raw(["Granite Peak Plumbing"]), []);
    rows[0].email = "bids@granitepeak.example";
    const site = "https://granitepeak.example/contact";
    const choice = {
      id: "choice-1",
      place: "Truckee, CA",
      fields: { phone: { value: "(530) 555-0142", source: site }, email: { value: "office@granitepeak.example", source: site } },
      maps_url: null,
      source_url: site,
    };
    // Phone was empty (ticked); the typed email differs and was left unticked: it stays.
    rows[0].pick = { choice, take: ["phone"] };
    expect(rowsToAdd(rows, [])[0]).toMatchObject({ phone: "(530) 555-0142", email: "bids@granitepeak.example", source_url: site, maps_url: null });
    // The preview row itself still says what the file said: a pick fills Add, it isn't saved anywhere.
    expect(rows[0].phone).toBeNull();
    // None Of These (no pick) or nothing ticked: no source rides along.
    rows[0].pick = { choice, take: [] };
    expect(rowsToAdd(rows, [])[0]).toMatchObject({ phone: null, source_url: null });
    rows[0].pick = null;
    expect(rowsToAdd(rows, [])[0]).toMatchObject({ phone: null, source_url: null });
  });

  it("a name over 120 characters is blocked until shortened", () => {
    const rows = buildPreview(raw(["X".repeat(121)]), []);
    expect(rows[0].ticked).toBe(false);
    expect(notesFor(rows[0], rows, [])[0].kind).toBe("too-long");
  });
});

const vc = (over: Partial<VendorCard> & { name: string }): VendorCard => ({
  id: over.name,
  contact_name: null,
  phone: null,
  email: null,
  website: null,
  address: null,
  notes: null,
  archived: false,
  ...over,
});

describe("THE ITEM PRICE PICKER never offers a subcontractor (0341)", () => {
  it("brand, supplier and Not Sorted cards are offered; a subcontractor card is not, even where an item still spells it", () => {
    const cards = [
      vc({ name: "Andersen", kind: "brand" }),
      vc({ name: "Lakeside Windows", kind: "supplier" }),
      vc({ name: "Quartzline Holdings", kind: null }),
      vc({ name: "Coldwater Drywall", kind: "subcontractor" }),
    ];
    expect(knownVendorNames([{ vendor: "coldwater drywall" }, { vendor: "Milgard" }], cards)).toEqual([
      "Andersen",
      "Lakeside Windows",
      "Milgard",
      "Quartzline Holdings",
    ]);
  });

  it("before 0341 (no kind on the card) every card is offered, exactly as before", () => {
    expect(knownVendorNames([], [vc({ name: "Andersen" })])).toEqual(["Andersen"]);
  });
});

describe("the Vendors tab's chips", () => {
  const summary = (c: VendorCard | null) => ({ card: c });
  it("count each kind; a vendor only on items (no card) is a brand; Not Sorted is its own chip", () => {
    const vs = [
      summary(vc({ name: "A", kind: "supplier" })),
      summary(vc({ name: "B", kind: "subcontractor" })),
      summary(vc({ name: "C", kind: "subcontractor" })),
      summary(vc({ name: "D", kind: null })),
      summary(null),
    ];
    expect(vendorFilters(vs).map((f) => `${f.label} ${f.count}`)).toEqual(["All 5", "Suppliers 1", "Subs 2", "Brands 1", "Not Sorted 1"]);
    expect(listedKind(summary(null))).toBe("brand");
    expect(vs.filter((v) => matchesVendorFilter(v, "none"))).toHaveLength(1);
    expect(vs.filter((v) => matchesVendorFilter(v, "subcontractor"))).toHaveLength(2);
  });
});

describe("cleanVendorCard: kind is a whitelist, trade is short, the person flag is a yes or no", () => {
  it("accepts the three kinds and Not Sorted (blank)", () => {
    expect(cleanVendorCard({ name: "A", kind: "Subcontractor" }, "create")).toEqual({ clean: { name: "A", kind: "subcontractor" } });
    expect(cleanVendorCard({ kind: "" }, "update")).toEqual({ clean: { kind: null } });
  });
  it("refuses anything else in words", () => {
    expect(cleanVendorCard({ name: "A", kind: "vendor" }, "create")).toEqual({ error: "Pick a kind: Supplier, Subcontractor, Brand or Not Sorted." });
    expect(cleanVendorCard({ trade: "x".repeat(61) }, "update")).toEqual({ error: "That trade is too long. Keep it under 60 characters." });
  });
  it("is_person only when passed", () => {
    expect(cleanVendorCard({ name: "Maria Delgado", is_person: true }, "create")).toEqual({ clean: { name: "Maria Delgado", is_person: true } });
    expect(cleanVendorCard({ phone: "5305550100" }, "update")).toEqual({ clean: { phone: "5305550100" } });
  });
});
