import "server-only";
import { recalcInvoice } from "@/lib/invoice-recalc";
import { completeJobWhenPaid, type CompleteWhenPaid } from "@/lib/complete-job-when-paid";
import type { BillingAccess } from "@/lib/finish-bills-first";
import { revalidateMoney } from "@/lib/revalidate-money";
import { invoiceOverpayment } from "@/lib/invoice-math";
import { notifyPeople } from "@/lib/notifications";
import { orgStaffIds } from "@/lib/push";
import { formatCurrency } from "@/lib/utils";
import { reportError } from "@/lib/observe";

/**
 * WHAT HAPPENS AFTER MONEY LANDS ON AN INVOICE — ONE PLACE, EVERY DOOR (M1, audit of cn-v1037).
 *
 * There are three writers that put a row in `payments`, and until now each one carried its own
 * idea of what follows:
 *
 *   billing/actions.ts recordPayment      recalc · finish the job · bell · revalidate
 *   lib/record-invoice-payment.ts         recalc · finish the job · bell · revalidate
 *   bills/bank-core.ts (a deposit off the bank file, put on an invoice)   recalc. Nothing else.
 *
 * So a deposit matched out of the bank download paid a job off and left the job reading "in
 * progress" for ever, with nobody told and no screen refreshed. Three copies of a four-step rule
 * is three chances to write two of them, which is exactly what happened.
 *
 * THE RULE LIVES HERE NOW, in the order it has to run:
 *
 *   1. RECALC. The invoice's figures are re-derived from its lines, its payments and its open
 *      credits (lib/invoice-recalc — the one definition of amount_paid). It answers false when
 *      nothing was rewritten, because a read that failed is not an empty table; callers holding
 *      money in their hands check that answer.
 *   2. FINISH THE JOB, if that paid it off. A standard invoice paid in full, on a job somebody has
 *      been on, with no other open bill: the job is done (lib/complete-job-when-paid holds the
 *      gate and its words). Never when the recalc did not land - a status written off a stale
 *      balance is the lie this whole helper exists to stop.
 *   3. RING THE BELL, when a payment was newly recorded. `bell` absent means this call is a
 *      REPEAT (the Stripe row was already there, or the same event came back): the money is being
 *      settled again, which is free, and ringing twice for one payment is a lie, so it doesn't.
 *      Overpaid is said in its own words, because only a person can choose credit or refund.
 *      AND WHEN STEP 2 HAD SOMETHING TO SAY, IT IS SAID TOO (M3): on a time-and-materials job the
 *      billing step can find hours and receipts no bill claims, and then the job is NOT finished —
 *      a fact about the JOB, not about the payment, so it gets its own line with its own door
 *      (/jobs/<id>, where the bill is made) rather than being tucked under a money title pointing at
 *      an invoice that is already paid. Two lines, two facts; never one line carrying both.
 *   4. REFRESH EVERY SCREEN THAT SHOWS MONEY (lib/revalidate-money), so the invoice page, the
 *      billing board, By Customer and My Day's money line can't disagree with the row.
 *
 * Works with any client (an RLS-scoped staff client or a webhook's service client), and from a
 * Server Action or a Route Handler. NEVER THROWS: the money is already recorded when this runs, so
 * a bell that failed or a cache that didn't clear is reported and the caller carries on. What it
 * does hand back is whether the figures came to rest, so a caller that must not ack a lie (the
 * Stripe webhook) can refuse.
 */
export type PaymentBell = {
  /** Dollars credited to the invoice, as the bell says it. */
  amount: number;
  /**
   * How the money arrived, in Erik's words, dropped into the line: "paid online", "paid by card in
   * person", "from the bank file". Absent for a payment typed in by hand, which needs no telling.
   */
  said?: string | null;
  /**
   * A PERSON RECORDED THIS ONE. The title says "Payment recorded" and that person is left out of
   * the bell - they are the one who just typed it. Absent (money that arrived on its own: a card,
   * a bank debit, a tap) and it reads "Payment received", to the whole office.
   */
  recordedBy?: string | null;
};

