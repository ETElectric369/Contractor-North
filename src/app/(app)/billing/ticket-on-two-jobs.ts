import "server-only";

import { reportError } from "@/lib/observe";
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
  const { data, error } = await supabase
    .from("bills")
    // THE SUPERSEDED ROWS COME TOO: the copy he already set aside is what makes a group read as
    // ANSWERED, and a group he has answered must not be warned about again (isOpenDuplicateGroup).
    // `jobs(job_number, name, customers(name))` is what lets the sentence name the other job in full.
    .select("id, supplier, amount, bill_date, job_id, notes, supplier_invoice_number, superseded_by_bill_id, jobs(job_number, name, customers(name)), bill_line_items(description)")
    .eq("org_id", orgId)
    .in("amount", amounts)
    .limit(500);
  if (error) {
    reportError("importCosts.ticketOnTwoJobs", error, { invoiceJob: jobId, amounts: amounts.length });
    return { said: [] };
  }
  const rows = (data ?? []) as any[];
  const { groups, ready } = duplicateTicketGroups({ bills: rows });
  // Without 0271's `superseded_by_bill_id` there is no way to mark a pick, so there is no picker to
  // send him to and nothing here would be actionable. Silence, not a sentence with no door.
  if (!ready) return { said: [] };
  const billed = new Set(mine.map((b) => String(b.id)));
  const said: string[] = [];
  for (const g of groups) {
    if (!isOpenDuplicateGroup(g)) continue;
    const here = g.copies.filter((c) => billed.has(c.billId));
    const elsewhere = g.copies.filter((c) => c.jobId !== jobId);
    if (!here.length || !elsewhere.length) continue;
    const supplier = (here[0].supplier || "supplier").trim();
    const others = elsewhere.map((c) => (c.jobId ? copySaid(c) : "no job")).join(" and ");
    said.push(
      `the same ${formatCurrency(g.amount)} ${supplier} ticket is also on ${others} — if that was one trip, pick which job it belongs to on Reconcile before you send this`,
    );
  }
  return { said };
}
