import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { eachAppSource } from "@/lib/migration-body.test-util";
import {
  COMPANY_FIELD,
  VENDOR_KINDS,
  VENDOR_KIND_CHOICES,
  VENDOR_KIND_LABEL,
  VENDOR_MEANS,
  companyLabel,
  vendorKindOf,
  type CompanyField,
  type VendorKind,
} from "@/lib/vendor-words";

/**
 * ONE WORD FOR ONE THING (W1).
 *
 * Reproduced before the fix, by reading the screens: twelve boxes asked "which company?" under three
 * different words. A purchase order said "Vendor" and meant the supply house. A material list line
 * said "Vendor". A shop-stock item said "Vendor". A dropped receipt said "Vendor" with "Store" inside
 * it, while the row that files that same paper said "Supplier Or Store" and the Bills door said
 * "Supplier *". The price book sorted on a column headed "Supplier" while the prices under an item
 * were "Vendors" — and the sheet explaining them said "the brand or supplier", which left out the
 * sub a builder prices drywall by. A recurring rent payment called the landlord a "Vendor".
 *
 * THE DECISION, now in one module (lib/vendor-words):
 *   Supplier       who you buy materials from. Every box that means "where this was bought".
 *   Brand          who makes it.
 *   Subcontractor  who you hire for part of the work.
 *   Vendor         the umbrella — any of the three — and only where any of them fits.
 *
 * The teeth: COMPANY_FIELD is a Record exhaustive over CompanyField, so a new door cannot ask the
 * question without being listed; and the tripwire at the bottom fails if a screen writes one of the
 * words into its own label.
 */

/** The doors that mean "where this was bought, or will be": all of them say the same word. */
const BUYING: CompanyField[] = ["purchase_order", "material_line", "stock_item", "paperwork_line", "price_item", "bill"];
/** The doors that take ANY kind of company: the umbrella word, and it explains itself. */
const UMBRELLA: CompanyField[] = ["price_item_option", "vendor_card"];

describe("one word for one thing: the vendor vocabulary (W1)", () => {
  it("every box that means 'where this was bought' says Supplier, and nothing else", () => {
    for (const f of BUYING) expect(COMPANY_FIELD[f].label, f).toBe("Supplier");
    // The purchase order and the Bills door were the two that disagreed; they now cannot.
    expect(COMPANY_FIELD.purchase_order.label).toBe(COMPANY_FIELD.bill.label);
    expect(COMPANY_FIELD.material_line.label).toBe(COMPANY_FIELD.paperwork_line.label);
  });

  it("the umbrella word is used only where any kind of company fits, and says what it means", () => {
    for (const f of UMBRELLA) {
      expect(COMPANY_FIELD[f].label, f).toBe("Vendor");
      expect(COMPANY_FIELD[f].help, f).toBe(VENDOR_MEANS);
    }
    // It names all three kinds, so a sub is never left out of a list he belongs on.
    for (const word of ["supplier", "sub", "brand"]) expect(VENDOR_MEANS.toLowerCase()).toContain(word);
  });

  it("a cost that is nobody's supplier is not called one", () => {
    // Rent, insurance: "Vendor" was jargon and "Supplier" would be a lie.
    expect(COMPANY_FIELD.recurring_cost.label).toBe("Who You Pay");
    expect(["Supplier", "Vendor"]).not.toContain(COMPANY_FIELD.recurring_cost.label);
  });

  it("every label is Title Case and every example is a shape, not a company", () => {
    for (const [field, def] of Object.entries(COMPANY_FIELD)) {
      for (const word of def.label.split(/\s+/)) {
        expect(word[0], `${field}: "${def.label}"`).toBe(word[0].toUpperCase());
      }
      // BUILD FOR MILLIONS: no file knows a supplier's, brand's or org's name.
      const text = `${def.label} ${def.placeholder ?? ""} ${def.help ?? ""}`;
      for (const name of ["CED", "Andersen", "Milgard", "Marvin", "Pella", "Home Depot", "ET Electric", "Vivian", "Tahoe"]) {
        expect(text, `${field} names a real company`).not.toContain(name);
      }
    }
  });

  it("the required form of a label is the label plus its asterisk", () => {
    expect(companyLabel("bill", true)).toBe("Supplier *");
    expect(companyLabel("bill")).toBe("Supplier");
    expect(companyLabel("price_item_option", true)).toBe("Vendor *");
  });

  it("a kind has one word, the choices are those kinds plus Not Sorted, and nothing else stores", () => {
    expect(VENDOR_KINDS).toEqual(["supplier", "subcontractor", "brand"]);
    for (const k of VENDOR_KINDS) expect(VENDOR_KIND_LABEL[k], k).toBeTruthy();
    expect(VENDOR_KIND_CHOICES.map((c) => c.value)).toEqual([...VENDOR_KINDS, ""]);
    expect(VENDOR_KIND_CHOICES.map((c) => c.label)).toEqual([...VENDOR_KINDS.map((k) => VENDOR_KIND_LABEL[k]), VENDOR_KIND_LABEL.none]);
    // The kind's own word matches the vocabulary: a "supplier" kind reads Supplier, same as the box.
    expect(VENDOR_KIND_LABEL.supplier).toBe(COMPANY_FIELD.bill.label);
    // The whitelist 0341's CHECK also holds: nothing else is a kind.
    expect(vendorKindOf("subcontractor")).toBe("subcontractor");
    expect(vendorKindOf("")).toBeNull();
    expect(vendorKindOf(null)).toBeNull();
    expect(vendorKindOf("  SUPPLIER ")).toBe("supplier");
    expect(vendorKindOf("sub")).toBeUndefined();
    expect(vendorKindOf("manufacturer")).toBeUndefined();
    const kinds: VendorKind[] = ["brand", "supplier", "subcontractor"];
    expect([...kinds].sort()).toEqual([...VENDOR_KINDS].sort());
  });

  /**
   * A DELIBERATE BYPASS TRIPWIRE (not the proof the behaviour works — the cases above and the
   * rendered screens in price-list/vendor-screens.test.ts and materials/[id]/item-editor.test.ts are
   * that). Twelve boxes each typed their own word once. A thirteenth now fails here.
   */
  it("no screen writes one of the words into a label of its own", () => {
    // A field label, an aria-label or a placeholder that spells the word out by hand.
    const patterns = [
      /<Label[^>]*>\s*(Vendor|Supplier)\b[^<]*<\/Label>/,
      /(?:placeholder|aria-label)="(?:Vendor|Supplier)\b[^"]*"/,
      /\blabel:\s*"(?:Vendor|Supplier)\b[^"]*"/,
    ];
    const offenders: string[] = [];
    eachAppSource((p, code) => {
      if (patterns.some((re) => re.test(code))) offenders.push(p);
    }, [join("src", "lib", "vendor-words.ts")]);
    expect(
      offenders,
      `these name a company box in their own words — read it from COMPANY_FIELD instead: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
