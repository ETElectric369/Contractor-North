import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { eachAppSource, migrationFiles, migrationText } from "@/lib/migration-body.test-util";
import {
  COMPANY_FIELD,
  VENDOR_KINDS,
  VENDOR_KIND_CHOICES,
  VENDOR_KIND_LABEL,
  VENDOR_MEANS,
  companyLabel,
  costCompanyField,
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
const BUYING: CompanyField[] = ["purchase_order", "material_line", "stock_item", "paperwork_line", "price_item", "bill", "job_cost"];
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
    for (const f of ["recurring_cost", "business_cost"] as const) {
      expect(COMPANY_FIELD[f].label, f).toBe("Who You Pay");
      expect(["Supplier", "Vendor"]).not.toContain(COMPANY_FIELD[f].label);
    }
  });

  /**
   * THE + COST SHEET, THE APP'S MAIN COST DOOR (batch item 2). quick-cost-button is by its own
   * docstring "THE one 'add a cost' everywhere", and both its sheets write the SAME bills.supplier
   * column as the Bills door — yet they asked for it in their own words: "Paid to / supplier" on the
   * snap sheet (lower case, a slash, not Title Case) and "Where" / "Where (Optional)" with "The store
   * or company" under it on Type It In. Four wordings for one column, and the two Erik hits most from
   * the phone were the two left out. The word now comes from here, and WHICH word is decided here
   * too, because the same sheet files a landlord's rent as well as a supply house's materials.
   */
  it("the cost sheet's word follows where the cost lands: a job's supplier, or who you pay", () => {
    // On a job (or into shop stock): materials, bought somewhere. The same word as the bills door.
    expect(costCompanyField(false)).toBe("job_cost");
    expect(COMPANY_FIELD[costCompanyField(false)].label).toBe(COMPANY_FIELD.bill.label);
    // With no job: rent, insurance, a licence. Never "Supplier", for the same reason recurring_cost
    // isn't — so this is NOT a blanket relabel of the sheet.
    expect(costCompanyField(true)).toBe("business_cost");
    expect(COMPANY_FIELD[costCompanyField(true)].label).toBe(COMPANY_FIELD.recurring_cost.label);
    expect(COMPANY_FIELD[costCompanyField(true)].label).not.toBe("Supplier");
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

  it("the required form of a label is the label plus its asterisk, and an optional box says so", () => {
    expect(companyLabel("bill", true)).toBe("Supplier *");
    expect(companyLabel("bill")).toBe("Supplier");
    expect(companyLabel("price_item_option", true)).toBe("Vendor *");
    // A business cost's company may be left blank and the save never refuses it, so the box says
    // that in the one wording instead of the door inventing "Where (Optional)" of its own.
    expect(companyLabel("business_cost", "optional")).toBe("Who You Pay (Optional)");
    expect(companyLabel("job_cost", true)).toBe("Supplier *");
  });

  /**
   * BUILD FOR MILLIONS, IN THE SCHEMA ITSELF (batch item 6). 0002 declared
   * `purchase_orders.vendor text not null default 'CED'` — one real supply house written into the
   * schema that every company signing up inherits. 0354 set that default to an empty string (line
   * 133) and raises if it is not one (line 199). The handoff then listed it AGAIN as a migration
   * Erik still had to run, which would have spent his one migration of the day on a no-op. This is
   * the file-read twin of 0354's own check: the breach cannot come back in a later migration without
   * failing here, and nobody has to take a report's word for what the database holds.
   */
  it("the schema names no supplier: a purchase order's company defaults to nothing", () => {
    const declared = /create\s+table[^;(]*?\bpublic\.purchase_orders\b[\s\S]*?\bvendor\b[^,)]*?\bdefault\s+'([^']*)'/gi;
    const altered = /alter\s+table\s+(?:only\s+)?public\.purchase_orders\s+alter\s+column\s+vendor\s+set\s+default\s+'([^']*)'/gi;
    const found: { file: string; value: string }[] = [];
    for (const f of migrationFiles()) {
      const sql = migrationText(f);
      for (const m of [...sql.matchAll(declared), ...sql.matchAll(altered)].sort((a, b) => a.index - b.index)) {
        found.push({ file: f, value: m[1] });
      }
    }
    expect(found.length, "no migration declares or alters purchase_orders.vendor's default any more — re-point this case").toBeGreaterThan(1);
    // The LIVE default is the last one applied, exactly as `supabase db push` leaves it.
    const live = found[found.length - 1];
    expect(live.value, `${live.file} leaves purchase_orders.vendor defaulting to "${live.value}" — a schema that ships one real supplier's name`).toBe("");
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
   * rendered screens in price-list/vendor-screens.test.ts, materials/[id]/item-editor.test.ts and
   * components/quick-cost-button.test.ts are that). Twelve boxes each typed their own word once. A
   * thirteenth now fails here.
   *
   * WHAT THE FIRST THREE PATTERNS MISSED, and why the last three exist (batch items 2 and 3). The
   * first three only match a label whose text STARTS with the bare word, so two live doors walked
   * straight past them: quick-cost-button's "Paid to / supplier" (the word is not first, and it is
   * lower case) and vendors-manager's Edit card, which hand-typed "Vendor" INSIDE a ternary where
   * the label's text is an expression, not literal text. Widening the first pattern to "a Label
   * containing the word" was tried and is wrong: it fires on ten honest screens — a search box
   * listing what you can search by, a tab called "Vendors", a sentence that begins "The supplier…".
   * So the three added here match the DRIFT's shape instead of the word's presence, and were checked
   * to catch all three doors as they were written and to spare every one of those ten.
   *
   * THE LIMIT, SAID OUT LOUD: Type It In asked under the word "Where", on an input called
   * `ti-where`. No scan of this file's text can know that box is a company box, so nothing here
   * catches it — the rendered sheet in components/quick-cost-button.test.ts is what holds that door,
   * and a new cost door needs the same.
   */
  it("no screen writes one of the words into a label of its own", () => {
    const WORD = "(?:vendors?|suppliers?|stores?)";
    const patterns = [
      /<Label[^>]*>\s*(Vendor|Supplier)\b[^<]*<\/Label>/,
      /(?:placeholder|aria-label)="(?:Vendor|Supplier)\b[^"]*"/,
      /\blabel:\s*"(?:Vendor|Supplier)\b[^"]*"/,
      // A QUOTED word inside a Label's body: the word typed by hand where the text is an expression.
      /<Label[^>]*>[^<]*["'`]\s*(?:Vendor|Supplier)\b/,
      // A Label pointing AT a company box (its htmlFor ends in the word) whose words are its own.
      /<Label[^>]*htmlFor=[^>]*(?:supplier|vendor)["'`}][^>]*>(?![^<]*(?:companyLabel|COMPANY_FIELD))/i,
    ];
    const offenders: string[] = [];
    eachAppSource((p, code) => {
      if (patterns.some((re) => re.test(code))) return offenders.push(p);
      // A SHORT label — a label, not a sentence — that names one of the words anywhere in it. Length
      // is what tells a box's word from prose about a supplier, and it is what lets this one catch a
      // wording the patterns above have never seen ("Supplier Or Store", "Paid To Store").
      for (const m of code.matchAll(/<Label[^>]*>([^<]*)<\/Label>/g)) {
        const body = m[1].trim();
        if (body.length > 30 || /companyLabel|COMPANY_FIELD/.test(body)) continue;
        if (new RegExp(`\\b${WORD}\\b`, "i").test(body)) return offenders.push(p);
      }
    }, [join("src", "lib", "vendor-words.ts")]);
    expect(
      offenders,
      `these name a company box in their own words — read it from COMPANY_FIELD instead: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
