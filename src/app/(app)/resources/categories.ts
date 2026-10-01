/** The Resources categories, in the order the form lists them. Its own module (not the "use client"
 *  manager) so the server can read it too: Fill From Their Site lets the model pick one of these.
 *
 *  RESOURCES IS THE ONE HOME FOR THE PEOPLE A JOB ANSWERS TO (W2-13): building departments,
 *  inspectors, permit portals, utilities, the fire marshal, engineers. The crew reads it too (a tech
 *  needs the inspector's number). Suppliers and subcontractors are the company's vendors, with prices,
 *  so they live in Price List › Vendors, office only: "Supplier / Distributor" is off this list. A row
 *  that already has it keeps it (and still groups under it); only a new one can't pick it. */
export const RESOURCE_CATEGORIES: readonly string[] = [
  "Building Department",
  "Inspector",
  "Permit Portal",
  "Utility",
  "Fire / AHJ",
  "Engineer",
  "Other",
];

/**
 * The Category picker's options for a contact whose category is `current`: the list, and, when a
 * contact's category is from before the list changed (Supplier / Distributor, or a word Nort saved),
 * that category too, as its current pick and disabled. So a save never quietly swaps it for the first
 * one on the list, and nobody can pick it for another contact.
 */
export function categoryChoices(current: string | null | undefined): { value: string; disabled: boolean }[] {
  const list = RESOURCE_CATEGORIES.map((value) => ({ value, disabled: false }));
  const now = String(current ?? "");
  return now && !RESOURCE_CATEGORIES.includes(now) ? [...list, { value: now, disabled: true }] : list;
}

/** Where a supplier or a subcontractor goes instead, said the same way by the form and the refusal. */
export const SUPPLIERS_LIVE_IN_VENDORS = "Suppliers and subcontractors live in Price List › Vendors.";

/** The Vendors tab of the Price List (its tab id is "options"). */
export const VENDORS_HREF = "/price-list?tab=options";

/**
 * Is this a supplier's or a subcontractor's category? The old list's "Supplier / Distributor", and
 * the same thing typed another way (Nort's category is free text: "Supplier", "Vendors",
 * "Subcontractor"), matched as a word, so "Utility" or "Other" never is.
 */
export function isSupplierCategory(category: string | null | undefined): boolean {
  return /\b(suppliers?|distributors?|vendors?|sub-?contractors?)\b/i.test(String(category ?? ""));
}
