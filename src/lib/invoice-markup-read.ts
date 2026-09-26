import "server-only";

import { reportError } from "@/lib/observe";
import type { BillLine } from "@/lib/bill-itemisation";
import { markupReading, type InvoiceCostLine, type MarkupReading, type StockTakeSample } from "@/lib/invoice-markup";
import { readJobStock } from "@/lib/stock-billing";

/**
 * THE READS BEHIND "WHAT IS THIS INVOICE PRICED AT", IN ONE PLACE (2026-09-25).
 *
 * Two doors ask the question. The materials importer asks it when it brings an existing draft up
 * to date (keepInvoiceMarkup), so a % the office set is not put back to the customer's default.
 * The invoice page asks it to seed the % box beside Materials from Costs. They used to disagree:
 * the importer read the lines and knew INV-078 was at 11%, while the page seeded the box from the
 * customer's level and showed 15 - and the box then sent that 15 back the moment it was touched.
 *
 * Both now call this, and markupReading (lib/invoice-markup) holds the rule. The importer hands
 * over the bills, orders and receipt lines it has already read (so the markup it keeps is read off
 * the same snapshot it prices); the page lets this read them, with the importer's own filters -
 * the job's bills minus set-aside duplicates (0271), every order on the job, and each bill's lines
 * with the two columns that decide what of them bills (0268 billable, 0272 billed_amount).
 *
 * Not a "use server" file: nothing here is callable from a browser. The caller's client decides
 * whose rows these are (RLS for a signed-in person).
 */

type Db = { from: (t: string) => any };

export type InvoiceMarkupSources = {
  bills: readonly { id: string; amount: unknown }[];
  pos: readonly { id: string; total: unknown }[];
  linesByBill: ReadonlyMap<string, BillLine[]>;
  /** The job's takes from stock, when the caller already read them (the importer). Absent, they
   *  are read here - and only when a line of this invoice is a take's (key stock:<group>). */
  takes?: readonly StockTakeSample[];
};

export type InvoiceMarkupRead = { ok: true; reading: MarkupReading } | { ok: false; error: string };

const READ_FAILED = "Couldn't read this invoice's materials lines just now, so nothing was imported - try again in a moment.";

/** A push deploys before its migration runs (cn-v576): a select naming a column that is not there
 *  yet fails the whole read. Exactly that shape, and nothing else, so a real error still surfaces. */
function isMissingColumn(err: unknown, column: string): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  const msg = String((err as { message?: string })?.message ?? "");
  return code === "42703" || code === "PGRST204" || (msg.includes(column) && /does not exist|could not find/i.test(msg));
}

/**
 * A BILL'S LINES, WITH THE ONE COLUMN THAT DECIDES WHO PAYS FOR THEM.
 *
 * `billable` (0268) has to be in the projection or the importer cannot tell Erik's Smartwater from
 * his wire - and the projection law says it every time: the failure is always a select list. The
 * retry is the cn-v576 deploy-window shape (a push lands before its migration runs, and a select
 * naming a column that isn't there yet fails the WHOLE read, which would take the materials
 * importer down for those minutes). Falling back leaves `billable` undefined on every row, which
 * the arithmetic reads as billable - exactly the behaviour of the minute before 0268.
 *
 * THE PROJECTION LAW, ON THE ONE READ THAT DECIDES WHAT A CUSTOMER PAYS (all three reviewers of
 * cn-v964). This is the ONLY feeder of billItemisation in production. `billed_amount` (0272) was
 * missing from it, so every split Erik made was invisible here: the Bills card would say "$13.00
 * of it billed to this job" and the invoice would import $135.00 for the whole box. It rides on the
 * same rung as `billable` because both are the receipt line's states and a database missing one is
 * already in the fallback case.
 *
 * A FAILED READ IS NOT AN EMPTY RECEIPT (audit 8), AND SINCE 0268 IT IS A MONEY QUESTION. A lost
 * read would silently re-charge the customer for the lines Erik switched off, so the caller
 * refuses instead. (Moved here from billing/actions.ts so the % box reads receipts the same way.)
 */
