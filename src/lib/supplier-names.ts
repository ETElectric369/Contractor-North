import { supplierNameSet } from "@/lib/invoice-math";

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
  const scoped = (q: any) => (orgId ? q.eq("org_id", orgId) : q);
  let failed = false;
  const reads = await Promise.all([
    scoped(supabase.from("bills").select("supplier")),
    scoped(supabase.from("purchase_orders").select("vendor")),
    scoped(supabase.from("supplier_accounts").select("name")),
    scoped(supabase.from("supplier_aliases").select("alias")),
  ]).catch(() => {
    failed = true;
    return [] as { data?: Record<string, unknown>[] | null; error?: unknown }[];
  });
  const names: unknown[] = [];
  for (const r of reads) {
    if (r?.error) failed = true;
    for (const row of r?.data ?? []) names.push(...Object.values(row));
  }
  return { names: supplierNameSet(names), failed };
}
