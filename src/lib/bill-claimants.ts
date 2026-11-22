import { dbError } from "@/lib/db-error";

/**
 * WHO ALREADY BILLS THIS SUPPLIER'S BILL (cn-v1181: one reading, shared). Every live invoice line
 * that bills the bill, or the purchase order it delivered: by the source_ids claim (0255) or the
 * older bill:/po: import key, on any invoice that is not void. A draft is listed with its status, so
 * each door decides what a draft means to it.
 *
 * It lived inside bills/receipt-billing-actions.ts (a "use server" file, where every export is a
 * public endpoint) and was copied into the credit-memo door; one copy here is what Put the Rest in
 * Stock, Kept / Returned, the Bill switch, the credit memo and Read Again all ask. A failed read is
 * an error, never "no one bills it". It reads on the caller's client, as the doors did.
 */
export type BillClaimant = { invoiceId: string; number: string; status: string; edited: boolean; via: "bill" | "po" };

const one = <T,>(x: T | T[] | null | undefined): T | null => (Array.isArray(x) ? (x[0] ?? null) : (x ?? null));

export async function readBillClaimants(
  supabase: any,
  billId: string,
  poId: string | null,
): Promise<{ rows: BillClaimant[] } | { error: string }> {
  if (!billId) return { error: "Couldn't tell which bill this is. Reload and try again." };
  const cols = "id, edited, invoice_id, invoices!inner(id, invoice_number, status)";
  const reads: { via: "bill" | "po"; q: any }[] = [
    { via: "bill", q: supabase.from("invoice_items").select(cols).contains("source_ids", [billId]).neq("invoices.status", "void").limit(200) },
    { via: "bill", q: supabase.from("invoice_items").select(cols).like("import_key", `bill:${billId}%`).neq("invoices.status", "void").limit(200) },
  ];
  if (poId) {
    reads.push(
      { via: "po", q: supabase.from("invoice_items").select(cols).contains("source_ids", [poId]).neq("invoices.status", "void").limit(200) },
      { via: "po", q: supabase.from("invoice_items").select(cols).like("import_key", `po:${poId}%`).neq("invoices.status", "void").limit(200) },
    );
  }
  const answers = await Promise.all(reads.map((r) => r.q));
  const rows: BillClaimant[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < answers.length; i++) {
    const { data, error } = answers[i] as { data: any[] | null; error: unknown };
    if (error) return { error: dbError(error) };
    for (const it of data ?? []) {
      if (!it?.id || seen.has(String(it.id))) continue;
      seen.add(String(it.id));
      const inv = one(it.invoices) ?? ({} as any);
      rows.push({
        invoiceId: String(it.invoice_id ?? inv.id),
        number: String(inv.invoice_number || "An invoice"),
        status: String(inv.status ?? ""),
        edited: it.edited === true,
        via: reads[i].via,
      });
    }
  }
  return { rows };
}

/** The first claimant that went to the customer (not a draft; void is never read), or null. */
export function sentClaimant(rows: BillClaimant[]): BillClaimant | null {
  return rows.find((c) => c.status !== "draft") ?? null;
}

/**
 * A LINE A CUSTOMER WAS ALREADY BILLED FOR IS NOT CHANGED ON THE SUPPLIER'S BILL (skeptic #84, S2).
 * Marking it returned there would take it off nothing the customer holds, and the credit memo would
 * then close it with no credit to the customer. The supplier's credit memo, filed with this bill, is
 * the way: a line still billing when it comes puts the return on the customer's next invoice.
 */
export function alreadyBilledSentence(invoiceNumber: string, what: string): string {
  return `${invoiceNumber} has gone to the customer and already bills ${what}, so it can't be changed here. When the supplier's credit memo comes, file it with this bill: the return goes on the customer's next invoice. Nothing was changed.`;
}
