import "server-only";

import { reportError } from "@/lib/observe";
import { readAllPages } from "@/lib/read-all-pages";
import { formatCurrency } from "@/lib/utils";
import { copySaid } from "@/app/(app)/bills/supplier-balance";
import { duplicateTicketGroups, isOpenDuplicateGroup } from "@/app/(app)/bills/supplier-name-work";

/**
 * ── A TICKET ON TWO JOBS IS CAUGHT BEFORE AN INVOICE GOES OUT (2026-10-03) ─────────────────────
 *
 * ONE $95.27 SUPPLY-HOUSE TICKET WAS FILED ON TWO JOBS. Both jobs were invoiced and both customers
 * PAID: $102.34 on one and $119.09 on the other — $221.43 collected for one $95.27 purchase. Erik
 * found it on Reconcile months later and let it go.
 *
 * WHAT ALREADY WORKED. Once a duplicate is MARKED, billing/actions.ts filters
 * `.is("superseded_by_bill_id", null)` and the set-aside copy can never be billed. That guard is real
 * and it is in the right place.
 *
 * WHAT WAS MISSING. Nothing checked at the moment an invoice was BUILT. `duplicateTicketGroups` runs
 * when Reconcile or Bills LOADS — a page computation, not a gate — so invoicing both jobs before ever
 * opening Reconcile sent both copies out, which is exactly what happened.
 *
 * SO THIS ASKS, WHILE IT IS STILL FREE TO ANSWER. It is NOT a refusal: two identical runs a month
 * apart are perfectly normal and only he was on those jobs. It is a sentence on the import, where the
 * person building the invoice reads it before it is sent, naming the other job the way this repo names
 * a job — the place, the number AND who, never a bare number (Erik: "i cant tell by job numbers
 * alone").
 *
 * AND IT IS NOT A SECOND OPINION ABOUT WHAT A DUPLICATE IS. `duplicateTicketGroups` decides, the same
 * function Reconcile's picker is built from, so a ticket this warns about is a ticket that picker will
 * show him and nothing else. What the warning needed was the job said in FULL, and that was widened
 * where the copy is built (supplier-name-work.ts `jobSaid`), for every caller at once.
 *
 * AND BOTH COPIES ON ONE JOB IS THE SAME HARM (review, 2026-10-03). Two phone photographs of one
 * ticket, both filed on J-046, both pulled onto the same invoice: `duplicateTicketGroups` pairs them
 * (no job term in the matcher) and Reconcile lists them, but this gate wanted a copy on ANOTHER job
 * and skipped the group — so the customer was charged twice, with markup, on ONE invoice and nothing
 * asked. The question is now asked of whatever that one matcher paired, however the copies are filed.
 *
 * AND THE READ IS WHOLE OR IT IS A FAILURE (review, 2026-10-03). It was one `.limit(500)` with no
 * order: PostgREST cuts a select with status 200 and no error, so a long-lived book of common amounts
 * ($25.00, $39.99) could hand back an arbitrary 500 rows with the other copy of the ticket outside
 * them, and the invoice went out with the check computed over a partial ledger and nothing said. It
 * is paged by id now (readAllPages), the rule this repo already wrote down: never a partial list.
 */

/** One bill the invoice is about to charge, as this check needs it. */
export type BilledBill = { id: string; amount: unknown };

export type TwoJobTickets = {
  /** One sentence per ticket, ready for the import's own warnings. Empty when nothing matches. */
  said: string[];
};

const cents = (v: unknown) => Math.round((Number(v) || 0) * 100);

/**
 * Which of the bills this invoice is charging are also filed on another job. `billedIds` is what
 * actually landed on the invoice, so a receipt held back behind a line the office edited by hand is
 * not warned about — there is no charge on this invoice to go and look at.
 *
 * NOTHING IS CLAIMED FROM A READ THAT FAILED. A lost read is logged and says nothing: an invented
 * all-clear here is worse than silence, and the Reconcile picker still finds it afterwards.
 */
