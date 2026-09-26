import { supplierNameSet } from "@/lib/invoice-math";
import { readAllPages } from "@/lib/read-all-pages";

/**
 * THE ORG'S SUPPLIER NAMES, for the customer-copy scrub (customerLineWords, audit v994 PL1).
 *
 * Every spelling a supplier goes by in the org's books: the free-text bills.supplier (CED alone is
 * five spellings), purchase_orders.vendor, and the supplier accounts and their aliases (0270). The
 * SQL twin reads the same four in customer_line_words (0315).
 *
 * `orgId`: the caller is the SERVICE ROLE (the portal, /i), which RLS does not narrow, so every read
 * is pinned to that org by hand. A signed-in office caller leaves it out and RLS scopes the reads.
 *
 * A read that fails leaves its names out rather than failing the page: the scrub still rewords
 * every row the importer wrote untouched (by its key) and every row that carries its paper's number,
 * and the customer's page must not go blank because a names read hiccuped.
 */
export async function fetchSupplierNames(supabase: any, orgId?: string | null): Promise<ReadonlySet<string>> {
  return (await readSupplierNames(supabase, orgId)).names;
}

/**
 * The same four reads, saying whether any of them failed. THE CUSTOMER'S DOCUMENT uses this one
 * (readInvoiceDocumentProps): a bill whose names read failed is not drawn at all, because the one
 * line it could get wrong is a line that names a supplier to the customer. Every other caller keeps
 * fetchSupplierNames' lenient answer.
 */
export async function readSupplierNames(
  supabase: any,
  orgId?: string | null,
): Promise<{ names: ReadonlySet<string>; failed: boolean }> {
  // EVERY ROW, PAGED (audit v1018 links-docs-4). A plain select stops at PostgREST's row cap with no
  // error, so past 1,000 bills a supplier named only on the later ones would be missing from the
  // set and print on the customer's page. customer_line_words (the SQL twin) reads every row; so
  // does this. By id, so the pages neither repeat nor skip a row.
  const every = (table: string, col: string) =>
    readAllPages<Record<string, unknown>>((from, to) => {
      const q = supabase.from(table).select(col);
      return (orgId ? q.eq("org_id", orgId) : q).order("id").range(from, to);
    });
  let failed = false;
  const reads = await Promise.all([
    every("bills", "supplier"),
    every("purchase_orders", "vendor"),
    every("supplier_accounts", "name"),
    every("supplier_aliases", "alias"),
  ]).catch(() => {
    failed = true;
    return [] as { rows: Record<string, unknown>[]; error: unknown }[];
  });
  const names: unknown[] = [];
  for (const r of reads) {
    if (r.error) failed = true;
    for (const row of r.rows) names.push(...Object.values(row));
  }
  return { names: supplierNameSet(names), failed };
}
