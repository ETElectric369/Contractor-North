import { describe, expect, it } from "vitest";
import {
  applySiteFill,
  emptyBoxes,
  fillSummary,
  gapsFor,
  looksLikeWebAddress,
  mergeModelFields,
  notesFromSite,
  oneLineAddress,
  siteToForm,
  siteUrl,
  withoutSiteFill,
  type FillValues,
} from "./form-fill";

const BLANK: FillValues = { name: "", phone: "", email: "", address: "", notes: "", category: "Building Department" };

const SITE = {
  name: "Pine County Building Department",
  phones: ["(530) 555-0142", "(530) 555-0143"],
  email: "building@pinecounty.example.gov",
  street: "101 Courthouse Sq",
  city: "Pineville",
  state: "CA",
  zip: "96000",
  hours: "Mon–Fri 8 AM–5 PM",
  about: "County building department",
  category: "Building Department",
};

describe("applySiteFill: suggestions fill EMPTY boxes only", () => {
  it("fills every empty box from the site", () => {
    const { next, filled } = applySiteFill(BLANK, siteToForm({ ...SITE, category: "Utility" }), { categoryOpen: true });
    expect(next).toEqual({
      name: "Pine County Building Department",
      phone: "(530) 555-0142",
      email: "building@pinecounty.example.gov",
      address: "101 Courthouse Sq, Pineville, CA 96000",
      notes: "County building department\nHours: Mon–Fri 8 AM–5 PM\nOther phone: (530) 555-0143",
      category: "Utility",
    });
    expect(filled).toEqual(["name", "phone", "email", "address", "notes", "category"]);
  });

  it("never overwrites what the person typed, not even a single space-padded character", () => {
    const typed: FillValues = { name: "County Bldg", phone: "(530) 555-9999", email: "", address: " x ", notes: "Ask for Dana", category: "Inspector" };
    const { next, filled } = applySiteFill(typed, siteToForm(SITE), { categoryOpen: false });
    expect(next).toEqual({ ...typed, email: "building@pinecounty.example.gov" });
    expect(filled).toEqual(["email"]);
  });

  it("leaves the category alone once the person picked one, or on an existing contact", () => {
    const { next, filled } = applySiteFill(BLANK, { category: "Utility" }, { categoryOpen: false });
    expect(next.category).toBe("Building Department");
    expect(filled).toEqual([]);
  });

  it("keeps any other fields of the form untouched", () => {
    const form = { ...BLANK, website: "pinecounty.example.gov", contact: "Dana" };
    const { next } = applySiteFill(form, siteToForm(SITE), { categoryOpen: true });
    expect(next.website).toBe("pinecounty.example.gov");
    expect(next.contact).toBe("Dana");
  });

  it("asks the server only for the boxes that are empty", () => {
    expect(emptyBoxes({ ...BLANK, name: "Typed" }, { categoryOpen: false })).toEqual(["phone", "email", "address", "notes"]);
    expect(emptyBoxes(BLANK, { categoryOpen: true })).toEqual(["name", "phone", "email", "address", "notes", "category"]);
  });
});

describe("reading a second site: the first one's untouched details are replaced whole", () => {
  const FIRST = siteToForm({
    name: "Pacific Power Co",
    phones: ["(530) 555-0101"],
    email: "help@pacific-power.example",
    street: "1 Main St",
    city: "Quincy",
    state: "CA",
    zip: "95971",
    hours: "Mon–Fri 8 AM–5 PM",
    category: "Utility",
  });
  const SECOND = siteToForm({ name: "Liberty Valley Utilities", email: "service@liberty-valley.example", category: "Utility" });

  it("counts a box still marked from the first site as open, so a paste of another address reads it", () => {
    const { next, filled } = applySiteFill(BLANK, FIRST, { categoryOpen: true });
    expect(emptyBoxes(next, { categoryOpen: true })).toEqual(["category"]);
    expect(emptyBoxes(withoutSiteFill(next, filled, BLANK), { categoryOpen: true })).toEqual(["name", "phone", "email", "address", "notes", "category"]);
  });

  it("fills from the second site, empties what only the first listed, and keeps what the person edited", () => {
    const first = applySiteFill(BLANK, FIRST, { categoryOpen: true });
    // The person corrected the phone, so its mark came off: it's theirs now.
    const form = { ...first.next, phone: "(530) 555-0199" };
    const marks = first.filled.filter((k) => k !== "phone");
    const before = withoutSiteFill(form, marks, BLANK);
    const { next, filled } = applySiteFill(before, SECOND, { categoryOpen: true });
    expect(next).toEqual({
      name: "Liberty Valley Utilities",
      phone: "(530) 555-0199",
      email: "service@liberty-valley.example",
      address: "",
      notes: "",
      category: "Utility",
    });
    expect(filled).toEqual(["name", "email", "category"]);
    expect(fillSummary(before, SECOND, filled)).toBe(
      "Filled name, email and category from their site. Check them, then Save. That site didn't list an address.",
    );
  });

  it("puts a category the site picked back to the default when the next site picks none", () => {
    const first = applySiteFill(BLANK, FIRST, { categoryOpen: true });
    expect(withoutSiteFill(first.next, first.filled, BLANK).category).toBe("Building Department");
  });
});

