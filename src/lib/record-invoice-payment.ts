import { invoiceOverpayment } from "@/lib/invoice-math";
import { orgStaffIds } from "@/lib/push";
import { notifyPeople } from "@/lib/notifications";
import { formatCurrency } from "@/lib/utils";
import { recalcInvoice } from "@/lib/invoice-recalc";
import { completeJobWhenPaid } from "@/lib/complete-job-when-paid";
import { paymentReachedDraft } from "@/lib/tap-settlement";
import { revalidateMoney } from "@/lib/revalidate-money";
import { reportError } from "@/lib/observe";
import { captureProcessorFee } from "@/lib/processor-fee-capture";
import { paymentMethodKey } from "@/lib/payment-method";

/**
 * THE ONE WRITER FOR STRIPE MONEY ON AN INVOICE.
 *
 * Until 2026-09-30 this lived inside the webhook handler as a closure, and the webhook was the
 * only door card money came through. Then Rich Seiler's $420 (INV-083): the phone said
 * "approved", Stripe never charged, and the sheet waited for a webhook that could never come.
 * The fix makes the Pay Now sheet ask Stripe itself (tapPaymentOutcome) — and when Stripe says
 * succeeded and the webhook hasn't landed yet, the sheet has to be able to BOOK it. A second
 * insert path keyed on a different id is exactly the double-record class this helper was built
 * to close, so the closure became this module: the webhook and the action call the same function,
 * and it is idempotent on the PAYMENT INTENT, not only on the event id.
 *
 * ── TWO LOCKS ON ONE PAYMENT ─────────────────────────────────────────────────────────────────
 *
 *   1. payments.stripe_event_id is UNIQUE (0060). Both writers hand a tap payment the SAME key,
 *      derived from the PaymentIntent (tapPaymentKey), so whichever of the action and the webhook
 *      inserts second hits 23505 at the database — a boundary, not a convention. A retried
 *      Checkout event keeps its event id as the key, exactly as before.
 *   2. Before inserting, the row is looked up by stripe_payment_intent (0220). That covers the
 *      rows written before this module existed (keyed on an evt_ id a replay would no longer
 *      match) and lets a caller know the money was already at rest.
 *
 * ── WHAT IT RETURNS ──────────────────────────────────────────────────────────────────────────
 *
 *   "booked"   this call wrote the row and settled the invoice.
 *   "already"  the row was there (this event's retry, or the other writer got there first); the
 *              invoice was settled again, which is free — recalc is idempotent — and heals the
 *              case where the first writer died between its insert and its recalc (audit 8).
 *   "refused"  the claim did not hold: the connected account does not own the org, or the
 *              invoice is not the org's. Nothing was written, the ops log says why, and nothing
 *              else may be written in the payment's name (BK3 stands behind this answer).
 *
 * Every failure a retry can fix THROWS — the webhook answers 500 so Stripe resends the same event
 * id; the action turns it into a sentence.
 */
export type RecordVia = {
  note: string;
  said: string;
  /**
   * THE METHOD KEY THE ROW IS BOOKED UNDER (0287; audit v994 BK2). Every Stripe payment used to
   * be booked 'card', so a bank debit read "Card" and "Card fee" on the invoice, the PDF, the
   * statement and the owner's fees, and the "Bank fee" label could never show. The Checkout
   * branch passes what the session was actually paid with (checkoutPaymentMethod); Tap to Pay
   * is always a card. Absent means 'card', as it always was.
   */
  method?: "card" | "ach";
};

export type RecordOutcome = "booked" | "already" | "refused";

/** The idempotency key BOTH tap writers use for one PaymentIntent (see the module note). */
export function tapPaymentKey(paymentIntentId: string): string {
  return `tap:${paymentIntentId}`;
}

/** Tap to Pay's ledger words — the one place they are spelled, for both writers. */
export const TAP_VIA: RecordVia = { note: "Tap to Pay on iPhone", said: "paid by card in person" };

