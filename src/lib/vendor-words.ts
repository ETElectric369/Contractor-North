/**
 * THE WORDS FOR A COMPANY YOU BUY FROM OR HIRE. DECIDED ONCE, HERE (W1).
 *
 * THE MESS THIS REPLACES. A purchase order said "Vendor" and meant the supply house. A material
 * list line said "Vendor" and meant the supply house. A dropped receipt said "Vendor" and meant the
 * store. The price book said "Vendor" and meant the MAKER — Andersen, Milgard — over a sort column
 * headed "Supplier", while the Vendors tab offered "Supplier" as a KIND of vendor. The bills door,
 * meanwhile, called the same company a "Supplier *". So Erik typed one company into four boxes
 * under two words that never agreed, and Justin had to call a drywall sub a Supplier before he could
 * price drywall by the sub.
 *
 * THE VOCABULARY, in words a working electrician reads without a glossary:
 *
 *   Supplier       a company you BUY MATERIALS FROM — the supply house, the store, the distributor.
 *                  Every box that means "where this was bought, or will be" says Supplier: the
 *                  purchase order, the material list line, a dropped receipt, a bill, and the price
 *                  book's own column.
 *   Brand          who MAKES the thing: Andersen, Milgard, Marvin.
 *   Subcontractor  a company you HIRE to do part of the work. "Sub" in a chip, never in a label.
 *   Vendor         the umbrella: any of the three. A box that can hold any of them says Vendor, and
 *                  says so in VENDOR_MEANS. That is the Vendors tab, and the per-company prices on a
 *                  price-book item — which is why a sub can be priced on an item without being
 *                  called a supplier first.
 *
 * NO FILE KNOWS A SUPPLIER'S NAME (build for millions). The examples below are shapes, not
 * companies: "the supply house" and a made-up street name, never CED, never Andersen as a default.
 *
 * STORED WORDS ARE UNCHANGED. purchase_orders.vendor, material_list_items.vendor,
 * price_list_items.supplier, price_list_item_options.vendor, bills.supplier and
 * price_list_vendors.kind keep their column names and their values; this file is what every SCREEN
 * reads. Renaming a stored word is a migration, which is Erik's button, not this file's.
 */

/**
 * What a vendor's card says it IS (price_list_vendors.kind, 0341). Erik 2026-09-30 reversed 0341's
 * "a subcontractor never carries prices": a builder prices a line like drywall by the sub who hangs
 * it. The kind sorts the directory and says who a vendor is; it never decides who can be priced.
 */
export type VendorKind = "brand" | "supplier" | "subcontractor";

/** The kinds, in the order every list offers them: who you buy from, who you hire, who makes it. */
export const VENDOR_KINDS: VendorKind[] = ["supplier", "subcontractor", "brand"];

/** A kind as typed or chosen → the column's value, or undefined when it isn't one ("" is null, Not
 *  Sorted). The whitelist 0341's check constraint also holds. */
export function vendorKindOf(raw: unknown): VendorKind | null | undefined {
  const s = String(raw ?? "").trim().toLowerCase();
  if (!s) return null;
  return (VENDOR_KINDS as string[]).includes(s) ? (s as VendorKind) : undefined;
}

/**
 * One kind's word, for chips, selects and headings. Title Case: they are clickable. Exhaustive by
 * type over VendorKind, so a fourth kind cannot be stored without a word to show for it.
 */
export const VENDOR_KIND_LABEL: Record<VendorKind | "none", string> = {
  brand: "Brand",
  supplier: "Supplier",
  subcontractor: "Subcontractor",
  none: "Not Sorted",
};

/** The Kind choices, in the order the selects list them. "" is Not Sorted. */
export const VENDOR_KIND_CHOICES: { value: VendorKind | ""; label: string }[] = [
  ...VENDOR_KINDS.map((k) => ({ value: k as VendorKind | "", label: VENDOR_KIND_LABEL[k] })),
  { value: "" as VendorKind | "", label: VENDOR_KIND_LABEL.none },
];

/** What the umbrella word means, said the one way, wherever a box takes any of the three. */
export const VENDOR_MEANS = "A vendor is anyone you buy from or hire: a supplier, a sub, or a brand.";

