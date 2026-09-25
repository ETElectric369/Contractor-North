/**
 * LABOR, MATERIALS, AND WHAT ELSE A LINE IS, FOR THE CUSTOMER'S PAGES. Pure.
 *
 * Erik, 2026-09-24, looking at Andrew's portal: "there is no simple breakdown separating time and
 * material right at the top, its all mixed in", and "all the sections should also have a clearer
 * separation of labor and materials". Every figure on the portal (the money card, each stretch,
 * each day, the bill) is split by the one rule here, so the four places cannot disagree.
 *
 * THE RULE READS WHAT THE LINE SAYS IT IS, NEVER ITS WORDING. A line's kind is what the importer
 * stored on it (import_source) or what its bill is (a deposit bill's own lines):
 *   labor         -> Labor            (the time importer)
 *   costs         -> Materials        (bills, orders, receipts, returns)
 *   change_orders -> Change Orders
 *   quote         -> From The Estimate (lines copied from an estimate, which can be either)
 *   milestone     -> Contract Payments (a scheduled draw on a fixed-price contract)
 *   draw_credit   -> Credits           (the deposit and earlier bills coming back off)
 *   a deposit bill's own lines -> Deposit
 * A line typed by hand carries no kind, and goes under Other, with one exception the office itself
 * declared: a line billed in HOURS (its unit, a stored field the office chose) is labor, whoever
 * typed it (Erik, 8/18, groupInvoiceLines: "a line sold by the hour is labor no matter how it was
 * worded"). The description is never read: "Labor - extra hour" billed as 1 ea is Other.
 * Anything the rule does not know yet (a new importer) is Other too: shown, never dropped.
 */

export type LineGroup = "labor" | "materials" | "change_orders" | "estimate" | "contract" | "deposit" | "credit" | "tax" | "other";

/** The order the groups are listed in, everywhere: labor first, materials second, the rest after. */
export const LINE_GROUP_ORDER: readonly LineGroup[] = [
  "labor",
  "materials",
  "change_orders",
  "estimate",
  "contract",
  "deposit",
  "credit",
  "tax",
  "other",
];

/** The heading each group reads under (Title Case, plain words). */
export const LINE_GROUP_LABEL: Readonly<Record<LineGroup, string>> = {
  labor: "Labor",
  materials: "Materials",
  change_orders: "Change Orders",
  estimate: "From The Estimate",
  contract: "Contract Payments",
  deposit: "Deposit",
  credit: "Credits",
  tax: "Sales Tax",
  other: "Other",
};

const HOURS_UNIT = /^(hr|hrs|hour|hours|man-?hours?)$/;

/** Is this unit hours? (The unit box, trimmed and lower-cased; "hr", "hrs", "hours", "man-hours".) */
export function isHoursUnit(unit: string | null | undefined): boolean {
  return HOURS_UNIT.test(String(unit ?? "").trim().toLowerCase());
}

/** Which group a bill's line belongs to. `invoiceKind` is the kind of the bill the line is on. */
export function lineGroup(
  line: { import_source?: string | null; unit?: string | null },
  invoiceKind?: string | null,
): LineGroup {
  const src = typeof line.import_source === "string" ? line.import_source : null;
  switch (src) {
    case "labor":
      return "labor";
    case "costs":
      return "materials";
    case "change_orders":
      return "change_orders";
    case "quote":
      return "estimate";
    case "milestone":
      return "contract";
    case "draw_credit":
      return "credit";
  }
  if (src === null || src === "") {
    if (invoiceKind === "deposit") return "deposit";
    if (isHoursUnit(line.unit)) return "labor";
  }
  return "other";
}

/** Dollars (number or numeric string) to integer cents; non-numbers are 0. */
function cents(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export type LineSection<T> = { group: LineGroup; label: string; lines: T[]; subtotal: number };

/**
 * A bill's lines under their headings, in LINE_GROUP_ORDER, each keeping its own order inside its
 * group; only groups that have a line appear. Subtotals are summed in whole cents, so the sections
 * add up to the lines exactly.
 */
export function sectionLines<T extends { import_source?: string | null; unit?: string | null; line_total?: unknown }>(
  lines: readonly T[],
  invoiceKind?: string | null,
): LineSection<T>[] {
  const by = new Map<LineGroup, { lines: T[]; c: number }>();
  for (const l of lines ?? []) {
    const g = lineGroup(l, invoiceKind);
    const cur = by.get(g) ?? { lines: [], c: 0 };
    cur.lines.push(l);
    cur.c += cents(l.line_total);
    by.set(g, cur);
  }
  return LINE_GROUP_ORDER.filter((g) => by.has(g)).map((g) => ({
    group: g,
    label: LINE_GROUP_LABEL[g],
    lines: by.get(g)!.lines,
    subtotal: by.get(g)!.c / 100,
  }));
}
