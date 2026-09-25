import { kindFromPriceBook, priceBookUnits } from "@/lib/invoice-math";

/**
 * THE ORG'S PRICE BOOK, READ FOR ONE QUESTION: which codes does it sell, and in what unit (0342).
 *
 * Every server door that puts a line on an invoice without being told what the line is (a line
 * typed as "TM870LA — ...", Nort's add line, the estimate's copy) asks this, so a price-book line is
 * filed under Materials however it arrived (kindFromPriceBook, the rule 0342's backfill ran on the
 * lines already out). Archived items count: a line billed from a code the office has since retired
 * is still that code's line.
 *
 * Pinned to the caller's org by an explicit filter as well as RLS (three orgs, one database). A
 * failed read is an empty book: the line then says nothing and is read by its words, as before.
 */
export async function readPriceBookUnits(supabase: any, orgId: string | null | undefined): Promise<Map<string, string | null>> {
  if (!orgId) return new Map();
  try {
    const { data, error } = await supabase.from("price_list_items").select("code, unit").eq("org_id", orgId).not("code", "is", null).limit(10000);
    if (error || !Array.isArray(data)) return new Map();
    return priceBookUnits(data as { code: string | null; unit: string | null }[]);
  } catch {
    return new Map();
  }
}

/** What each line is, when its leading code is in the book: the kind, else null (nobody knows). */
export function kindsFromPriceBook<T extends { description?: string | null; unit?: string | null }>(
  lines: readonly T[],
  book: ReadonlyMap<string, string | null>,
): ("labor" | "materials" | null)[] {
  return lines.map((l) => kindFromPriceBook(l, book));
}
