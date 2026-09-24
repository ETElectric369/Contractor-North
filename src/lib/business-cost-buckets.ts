/**
 * THE SIX BUSINESS-COST BUCKETS (Erik approved the names, 2026-09-24).
 *
 * A cost with no job is a business cost, and it goes in exactly one of these. Before this list
 * there were six vocabularies for the same idea: Organize had seven categories, the Bills page
 * carried two hand-copied versions of them, the Add Cost sheet had its own nine, the Organize AI
 * prompt spelled out a fifth, and a Recurring expense took whatever anybody typed. A cost filed
 * as "Fuel" in one door and "Vehicle" in another is the same gas counted in two rows of a report,
 * so every door that files a cost with no job reads THIS list and nothing else.
 *
 * Job-material categories (Materials, Receipt, the bill-line categories) are a different thing
 * and are not touched by this module.
 */
export const BUSINESS_COST_BUCKETS = [
  "Gas & Truck",
  "Tools & Supplies",
  "Phone & Office",
  "Insurance & Licenses",
  "Fees",
  "Other",
] as const;

export type BusinessCostBucket = (typeof BUSINESS_COST_BUCKETS)[number];

/**
 * THE BUCKETS THE ORGANIZE READER MAY FILE ON ITS OWN: every one but Fees.
 *
 * A supplier's late interest or service charge is already on the supplier's own paperwork (CED's
 * service-charge documents, shown as Late interest on the supplier card). If the reader could also
 * auto-file that PDF as a Fees bill, the same charge would be counted twice, and nothing would say
 * so. So the reader never picks Fees; a fee-shaped paper goes to Needs Review and a person decides.
 * A person can still file anything as Fees by hand.
 */
export const AUTO_FILE_BUCKETS: readonly BusinessCostBucket[] = BUSINESS_COST_BUCKETS.filter((b) => b !== "Fees");

export function isBusinessCostBucket(value: unknown): value is BusinessCostBucket {
  return typeof value === "string" && (BUSINESS_COST_BUCKETS as readonly string[]).includes(value);
}

/**
 * The old category words and the bucket each one belongs in. The same table is written out in
 * supabase/migrations/0285_business_cost_buckets.sql, which moves the stored rows; the test pins
 * this side so the two cannot quietly disagree.
 */
const LEGACY_TO_BUCKET: Record<string, BusinessCostBucket> = {
  fuel: "Gas & Truck",
  vehicle: "Gas & Truck",
  // The obvious one-word slips a reader makes (review): without them a confident gas receipt read
  // as "Gas" auto-filed under Other and nothing said so.
  gas: "Gas & Truck",
  truck: "Gas & Truck",
  "shop supplies": "Tools & Supplies",
  tools: "Tools & Supplies",
  supplies: "Tools & Supplies",
  office: "Phone & Office",
  phone: "Phone & Office",
  insurance: "Insurance & Licenses",
  license: "Insurance & Licenses",
  licenses: "Insurance & Licenses",
};

/**
 * Which bucket a stored or suggested category belongs in. A bucket name maps to itself (any
 * letter case), the six old Organize words map to their bucket, and anything else, blank
 * included, is Other. It always answers with a member of the list, which is what makes it safe
 * to put in front of a write.
 */
export function bucketOf(category: string | null | undefined): BusinessCostBucket {
  const key = String(category ?? "").trim().toLowerCase();
  if (!key) return "Other";
  const exact = BUSINESS_COST_BUCKETS.find((b) => b.toLowerCase() === key);
  if (exact) return exact;
  return LEGACY_TO_BUCKET[key] ?? "Other";
}

/**
 * DOES THIS PAPER READ LIKE A SUPPLIER'S LATE OR SERVICE CHARGE? The second chance at the rule
 * above, because the first one is a prompt and a prompt is a request, not a mechanism. Only ever
 * used to hold a paper back from auto-filing (it goes to Needs Review), so a false yes costs a
 * person one look and a false no is what the prompt is for.
 */
export function looksLikeSupplierFee(...texts: (string | null | undefined)[]): boolean {
  const text = texts.filter(Boolean).join(" ");
  return /\b(finance|service|late)\s+charges?\b|\blate\s+fees?\b|\binterest\s+charges?\b|\bpast\s+due\s+interest\b/i.test(text);
}