export async function readBillLines(supabase: Db, billIds: string[]): Promise<{ lines: any[]; error?: string }> {
  if (!billIds.length) return { lines: [] };
  const read = (withBillable: boolean) =>
    supabase
      .from("bill_line_items")
      .select(`id, bill_id, description, quantity, unit_price, amount, category, sort_order${withBillable ? ", billable, billed_amount" : ""}`)
      .in("bill_id", billIds)
      .order("sort_order");
  let res = await read(true);
  if (res.error && isMissingColumn(res.error, "billable")) res = await read(false);
  if (res.error) {
    reportError("materialsImport.billLines", res.error, { bills: billIds.length });
    return { lines: [], error: "Couldn't read this job's receipts just now, so nothing was imported - try again in a moment." };
  }
  return { lines: (res.data ?? []) as any[] };
}

/** Each bill's lines, keyed by bill id. */
export function linesByBillId(lines: readonly any[]): Map<string, BillLine[]> {
  const by = new Map<string, BillLine[]>();
  for (const l of lines) {
    const k = String(l.bill_id);
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(l);
  }
  return by;
}

/**
 * What the invoice's own untouched materials lines are priced at. `sources` is the job's bills,
 * orders and receipt lines when the caller already has them; absent, they are read here with the
 * importer's filters. A lost read is `ok: false` - never "no lines" - because repricing on a guess
 * is the bug this exists to close.
 */
export async function readInvoiceMarkup(
  supabase: Db,
  invoiceId: string,
  jobId: string,
  sources?: InvoiceMarkupSources,
): Promise<InvoiceMarkupRead> {
  const [own, tomb] = await Promise.all([
    supabase.from("invoice_items").select("import_key, source_ids, line_total, edited").eq("invoice_id", invoiceId).eq("import_source", "costs"),
    supabase.from("invoices").select("dismissed_import_keys").eq("id", invoiceId).maybeSingle(),
  ]);
  if (own.error || tomb.error) {
    reportError("invoiceMarkup.read", own.error ?? tomb.error, { invoiceId });
    return { ok: false, error: READ_FAILED };
  }
  const lines = (own.data ?? []) as InvoiceCostLine[];
  // No materials lines, nothing to read - and no reason to read the job's receipts to find that out.
  if (!lines.length) return { ok: true, reading: { kind: "none" } };

  let src = sources;
  if (!src) {
    const [bills, pos] = await Promise.all([
      supabase.from("bills").select("id, amount").eq("job_id", jobId).is("superseded_by_bill_id", null),
      supabase.from("purchase_orders").select("id, total").eq("job_id", jobId),
    ]);
    if (bills.error || pos.error) {
      reportError("invoiceMarkup.read", bills.error ?? pos.error, { invoiceId, jobId });
      return { ok: false, error: READ_FAILED };
    }
    const billRows = ((bills.data ?? []) as { id: unknown; amount: unknown }[]).map((b) => ({ id: String(b.id), amount: b.amount }));
    const blis = await readBillLines(supabase, billRows.map((b) => b.id));
    if (blis.error) return { ok: false, error: blis.error };
    src = {
      bills: billRows,
      pos: ((pos.data ?? []) as { id: unknown; total: unknown }[]).map((p) => ({ id: String(p.id), total: p.total })),
      linesByBill: linesByBillId(blis.lines),
    };
  }

  // THE TAKES FROM STOCK get a vote too (see markupReading). Read only when a line is a take's, so
  // an invoice with no stock on it reads exactly what it read before. A lost read is not "no takes":
  // a stock-only invoice would read "none" and be repriced at the usual, so it refuses like the rest.
  let takes = src.takes;
  if (!takes && lines.some((l) => String(l.import_key ?? "").startsWith("stock:"))) {
    try {
      takes = (await readJobStock(supabase, jobId)).takes;
    } catch (e) {
      reportError("invoiceMarkup.read", e, { invoiceId, jobId, what: "stock" });
      return { ok: false, error: READ_FAILED };
    }
  }

  return {
    ok: true,
    reading: markupReading({
      lines,
      dismissed: new Set(((tomb.data as { dismissed_import_keys?: string[] | null } | null)?.dismissed_import_keys ?? []).map(String)),
      bills: src.bills,
      linesByBill: src.linesByBill,
      pos: src.pos,
      takes: takes ?? [],
    }),
  };
}