export async function ticketsAlsoOnAnotherJob(
  supabase: any,
  orgId: string | null | undefined,
  jobId: string,
  bills: readonly BilledBill[],
  billedIds: ReadonlySet<string> | null,
): Promise<TwoJobTickets> {
  const mine = bills.filter((b) => (billedIds ? billedIds.has(String(b.id)) : true) && cents(b.amount) > 0);
  if (!mine.length || !orgId) return { said: [] };
  // ONLY THE AMOUNTS IN PLAY. `findDuplicateBills` pairs to the cent, so a bill of another amount can
  // never be a copy of one of these: the read is narrow by the same rule the matcher uses, rather than
  // pulling the whole ledger onto an invoice save.
  const amounts = [...new Set(mine.map((b) => Math.round((Number(b.amount) || 0) * 100) / 100))];
  // A WHOLE LIST OR A FAILURE (read-all-pages.ts). An unordered `.limit(500)` answered 200 with the
  // rest simply missing, so WHICH copies came back was whatever the query plan yielded: the partner of
  // the $95.27 ticket could sit outside the cut and the invoice went out with nothing said.
  const { rows: paged, error } = await readAllPages<any>((from, to) =>
    supabase
      .from("bills")
      // THE SUPERSEDED ROWS COME TOO: the copy he already set aside is what makes a group read as
      // ANSWERED, and a group he has answered must not be warned about again (isOpenDuplicateGroup).
      // `jobs(job_number, name, customers(name))` is what lets the sentence name the other job in full.
      .select("id, supplier, amount, bill_date, job_id, notes, supplier_invoice_number, superseded_by_bill_id, jobs(job_number, name, customers(name)), bill_line_items(description)")
      .eq("org_id", orgId)
      .in("amount", amounts)
      .order("id")
      .range(from, to),
  );
  if (error) {
    reportError("importCosts.ticketOnTwoJobs", error, { invoiceJob: jobId, amounts: amounts.length });
    return { said: [] };
  }
  const rows = paged as any[];
  const { groups, ready } = duplicateTicketGroups({ bills: rows });
  // Without 0271's `superseded_by_bill_id` there is no way to mark a pick, so there is no picker to
  // send him to and nothing here would be actionable. Silence, not a sentence with no door.
  if (!ready) return { said: [] };
  const billed = new Set(mine.map((b) => String(b.id)));
  const said: string[] = [];
  for (const g of groups) {
    if (!isOpenDuplicateGroup(g)) continue;
    const here = g.copies.filter((c) => billed.has(c.billId));
    if (!here.length) continue;
    const elsewhere = g.copies.filter((c) => c.jobId !== jobId);
    const supplier = (here[0].supplier || "supplier").trim();
    // A CAPITAL AND ONE DASH (review, 2026-10-03). Every other import warning starts a sentence
    // ("Removed …", "Merged …"), and invoice-detail joins them with ". " and prints them under the
    // import row, so a lowercase clause read as a sentence cut in half. The job's own label already
    // carries an em dash ("4 Bramble Lane · J-102 — Remy Dunsmore"), so a second one straight after it
    // put two dashes in a row: the clause starts a new sentence instead.
    const amount = formatCurrency(g.amount);
    if (here.length > 1) {
      // BOTH COPIES ON THIS VERY INVOICE: one purchase charged twice, with markup, on one bill. The
      // marks are what tells two tickets identical to the penny apart on sight (the file each came in
      // as), because the job and the amount are the same on both and name neither.
      said.push(
        `The same ${amount} ${supplier} ticket is on this invoice ${here.length === 2 ? "twice" : `${here.length} times`} (${here.map(copyMark).join(", ")}). If that is one purchase, pick which copy counts on Reconcile before you send this`,
      );
    }
    // AND A COPY ON ANOTHER JOB IS STILL SAID, even when two of them are on this one: both facts were
    // checked, so both are said rather than the louder one standing in for the other.
    if (!elsewhere.length) continue;
    const others = elsewhere.map((c) => (c.jobId ? copySaid(c) : "no job")).join(" and ");
    said.push(
      `The same ${amount} ${supplier} ticket is also on ${others}. If that was one trip, pick which job it belongs to on Reconcile before you send this`,
    );
  }
  return { said };
}

/** What tells two tickets identical to the penny apart on sight: the file it came in as, else its day. */
const copyMark = (c: { source?: string | null; billDate?: string | null }): string => c.source?.trim() || c.billDate || "no date on it";

/**
 * ── AND THE QUESTION IS THERE WHENEVER THE INVOICE IS OPENED (review, 2026-10-03) ──────────────
 *
 * The sentence was raised at the moment of the IMPORT and nowhere else. Four doors (the job's New
 * Invoice, the Overview card's Create Invoice, Billing's New Invoice and Invoice Job) toasted it and
 * then changed the route, so it had a few seconds while the draft was still loading — and the draft
 * itself started with nothing: `invoice-detail` seeded its count at 0 and only a button press on that
 * page could arm the "Pick Which Job" link. So the draft opened clean, Send went out, and the question
 * had been asked where nobody could read it. That is the $221.43-for-$95.27 incident with the new check
 * reduced to a glimpse.
 *
 * SO THE PAGE ASKS IT ITSELF, every load, off the bills its own cost lines charge. One rule, one
 * function, one matcher: the same `ticketsAlsoOnAnotherJob` the import runs, so the invoice page and the
 * import cannot disagree about what a duplicate is. A READ IS A PROPOSAL: this writes nothing.
 */
export async function twoJobTicketsOnInvoice(
  supabase: any,
  orgId: string | null | undefined,
  jobId: string | null | undefined,
  /** Every bill id this invoice's own cost lines claim (invoice_items.source_ids on import_source "costs"). */
  billIds: readonly string[],
): Promise<TwoJobTickets> {
  const ids = [...new Set(billIds.map((b) => String(b ?? "").trim()).filter(Boolean))];
  if (!ids.length || !orgId || !jobId) return { said: [] };
  // The amounts come off the bills themselves rather than the invoice lines, because a line is priced
  // WITH markup and the matcher pairs on what the supplier charged, to the cent. Paged by id, like the
  // read below it: a cut would quietly check fewer bills than the invoice charges and say nothing.
  const { rows, error } = await readAllPages<BilledBill>((from, to) =>
    supabase.from("bills").select("id, amount").eq("org_id", orgId).in("id", ids).order("id").range(from, to),
  );
  if (error) {
    reportError("invoicePage.ticketOnTwoJobs", error, { invoiceJob: jobId, bills: ids.length });
    return { said: [] };
  }
  const bills = rows.map((b) => ({ id: String(b.id), amount: b.amount }));
  return ticketsAlsoOnAnotherJob(supabase, orgId, String(jobId), bills, new Set(bills.map((b) => b.id)));
}
