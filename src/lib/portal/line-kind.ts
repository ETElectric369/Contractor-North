/**
 * LABOR, MATERIALS, AND WHAT ELSE A LINE IS, FOR THE CUSTOMER'S PAGES. Pure.
 *
 * Erik, 2026-09-24, looking at Andrew's portal: "there is no simple breakdown separating time and
 * material right at the top, its all mixed in", and "all the sections should also have a clearer
 * separation of labor and materials". Every figure on the portal (the money card, each stretch,
 * each day, the bill) is split by the one rule here, so the four places cannot disagree.
 *
 * A LINE'S KIND IS WHAT IT STORED FIRST. What the importer stored on it (import_source) or what its
 * bill is (a deposit bill's own lines):
 *   labor         -> Labor            (the time importer)
 *   costs         -> Materials        (bills, orders, receipts, returns)
 *   change_orders -> Change Orders
 *   quote         -> From The Estimate (lines copied from an estimate, which can be either)
 *   milestone     -> Contract Payments (a scheduled draw on a fixed-price contract)
 *   draw_credit   -> Credits           (the deposit and earlier bills coming back off)
 *   a deposit bill's own lines -> Deposit
 * A LINE TYPED BY HAND reads by the same rule the /i Cost Breakdown reads (handLineKind in
 * invoice-math), so the portal and the customer's bill can never file one line in two places
 * (audit of this split, 2026-09-24: INV-059's "Labor - Erik" was Labor on /i and Other here, and
 * J-010 listed a line named "Materials" under Other beneath "Materials $0.00"). Billed in hours is
 * labor (Erik, 8/18); "Labor - Brian", "Labor: Erik", "Erik Labor" are labor; "Materials - CED",
 * "Material: wire, boxes" and "Materials" are materials; "Less previous billings" is a credit.
 * A typed line the words do not settle ("Emergency service call", "10/3 romex") is Other: shown,
 * never guessed at. So is anything the rule does not know yet (a new importer).
 */
import { handLineKind, isHoursUnit } from "@/lib/invoice-math";

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

/** Is this unit hours? (One rule, in invoice-math; re-exported for the portal's callers.) */
export { isHoursUnit };

/** Which group a bill's line belongs to. `invoiceKind` is the kind of the bill the line is on. */
export function lineGroup(
  line: { import_source?: string | null; unit?: string | null; description?: string | null },
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
    const worded = handLineKind(line);
    if (worded) return worded;
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
export function sectionLines<T extends { import_source?: string | null; unit?: string | null; description?: string | null; line_total?: unknown }>(
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