/**
 * THE EVENT'S ACCOUNT IS THE ORG BOUNDARY — THE METADATA IS A CLAIM (audit v921).
 *
 * Everything a payment event writes is scoped by its metadata, which the sender chose. The
 * connected endpoint delivers checkout.session.completed from EVERY connected account, so an
 * account able to mint its own session could name another tenant's invoice and mark it paid with
 * a $1 charge. It can't today (Express accounts hold no API keys and only /api/pay mints these
 * sessions), which is exactly why the check belongs here: [[tenant-isolation-root-cause]] — a
 * rule applied at one write path is a convention, not a boundary.
 *
 * ONE CHECK FOR EVERY WRITER: the payment row, and since 0338 the bank-transfer marker (audit
 * v994 BK3), stand behind the same two questions. Returns the invoice (with the status a draft
 * is said by - the projection law) or null after saying why in the ops log. A retry can't
 * fix a claim that doesn't hold, so the caller acks rather than looping Stripe on it.
 */
export async function claimedInvoice(
  supabase: any,
  invoiceId: string,
  orgId: string,
  connectedAccount: string | null,
): Promise<{ id: string; status: string | null; invoice_number: string | null } | null> {
  if (connectedAccount) {
    const { data: owner } = await supabase
      .from("organizations")
      .select("id")
      .eq("id", orgId)
      .eq("stripe_account_id", connectedAccount)
      .maybeSingle();
    if (!owner) {
      reportError("stripe:webhook:account-org-mismatch", new Error("checkout session names an org that doesn't own the connected account"), {
        orgId,
        invoiceId,
        connectedAccount,
      });
      return null;
    }
  }
  const { data: target } = await supabase
    .from("invoices")
    .select("id, status, invoice_number")
    .eq("id", invoiceId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (!target) {
    reportError("stripe:webhook:invoice-org-mismatch", new Error("checkout session names an invoice that isn't the org's"), {
      orgId,
      invoiceId,
    });
    return null;
  }
  return target as { id: string; status: string | null; invoice_number: string | null };
}

export async function recordStripeInvoicePayment(
  supabase: any,
  input: {
    invoiceId: string | undefined;
    orgId: string | undefined;
    /** Dollars credited to the invoice (invoiceCredit, never the processor's fee). */
    amount: number;
    /** The unique key the row is written under: the Stripe event id, or tapPaymentKey(pi) for a tap. */
    idempotencyKey: string;
    paymentIntent: string | null;
    connectedAccount: string | null;
    /** Which door the money came through — the ledger note, the office push, the method key. */
    via?: RecordVia;
  },
): Promise<RecordOutcome> {
  const { invoiceId, orgId, amount, idempotencyKey, paymentIntent, connectedAccount } = input;
  const via: RecordVia = input.via ?? { note: "Online payment", said: "paid online" };
  if (!invoiceId || !orgId || amount <= 0) return "refused";
  // The org<->account and invoice<->org checks (claimedInvoice above). status rides along because
  // a draft reaching this door has to be SAID (see below), and the projection law says you cannot
  // notice what you did not select.
  const target = await claimedInvoice(supabase, invoiceId, orgId, connectedAccount);
  if (!target) return "refused";
  /**
   * A DRAFT IS SETTLED, NEVER SENT, AND ALWAYS SAID (Connected North Phase 1).
   *
   * Every pay door asks "Send INV-078 as the bill first?" and sends it on the yes before a card
   * can be charged, so money arriving on a draft means something slipped past that question (a
   * PaymentIntent minted before it shipped, a bill put back to Draft under an open sheet). It is
   * recorded and recalced like a cash deposit on a draft - the money lands, the draft stays a
   * draft (paidStatus never advances one) - and an error_events row makes a person look. This
   * writer never writes a status and never stamps sent_at (lib/tap-settlement).
   */
  const onDraft = paymentReachedDraft(target.status);

  /**
   * SETTLE = RECALC, COMPLETE THE JOB IF THAT PAID IT OFF, THEN REFRESH.
   *
   * revalidateMoney is the one nerve every money mutation in the app uses; a webhook is a Route
   * Handler and the action is a Server Action, so it is legal from both, and the invoice page,
   * the billing board, AR and the My Day money line all re-read instead of disagreeing with the
   * row (the other half of INV-069: a pay door's write that told no screen anything).
   *
   * Returns false when the money did NOT come to rest, so the caller can throw and let Stripe
   * retry the same event id — the insert then hits 23505 and the heal branch settles it.
   */
  const settle = async (id: string): Promise<boolean> => {
    if (!(await recalcInvoice(supabase, id))) return false;
    // Paid in full on a standard invoice, on a job that has started (in progress / on hold) with
    // no other open bill: the job is done (lib/complete-job-when-paid; never throws, never fails
    // the payment). A job still booked ahead is left on the schedule.
    await completeJobWhenPaid(supabase, id);
    try {
      revalidateMoney(id);
    } catch (e) {
      // The money is recorded and the totals are right; only the caches are stale, and the next
      // navigation clears them. Worth a line in the ops log, never worth making Stripe retry a
      // payment that already landed.
      reportError("stripe:webhook:revalidate", e, { invoiceId: id });
    }
    return true;
  };

  // LOCK 2: the same PaymentIntent already booked, under whatever key (a row from before this
  // module, or the other writer). Settle again — free, and it heals a crashed first attempt.
  if (paymentIntent) {
    const { data: prior, error: priorErr } = await supabase
      .from("payments")
      .select("id")
      .eq("stripe_payment_intent", paymentIntent)
      .eq("org_id", orgId)
      .limit(1)
      .maybeSingle();
    if (priorErr) throw new Error(`looking up payment ${paymentIntent} failed: ${priorErr.message}`);
    if (prior) {
      if (!(await settle(invoiceId))) throw new Error(`settling invoice ${invoiceId} failed on a repeat`);
      return "already";
    }
  }

  // org_id is set explicitly (the set_org_id trigger has no auth context in the webhook).
  // LOCK 1: stripe_event_id is UNIQUE, so a retried webhook (Stripe resends the SAME event.id
  // on timeout) — or the action and the webhook racing on the same tap key — fails the second
  // insert and stops: no double pay.
  const { error: insErr } = await supabase.from("payments").insert({
    invoice_id: invoiceId,
    org_id: orgId,
    amount,
    method: paymentMethodKey(via.method ?? "card"),
    note: via.note,
    stripe_event_id: idempotencyKey,
    // The ONE id a later charge.refunded / charge.dispute.created can be matched on. The
    // event id can't be: Stripe sends a different event for the refund. See migration 0220.
    stripe_payment_intent: paymentIntent,
  });
  if (insErr) {
    if ((insErr as { code?: string }).code === "23505") {
      // Already recorded this key — but the FIRST attempt may have died between the insert
      // and the recalc (cold-start timeout, deploy, OOM), leaving the payment row with an
      // invoice header still reading $0 owed-in-full (audit 8). recalc is idempotent, so
      // running it on every benign retry is free and it heals the crashed case. Deliberately
      // NOT the push: that one isn't idempotent and the duplicate is usually benign.
      if (!(await settle(invoiceId))) {
        // Still not settled — let Stripe retry rather than acking a lie (see below).
        throw new Error(`settling invoice ${invoiceId} failed on retry`);
      }
      return "already";
    }
    throw new Error(insErr.message);
  }
  // Settle through THE shared recalc (items + payments + open customer credits) instead
  // of a local payments-only sum. The old code blind-wrote `amount_paid = sum(payments)`,
  // which ERASED any posted credit: a $200 account credit + an $800 card payment on a
  // $1,000 invoice came back as $800 paid / status "partial", so the invoice kept a
  // phantom $200 balance forever — aged in A/R, dunned by the reminder cron, and payable
  // a SECOND time on the public page. One definition, both paths agree by construction.
  //
  // AND IT HAS TO LAND (audit v921 high). The money row is already in; if the settle fails,
  // the invoice keeps its old balance, AR ages it, the dunning cron chases a customer who
  // paid, and GET /api/pay/<token> still sees balance > 0 and opens a SECOND full-amount
  // Checkout. Acking 200 here ends the story — Stripe never retries a 2xx and no cron
  // re-runs recalc. So throw: the handler answers 500, Stripe retries the same event id,
  // the insert hits 23505 and the heal branch above settles it. Recalc is idempotent, so
  // the retry is free; a swallowed failure is not.
  if (!(await settle(invoiceId))) {
    throw new Error(`settling invoice ${invoiceId} failed after recording the payment`);
  }
  if (onDraft) {
    reportError("stripe:webhook:payment-on-draft", new Error("card money landed on a draft invoice; settled, not sent"), {
      invoiceId,
      orgId,
      door: via.note,
      paymentIntent,
    });
  }
  const { data: inv } = await supabase
    .from("invoices")
    // total + amount_paid so the overpayment is knowable HERE — the projection law: you cannot
    // notice what you did not select.
    .select("invoice_number, total, amount_paid, customers(name)")
    .eq("id", invoiceId)
    .single();

  // A customer paid online — ping office staff (no recorder to exclude).
  // Awaited (not fire-and-forget): a serverless function can freeze right after
  // responding to Stripe, killing an un-awaited push. sendPush never throws.
  const cust = (inv as any)?.customers?.name as string | undefined;

  // ── PAID TWICE (audit 6) ────────────────────────────────────────────────────────────────
  //
  // This is the only payment writer with no ceiling. recordPayment refuses to exceed the
  // balance and credits are capped, but a customer who taps Pay twice on a slow connection
  // mints two Checkout sessions that EACH read a full balance, because neither has settled yet.
  // Both go through, both post, and the invoice then reads $0 owed — the one number anybody
  // checks — with nothing anywhere saying it took double.
  //
  // THE ROW IS STILL WRITTEN. The money already moved at Stripe; refusing the insert would lose
  // the record of a real payment, which is strictly worse than recording an awkward one. And
  // the disposition is NOT chosen here: credit-versus-refund is the judgement CreditButton asks
  // a human to make, and an overpayment is sometimes a deliberate prepayment toward the next
  // job. A webhook picking "refund" would pre-empt that and double-post against a later manual
  // credit. So it does the one thing a machine should: say so, loudly, to the people who can
  // decide.
  const over = invoiceOverpayment((inv as any)?.total, (inv as any)?.amount_paid);
  // THE BELL RECORDS IT (notifyPeople): once, here, on the path that recorded the payment. A replay
  // of the same key (23505 above) settles and returns before this line, so it never writes twice.
  await notifyPeople(orgId, await orgStaffIds(orgId), "invoice_paid", over > 0.005
    ? {
        title: "Overpaid — action needed",
        body: `${formatCurrency(amount)} ${via.said} on ${inv?.invoice_number || "an invoice"}${cust ? ` — ${cust}` : ""}. That's ${formatCurrency(over)} MORE than the total. Credit it or refund it.`,
        url: `/billing/${invoiceId}`,
      }
    : {
        title: "Payment received",
        body: `${formatCurrency(amount)} ${via.said} on ${inv?.invoice_number || "an invoice"}${cust ? ` — ${cust}` : ""}`,
        url: `/billing/${invoiceId}`,
      });

  // WHAT STRIPE TOOK, LAST (migration 0284). Card fees are a business cost that comes off the
  // owner's draw, so the real fee is read off the charge on the contractor's own account and
  // kept on the row. It runs only after the money is recorded, settled and announced, and it
  // never throws: a fee Stripe cannot hand over yet stays NULL, the ops log hears about a
  // failure, and the daily cron reads it tomorrow. One writer for every door that lands here
  // (Checkout card, Checkout bank debit, Tap to Pay — by webhook or by the sheet's own check).
  if (paymentIntent) {
    await captureProcessorFee(supabase, { orgId, paymentIntent, account: connectedAccount });
  }
  return "booked";
}
