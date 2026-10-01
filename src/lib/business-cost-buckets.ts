/**
 * THE BUSINESS-COST BUCKETS (Erik approved six names 2026-09-24; on 2026-09-27 Fuel became its own
 * and Gas & Truck became Auto: "so the Gas & Truck turns into Auto and Fuel is separate, right?").
 *
 * A cost with no job is a business cost, and it goes in exactly one of these. Before this list
 * there were six vocabularies for the same idea: Organize had seven categories, the Bills page
 * carried two hand-copied versions of them, the Add Cost sheet had its own nine, the Organize AI
 * prompt spelled out a fifth, and a Recurring expense took whatever anybody typed. A cost filed
 * as "Fuel" in one door and "Vehicle" in another is the same gas counted in two rows of a report,
 * so every door that files a cost with no job reads THIS list and nothing else.
 *
 * FUEL IS ITS OWN BUCKET, for every company: it is the cost a contractor watches week to week, so
 * Analytics gives it a line of its own and a bar of its own, and it is never folded in with the
 * truck's other costs. Which HALF of the profit and loss it sits in is BUCKET_SECTION's answer
 * below, and since 2026-09-30 that is Overhead, first of them. Auto is everything else the truck
 * costs (parts, repairs, tires, registration, a truck payment). Migration 0362 moved every stored
 * "Gas & Truck" to Auto, and bucketOf reads one still stored (before 0362, or typed by hand) as Auto.
 *
 * Job-material categories (Materials, Receipt, the bill-line categories) are a different thing
 * and are not touched by this module.
 */
export const BUSINESS_COST_BUCKETS = [
  "Fuel",
  "Auto",
  "Tools & Supplies",
  "Phone & Office",
  "Insurance & Licenses",
  "Fees",
  "Other",
] as const;

export type BusinessCostBucket = (typeof BUSINESS_COST_BUCKETS)[number];

/** The two halves of the costs on a profit and loss: Cost of Goods Sold (COGS) and Overhead. */
export type PnlSection = "cogs" | "overhead";

/**
 * WHERE EACH BUCKET SITS ON THE PROFIT AND LOSS. The accounting industry's own test: if the cost
 * disappears when you stop doing jobs, it is COGS; if it keeps running whether you have work or
 * not, it is Overhead.
 *
 * FUEL IS OVERHEAD (Erik, 2026-09-30: "lets move fuel to overhead above Auto and take out of COGS").
 * It sat in COGS for two days (his 2026-09-28 call, on the reasoning that nearly every fill-up is
 * within a few days of job work) and he moved it: the truck burns fuel whether or not there is work
 * in the book. It is FIRST in the list, so it reads above Auto wherever the Overhead lines are
 * drawn in the list's own order, and it keeps its own bar on Money by Month (money-chart.ts) while
 * the Overhead bar carries the whole total, fuel included — his words: "it could show fuel on its
 * own then a total overhead on the overhead button". So COGS is now the job-side lines only
 * (materials and bills, stock, crew pay and crew mileage) and every bucket is Overhead.
 *
 * THIS IS THE ONE PLACE THE SPLIT IS WRITTEN: every profit and loss the app draws (the Owner's Draw
 * card, Money by Month, the accountant's Summary, Nort's words) reads it through
 * analytics/profit-and-loss.ts, never an `if (bucket === "Fuel")` of its own. A Record, so a bucket
 * added to the list above does not compile until someone says which half it is in.
 */
export const BUCKET_SECTION: Record<BusinessCostBucket, PnlSection> = {
  Fuel: "overhead",
  Auto: "overhead",
  "Tools & Supplies": "overhead",
  "Phone & Office": "overhead",
  "Insurance & Licenses": "overhead",
  Fees: "overhead",
  Other: "overhead",
};

/** The buckets in one half of the profit and loss, in the list's own order. */
export function bucketsIn(section: PnlSection): BusinessCostBucket[] {
  return BUSINESS_COST_BUCKETS.filter((b) => BUCKET_SECTION[b] === section);
}

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

/** The bucket Fuel and Auto were one of, 2026-09-24 to 2026-09-27 (0285 to 0362). */
export const LEGACY_GAS_AND_TRUCK = "Gas & Truck";

/** Is this the name of a bucket, spelled exactly, now or before 0362 ("Gas & Truck")? Add Business
 *  Cost saves a blank Where as the bucket's own name, so a supplier field can hold one. */
export function namesABucket(value: unknown): boolean {
  return isBusinessCostBucket(value) || value === LEGACY_GAS_AND_TRUCK;
}

/**
 * The old category words and the bucket each one belongs in. supabase/migrations/0285 moved the
 * stored rows onto the first six buckets (fuel and vehicle both into Gas & Truck), and 0362 renamed
 * Gas & Truck to Auto; the test pins this table against both files so they cannot quietly disagree.
 * A fuel word has its own bucket now: the rows 0285 moved before Fuel existed are Auto (0362 cannot
 * tell a fill-up from a repair), and a person moves any fill-up among them to Fuel.
 */
const LEGACY_TO_BUCKET: Record<string, BusinessCostBucket> = {
  // The bucket before Fuel was its own: a row still stored with it is Auto until 0362 renames it.
  [LEGACY_GAS_AND_TRUCK.toLowerCase()]: "Auto",
  vehicle: "Auto",
  truck: "Auto",
  // The obvious one-word slips a reader makes (review): without them a confident gas receipt read
  // as "Gas" auto-filed under Other and nothing said so.
  gas: "Fuel",
  gasoline: "Fuel",
  diesel: "Fuel",
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
 * letter case), the old Organize words map to their bucket, a stored "Gas & Truck" is Auto, and
 * anything else, blank included, is Other. It always answers with a member of the list, which is what makes it safe
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
 * THE SAME RULE, AS A QUERY: a regular expression, for PostgREST's `imatch` (Postgres `~*`, which
 * ignores letter case), that matches every stored category bucketOf puts in this bucket: its own
 * name and each old word for it, with any spaces around them. A read that asks the database for
 * one bucket uses this rather than `eq`, because `eq` is exact and a category nobody bucketed
 * ("gas", "fuel") is one bucketOf counts. Not for Other, which is everything else.
 */
export function bucketCategoryPattern(bucket: Exclude<BusinessCostBucket, "Other">): string {
  const words = [bucket.toLowerCase(), ...Object.keys(LEGACY_TO_BUCKET).filter((w) => LEGACY_TO_BUCKET[w] === bucket)];
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `^\\s*(${escaped.join("|")})\\s*$`;
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
