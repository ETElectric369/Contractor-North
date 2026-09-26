import { kindFromPriceBook, priceBookUnits, type PriceBookFacts } from "@/lib/invoice-math";
import { reportError } from "@/lib/observe";

/**
 * THE ORG'S PRICE BOOK, READ FOR ONE QUESTION: which codes does it sell, in what unit, and bought
 * from whom (0342).
 *
 * Every server door that puts a line on an invoice without being told what the line is (a line
 * typed as "TM870LA — ...", Nort's add line, the estimate's copy with its "[CODE]") asks this, so a part from the book
 * (an item with a supplier) is filed under Materials however it arrived, and a book item sold by the
 * hour under Labor (kindFromPriceBook, the rule 0342's backfill ran on the lines already out). A
 * book item that says neither (installed work, a job-cost code) leaves the line saying nothing.
 * Archived items count: a line billed from a code the office has since retired is still that code's
 * line.
 *
 * Pinned to the caller's org by an explicit filter as well as RLS (three orgs, one database). A
 * failed read is an empty book: the line then says nothing and is read by its words, as before.
 * It is logged (audit v1018 money-5), so a line filed under Other because the book could not be read
 * is a known event, never a silent one.
 */
export async function readPriceBookUnits(supabase: any, orgId: string | null | undefined): Promise<Map<string, PriceBookFacts>> {
  if (!orgId) return new Map();
  try {
    const { data, error } = await supabase.from("price_list_items").select("code, unit, supplier").eq("org_id", orgId).not("code", "is", null).limit(10000);
    if (error || !Array.isArray(data)) {
      reportError("readPriceBookUnits", error ?? new Error("price book read returned no rows array"), { orgId });
      return new Map();
    }
    return priceBookUnits(data as { code: string | null; unit: string | null; supplier: string | null }[]);
  } catch (e) {
    reportError("readPriceBookUnits", e, { orgId });
    return new Map();
  }
}

/** What each line is, when a code it names (its lead or a bracketed "[CODE]") is in the book: the kind, else null (nobody knows). */
export function kindsFromPriceBook<T extends { description?: string | null; unit?: string | null }>(
  lines: readonly T[],
  book: ReadonlyMap<string, PriceBookFacts>,
): ("labor" | "materials" | null)[] {
  return lines.map((l) => kindFromPriceBook(l, book));
}