describe("fillSummary: never silent", () => {
  it("says what was filled", () => {
    expect(fillSummary(BLANK, siteToForm(SITE), ["name", "phone", "address"])).toBe(
      "Filled name, phone and address from their site. Check them, then Save.",
    );
  });

  it("says when the site didn't list a phone", () => {
    const found = siteToForm({ name: "Acme", email: "a@acme.example", street: "1 Main St" });
    expect(fillSummary(BLANK, found, ["name", "email", "address"])).toBe(
      "Filled name, email and address from their site. Check them, then Save. That site didn't list a phone.",
    );
  });

  it("names every missing detail the person still needs", () => {
    expect(fillSummary(BLANK, { name: "Acme" }, ["name"])).toBe(
      "Filled name from their site. Check them, then Save. That site didn't list a phone, an email or an address.",
    );
  });

  it("doesn't complain about a detail the person already typed", () => {
    expect(fillSummary({ ...BLANK, phone: "(530) 555-0100" }, { name: "Acme", email: "a@acme.example", address: "1 Main St" }, ["name"])).not.toContain(
      "phone",
    );
  });

  it("says so when the page listed nothing, and when every box was already full", () => {
    expect(fillSummary(BLANK, {}, [])).toBe("That page didn't list any contact details. Try the link to their Contact page.");
    const full: FillValues = { name: "a", phone: "b", email: "c", address: "d", notes: "e", category: "Other" };
    expect(fillSummary(full, siteToForm(SITE), [])).toBe("Every box that site could fill already has something in it, so nothing changed.");
  });
});

describe("the pieces", () => {
  it("writes an address on one line from whatever parts there are", () => {
    expect(oneLineAddress({ street: "1 Main St", city: "Quincy", state: "CA", zip: "95971" })).toBe("1 Main St, Quincy, CA 95971");
    expect(oneLineAddress({ city: "Quincy", state: "CA" })).toBe("Quincy, CA");
    expect(oneLineAddress({})).toBe("");
  });

  it("puts what they are, their hours and other lines in Notes", () => {
    expect(notesFromSite({ phones: ["(530) 555-0101"] })).toBe("");
    expect(notesFromSite({ hours: "Mon–Fri 8 AM–5 PM", phones: ["a", "b", "c"] })).toBe("Hours: Mon–Fri 8 AM–5 PM\nOther phones: b, c");
  });

  it.each([
    ["pge.com", true],
    ["https://www.pinecounty.example.gov/building?x=1", true],
    ["yourcounty.gov/building", true],
    ["http://localhost", false],
    ["not a site", false],
    ["hello", false],
    ["", false],
    // Copied out of a sentence: the sentence's punctuation doesn't make it not an address.
    ["www.pge.com.", true],
    ["https://www.pge.com)", true],
    ["pge.com,", true],
    ["(pge.com)", true],
    ["<https://pge.com>", true],
    ['"pge.com"', true],
    ["https://en.example.org/wiki/Panel_(electric)", true],
    ["...", false],
    ["hello.", false],
  ])("looksLikeWebAddress(%s) = %s", (s, ok) => {
    expect(looksLikeWebAddress(s)).toBe(ok);
  });

  it.each([
    ["pge.com", "https://pge.com"],
    ["  http://pge.com/x ", "http://pge.com/x"],
    ["pge.com:8080/x", "https://pge.com:8080/x"],
    ["javascript:alert(1)", "javascript:alert(1)"],
    ["file:///etc/passwd", "file:///etc/passwd"],
    ["", null],
    ["www.pge.com.", "https://www.pge.com"],
    ["https://www.pge.com)", "https://www.pge.com"],
    ["(pge.com),", "https://pge.com"],
    ["<https://pge.com/contact>.", "https://pge.com/contact"],
    ["https://en.example.org/wiki/Panel_(electric).", "https://en.example.org/wiki/Panel_(electric)"],
    [".", null],
  ])("siteUrl(%s) = %s", (s, url) => {
    expect(siteUrl(s)).toBe(url);
  });
});

describe("gaps and the model's answer", () => {
  it("finds no gap when the page's card covers every empty box, so no model is asked", () => {
    const need = emptyBoxes({ ...BLANK, notes: "typed" }, { categoryOpen: false });
    expect(gapsFor(need, SITE, [])).toEqual([]);
  });

  it("counts a weak (title) name and a missing phone as gaps", () => {
    expect(gapsFor(["name", "phone", "email"], { name: "Home Page Guess", email: "a@b.example" }, ["name"])).toEqual(["name", "phone"]);
  });

  it("fills gaps from the model and never replaces what the page's card said", () => {
    const base = { name: "Guess From Title", email: "sales@acme.example", city: "Quincy" };
    const model = { name: "Acme Electric Supply", email: "other@acme.example", phones: ["(530) 555-0101"], street: "9 Oak Ave", city: "Portola", state: "CA", zip: "96122", about: "Electrical supply house" };
    const out = mergeModelFields(base, ["name"], model, ["name", "phone", "email", "address", "notes"]);
    expect(out).toEqual({
      name: "Acme Electric Supply",
      email: "sales@acme.example",
      phones: ["(530) 555-0101"],
      street: "9 Oak Ave",
      city: "Portola",
      state: "CA",
      zip: "96122",
      about: "Electrical supply house",
    });
  });

  it("ignores the model's answer for boxes that weren't gaps", () => {
    expect(mergeModelFields({}, [], { phones: ["(530) 555-0101"], about: "x" }, ["notes"])).toEqual({ about: "x" });
  });
});