export type AfterPaymentLanded = {
  /** The invoice's figures were recomputed and written. False = the row still reads what it did. */
  settled: boolean;
  /** What the job did, in the gate's own words (lib/complete-job-when-paid). */
  job: CompleteWhenPaid;
  /** Who the bell line was written for. Empty when there was nobody to tell, or no bell to ring. */
  rang: string[];
};

export async function afterPaymentLanded(
  supabase: any,
  input: {
    invoiceId: string;
    /** The invoice's company. Without it there is nobody to ring: the bell is skipped, said in the log. */
    orgId?: string | null;
    /**
     * WHICH CLIENT THIS DOOR HOLDS — required, and passed straight to the paid-in-full gate, because the
     * billing step behind it prices the job's hours and the pricing reads answer differently to a staff
     * client and to the service role (lib/finish-bills-first's module note). Not inferred from `orgId`:
     * every door knows its own company, only one of them is the webhook.
     */
    access: BillingAccess;
    /** The words and the audience for the one bell line. Absent on a repeat: see step 3 above. */
    bell?: PaymentBell | null;
  },
): Promise<AfterPaymentLanded> {
  const { invoiceId, orgId } = input;
  const settled = await recalcInvoice(supabase, invoiceId);
  // 2. Paid in full on a standard invoice, on a job that has started, with no other open bill: the
  //    job is done. Never off a balance that didn't recompute.
  const job: CompleteWhenPaid = settled
    ? await completeJobWhenPaid(supabase, invoiceId, input.access)
    : { completed: false, why: "the invoice's figures didn't recompute, so nothing was finished" };

  let rang: string[] = [];
  if (input.bell) {
    try {
      rang = await ringPaymentBell(supabase, invoiceId, orgId, input.bell);
    } catch (e) {
      // A notification must never unsave what caused it: the money is in, the figures are right.
      reportError("afterPaymentLanded:bell", e, { invoiceId, orgId });
    }
  }
  // WHAT THE BILLING STEP FOUND, SAID OUT LOUD (M3). Its own line, because it is its own fact and its
  // own door — and gated on the same `bell` as the payment line, so a Stripe event delivered four times
  // says this once. (Both lines share that gate, so both are lost in the one case it doesn't cover: a
  // writer that died between its payment insert and this helper. That gap is the payment bell's too and
  // predates this; it is not widened here.)
  // Every read of `job` happens INSIDE the try, so this file's own law — it never throws, because the
  // money is already recorded when it runs — stays literally true even if step 2 ever answered with
  // something that isn't a verdict.
  if (input.bell) {
    try {
      await ringJobStillToBill(orgId, job);
    } catch (e) {
      reportError("afterPaymentLanded:job-bell", e, { invoiceId, orgId });
    }
  }

  try {
    revalidateMoney(invoiceId);
  } catch (e) {
    // The money is recorded and the totals are right; only the caches are stale, and the next
    // navigation clears them. Worth a line in the ops log, never worth failing a payment.
    reportError("afterPaymentLanded:revalidate", e, { invoiceId });
  }
  return { settled, job, rang };
}

/**
 * THE ONE BELL LINE FOR A PAYMENT, in the one place every door rings from.
 *
 * notifyPeople writes the bell line FIRST and then pushes, to the same people in the same words, so
 * a buzz swiped off the lock screen (or never delivered - no signal, the push muted, the app not
 * installed) still left the record Erik asked for. The invoice is re-read AFTER the recalc so the
 * overpayment is knowable here - the projection law: you cannot notice what you did not select.
 */