/**
 * EVERY DOOR THAT ASKS "WHICH COMPANY?", AND THE WORD IT USES.
 *
 * Exhaustive by type: a new door does not compile until it is listed here, which is what stops a
 * seventh box inventing a seventh word. `label` is Title Case (Erik's law); `placeholder` is a shape
 * and never a real company's name.
 */
export type CompanyField =
  /** A purchase order: who the order goes to. purchase_orders.vendor. */
  | "purchase_order"
  /** A line on a job's material list, and its column on the printed list. material_list_items.vendor. */
  | "material_line"
  /** A shop-stock item: where it is bought. inventory_items.vendor. */
  | "stock_item"
  /** A dropped or hand-filed receipt or bill: the store on the paper. */
  | "paperwork_line"
  /** A price-book item's own buy-from, and its column on the book. price_list_items.supplier. */
  | "price_item"
  /** One company's own cost and sell on a price-book item: any of the three kinds.
   *  price_list_item_options.vendor. */
  | "price_item_option"
  /** A card on the Vendors tab: the company's name, whichever kind it is. price_list_vendors.name. */
  | "vendor_card"
  /** A supplier's bill or receipt, on the Bills door and the job's own bills. bills.supplier. */
  | "bill"
  /** The + cost sheet (Snap A Cost, Type It In) filing against a JOB or into shop stock: materials,
   *  bought somewhere. Same column as `bill`, same word. */
  | "job_cost"
  /** The same sheet with no job — a cost of running the business — where the company is as likely a
   *  landlord or an insurer as a supply house. */
  | "business_cost"
  /** A cost that comes round every month, which is often nobody's supplier: rent, insurance. */
  | "recurring_cost";

export const COMPANY_FIELD: Record<CompanyField, { label: string; placeholder?: string; help?: string }> = {
  purchase_order: { label: "Supplier", placeholder: "Who you're buying from" },
  material_line: { label: "Supplier", placeholder: "Supplier" },
  stock_item: { label: "Supplier" },
  paperwork_line: { label: "Supplier", placeholder: "The store on the paper" },
  price_item: { label: "Supplier" },
  price_item_option: { label: "Vendor", help: VENDOR_MEANS },
  vendor_card: { label: "Vendor", placeholder: "A supplier, a sub or a brand", help: VENDOR_MEANS },
  bill: { label: "Supplier" },
  job_cost: { label: "Supplier", placeholder: "Who you bought it from" },
  /** NOT "Supplier": the same reason recurring_cost isn't. See costCompanyField below. */
  business_cost: { label: "Who You Pay", placeholder: "e.g. the landlord" },
  /** NOT "Vendor": a landlord is nobody's vendor, and "Supplier" would be a lie about rent. */
  recurring_cost: { label: "Who You Pay", placeholder: "e.g. the landlord" },
};

/**
 * THE + COST SHEET'S WORD, DECIDED BY WHERE THE COST LANDS — never at the door.
 *
 * The one "add a cost" (components/quick-cost-button) files three things through the same box: a
 * cost on a JOB (materials, bought at a supply house), a SHOP STOCK purchase (bought somewhere too),
 * and a BUSINESS COST with no job — rent, insurance, a licence — where the company is as likely a
 * landlord as a supply house. So this is NOT a blanket relabel to Supplier: "Supplier" would be a
 * lie about rent, which is the same reason recurring_cost says "Who You Pay". The sheet asks the
 * question under the word that fits what is being filed, and the choosing happens here so both of
 * its sheets cannot drift apart from each other or from the Bills door they write the same column as.
 */
export function costCompanyField(forABusinessCost: boolean): CompanyField {
  return forABusinessCost ? "business_cost" : "job_cost";
}

/**
 * The label for a door: the word, plus the mark that says whether the box has to be filled. `true`
 * is the asterisk every required field in the app carries; "optional" says so in the one wording,
 * for a box (a business cost's) that may be left blank and is not refused for it.
 */
export function companyLabel(field: CompanyField, required: boolean | "optional" = false): string {
  const { label } = COMPANY_FIELD[field];
  if (required === "optional") return `${label} (Optional)`;
  return required ? `${label} *` : label;
}