async function ringPaymentBell(supabase: any, invoiceId: string, orgId: string | null | undefined, bell: PaymentBell): Promise<string[]> {
  if (!orgId) {
    reportError("afterPaymentLanded:bell", new Error("a payment landed with no company on it, so nobody could be told"), { invoiceId });
    return [];
  }
  const { data: inv, error } = await supabase
    .from("invoices")
    .select("invoice_number, total, amount_paid, customers(name)")
    .eq("id", invoiceId)
    .maybeSingle();
  if (error) reportError("afterPaymentLanded:bell-read", error, { invoiceId });
  const row = (inv ?? {}) as { invoice_number?: string | null; total?: number | null; amount_paid?: number | null; customers?: { name?: string | null } | null };
  const number = row.invoice_number || "an invoice";
  const cust = row.customers?.name ? ` — ${row.customers.name}` : "";
  const said = String(bell.said ?? "").trim();
  const line = `${formatCurrency(bell.amount)}${said ? ` ${said}` : ""} on ${number}${cust}`;

  // ── PAID TWICE (audit 6) ──────────────────────────────────────────────────────────────────────
  // The hand-typed doors refuse more than the balance, but a customer who taps Pay twice on a slow
  // connection mints two Checkout sessions that each read a full balance. Both go through, and the
  // invoice then reads $0 owed - the one number anybody checks - with nothing saying it took
  // double. The row stays (the money moved at Stripe; losing the record is strictly worse), and
  // the disposition is NOT chosen here: credit-versus-refund is the judgement a person makes, and
  // an overpayment is sometimes a deliberate prepayment toward the next job. So this does the one
  // thing a machine should: say so, loudly, to the people who can decide.
  const over = invoiceOverpayment(row.total, row.amount_paid);
  const byHand = !!bell.recordedBy;
  const people = (await orgStaffIds(orgId)).filter((id) => id !== (bell.recordedBy ?? null));
  await notifyPeople(orgId, people, "invoice_paid", over > 0.005
    ? {
        title: "Overpaid — action needed",
        body: `${line}. That's ${formatCurrency(over)} MORE than the total. Credit it or refund it.`,
        url: `/billing/${invoiceId}`,
      }
    : {
        // A person just typed this one in, so it is a record of what they did; money that arrived
        // on its own is news.
        title: byHand ? "Payment recorded" : "Payment received",
        body: line,
        url: `/billing/${invoiceId}`,
      });
  // Who was TOLD, which is the bell line's audience, not the push's: muting a buzz is not asking to
  // lose the record (lib/notifications).
  return people;
}

/**
 * THE JOB'S OWN LINE: WHAT A PAID BILL LEFT STILL TO BILL (M3, lib/finish-bills-first).
 *
 * The sentence is the billing step's, verbatim — it already names the job the way Erik reads it and the
 * hours, receipts and takes from the Unbilled card's own arithmetic, so nothing is re-derived or
 * shortened here (a figure trimmed on its way to a person is the silence this lane exists to close).
 * The door is the JOB, because that is where the bill is made; the payment's line keeps the invoice.
 * Unlike the payment line this one DOES go to the person who recorded it: they typed a payment, which is
 * not the same as being told their job still has work off every bill.
 *
 * Rides the `invoice_paid` kind on purpose: it is a consequence of that same money landing, so whoever
 * asked to hear about a bill being paid hears this, and nobody has to find a new switch to turn on.
 */
async function ringJobStillToBill(orgId: string | null | undefined, job: CompleteWhenPaid): Promise<void> {
  if (!job?.say) return;
  if (!orgId) {
    reportError("afterPaymentLanded:job-bell", new Error("a job's billing step had something to say with no company on it, so nobody could be told"), {});
    return;
  }
  // THE TITLE COMES WITH THE SENTENCE (paidDoorVerdict), and is never guessed from `completed` here: a
  // read that FAILED used to go out titled "Still to bill" — a claim about the job's money that nothing
  // had checked, and on a fixed-price job the one alarm it must never raise. The gate always sets it
  // beside `say` (completeJobWhenPaid's `heard`), so there is nothing left to guess.
  await notifyPeople(orgId, await orgStaffIds(orgId), "invoice_paid", {
    title: job.sayTitle,
    body: job.say,
    ...(job.jobId ? { url: `/jobs/${job.jobId}` } : {}),
  });
}
