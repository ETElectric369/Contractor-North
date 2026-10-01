import { getStripe } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/server";
import { orgStaffIds } from "@/lib/push";
import { notifyPeople } from "@/lib/notifications";
import { formatCurrency } from "@/lib/utils";
import { claimedInvoice, recordStripeInvoicePayment, tapPaymentKey, TAP_VIA, type RecordVia } from "@/lib/record-invoice-payment";
import { declineReason } from "@/lib/stripe-decline-words";
import { accountUpdateFields } from "@/lib/stripe-connect";
import { tierForPriceId } from "@/lib/plans";
import { reportError } from "@/lib/observe";
import { checkoutPaymentMethod, isBankCheckout, noteTransferStarted, resolveTransfer } from "@/lib/bank-transfer";
import type Stripe from "stripe";

export const runtime = "nodejs";

/**
 * Stripe webhook: keeps organizations.subscription_status / plan in sync.
 * Configure TWO endpoints at this URL in Stripe → Developers → Webhooks — "your account" (secret →
 * STRIPE_WEBHOOK_SECRET) and "connected accounts" (secret → STRIPE_CONNECT_WEBHOOK_SECRET).
 * Listens for subscription + checkout events on ours; on theirs: checkout.session.completed,
 * account.updated, charge.refunded, charge.dispute.created, AND — for Tap to Pay on iPhone —
 * payment_intent.succeeded and payment_intent.payment_failed. Those two are not on the endpoint
 * by default: a tap is charged but never booked (or never declines to the tech) until the
 * "connected accounts" destination in the Stripe dashboard carries both. Added 2026-09-11.
 *
 * BANK TRANSFER (ACH) NEEDS TWO MORE there before settings.bank_transfer_enabled may be turned on
 * (Erik, audit v994 BK3): checkout.session.async_payment_succeeded (the money lands and is booked,
 * method 'ach') and checkout.session.async_payment_failed (the debit bounced; nothing was booked,
 * the office is told). Without them a debit is marked on its way (0338) and never ends; the daily
 * cron tells the office about any that outlive a week.
 */
/**
 * WHAT GOES ON THE INVOICE, WHICH IS NOT ALWAYS WHAT STRIPE CHARGED.
 *
 * `amount_total` is what the customer's card was billed. From the day a card processing fee rides
 * as its own Checkout line, that is MORE than the invoice: $1,875.98 of work at a 3% fee charges
 * $1,932.26, and crediting the charge would book $56.28 the invoice never asked for. The balance
 * goes negative, recalc calls it overpaid, and the office gets an "Overpaid, action needed" push
 * about money that was only ever the processor's (found by the reviewer of this wave, 2026-09-20).
 *
 * So both pay doors stamp `invoice_amount` on the session AND the PaymentIntent, and it wins when
 * it is there. The fallback is the old reading exactly, so every session created before this
 * shipped - and every Tap to Pay charge, which has no fee and no line items - books as it always
 * did. A fee is the processor's money; the invoice is only ever credited its own balance.
 */
function invoiceCredit(charged: number, metadata: Record<string, string> | null | undefined): number {
  const stated = Number(metadata?.invoice_amount);
  if (Number.isFinite(stated) && stated > 0) return Math.round(stated * 100) / 100;
  return Math.round((Number(charged) || 0) * 100) / 100;
}

export async function POST(req: Request) {
  // TWO SIGNING SECRETS. Stripe issues one per endpoint, and Connect needs two endpoints at this
  // same URL: one for OUR account's events (subscriptions, our checkout) and one that "listens to
  // events on connected accounts" (a contractor's customer paying an invoice, account.updated).
  // Each event verifies against whichever secret signed it; a body that matches neither is refused.
  const secrets = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_CONNECT_WEBHOOK_SECRET].filter(
    (s): s is string => !!s,
  );
  if (secrets.length === 0) {
    return new Response("STRIPE_WEBHOOK_SECRET not configured", { status: 503 });
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("Missing signature", { status: 400 });

  const body = await req.text();
  let event: Stripe.Event | null = null;
  let lastErr = "";
  for (const secret of secrets) {
    try {
      event = getStripe().webhooks.constructEvent(body, sig, secret);
      break;
    } catch (e: any) {
      lastErr = e?.message ?? "invalid signature";
    }
  }
  if (!event) {
    return new Response(`Webhook signature failed: ${lastErr}`, { status: 400 });
  }

  let supabase: ReturnType<typeof createServiceClient>;
  try {
    supabase = createServiceClient();
  } catch {
    // Never let a missing service key surface as an unhandled 500 + stack trace.
    return new Response("Server not configured", { status: 500 });
  }

  /**
   * THE ONE WRITER FOR STRIPE MONEY, shared with the Pay Now sheet's own check (lib/record-invoice-
   * payment.ts, 2026-09-30: Rich Seiler's $420 said "approved" on the phone and was never charged;
   * the sheet now asks Stripe and books a succeeded tap itself when this webhook hasn't landed
   * yet). Everything that used to live here — the org<->account and invoice<->org claim, the draft
   * note, the event-id idempotency, the shared recalc, the office push, the fee — lives there now,
   * plus a second lock on the PaymentIntent id so the two writers can never book one tap twice.
   *
   * TRUE ONLY WHEN THE CLAIM HELD AND THE MONEY IS AT REST (this event's row, or a retry that
   * found it and healed it). A caller that writes anything else for this payment (the bank
   * transfer marker, BK3) stands behind this answer, never behind the session's metadata: false
   * means the account does not own the org or the invoice is not the org's, and nothing more may
   * be written in either's name. Every failure that a retry can fix THROWS instead — the handler
   * answers 500, Stripe resends the same event id, and the heal branch settles it.
   */
  async function recordInvoicePayment(
    invoiceId: string | undefined,
    orgId: string | undefined,
    amount: number,
    idempotencyKey: string,
    paymentIntent: string | null,
    connectedAccount: string | null,
    via?: RecordVia,
  ): Promise<boolean> {
    const outcome = await recordStripeInvoicePayment(supabase, { invoiceId, orgId, amount, idempotencyKey, paymentIntent, connectedAccount, via });
    return outcome !== "refused";
  }

  async function syncSubscription(sub: Stripe.Subscription) {
    const orgId = sub.metadata?.org_id;
    const customerId =
      typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    // Resolve the plan from the PRICE ID, which is immutable. `price.nickname` is a
    // free-text field an operator can edit in the Stripe dashboard — renaming it would
    // have silently re-planned every org on it. Storing the price id too gives
    // grandfathering: repricing creates a NEW id and existing orgs keep theirs.
    const priceId = sub.items.data[0]?.price?.id ?? null;
    // PERIOD END MOVED IN A NEWER STRIPE API (audit v921 high). On the "basil" endpoint version,
    // current_period_end lives on the subscription ITEM, not the subscription; reading the old
    // field gives undefined -> new Date(NaN).toISOString() THROWS, which 500s every subscription
    // event and, downstream, lets the card-declined push never fire. Read the item first, fall
    // back to the subscription, and never let a bad timestamp crash the sync.
    const item0 = sub.items.data[0] as { current_period_end?: number } | undefined;
    const subPeriodEnd = (sub as { current_period_end?: number }).current_period_end;
    const periodEndSec =
      typeof item0?.current_period_end === "number"
        ? item0.current_period_end
        : typeof subPeriodEnd === "number"
          ? subPeriodEnd
          : undefined;
    const periodEndIso =
      periodEndSec && Number.isFinite(periodEndSec) ? new Date(periodEndSec * 1000).toISOString() : null;
    const update = {
      subscription_status: sub.status, // active, trialing, past_due, canceled…
      stripe_subscription_id: sub.id,
      plan: tierForPriceId(priceId) ?? sub.items.data[0]?.price?.nickname ?? "crew",
      stripe_price_id: priceId,
      ...(periodEndIso ? { current_period_end: periodEndIso } : {}),
    };
    // Match by org_id metadata if present, else by stripe_customer_id.
    const { data: synced, error: syncErr } = orgId
      ? await supabase.from("organizations").update(update).eq("id", orgId).select("id")
      : await supabase
          .from("organizations")
          .update(update)
          .eq("stripe_customer_id", customerId)
          .select("id");
    // A ZERO-ROW UPDATE IS A 204 (audit v921). This was fire-and-forget: a subscription carrying
    // no org_id metadata whose customer id no org row holds (a comped or dashboard-made one)
    // moved nothing, answered Stripe 200, and left the paywall reading the old state — Stripe
    // says paid, the app says locked, nobody is told. A DB error can be retried, so throw and let
    // Stripe resend it; a no-match can't be, so it goes to the ops log instead.
    if (syncErr) throw new Error(`subscription sync failed: ${syncErr.message}`);
    if (!synced?.length) {
      reportError("stripe:webhook:subscription-no-org", new Error("no organization matched this subscription"), {
        subscriptionId: sub.id,
        orgId: orgId ?? null,
        customerId,
      });
    }
  }

  // CONNECT (0161): events for a DIRECT charge originate on the contractor's own
  // account and arrive here with `event.account` set. The invoice-payment branch below
  // handles them identically — the metadata we attached at checkout carries invoice_id
  // and org_id, so nothing depends on which account the event came from. Subscription
  // events are OURS (no event.account) and must never be read off a connected account.
  const eventAccount = (event as { account?: string }).account ?? null;
  const fromConnectedAccount = !!eventAccount;

  switch (event.type) {
    // A contractor finished (or changed) their Stripe onboarding. Mirror the two facts
    // the pay route trusts. Guarded to the connected account so a platform-level event
    // can never flip a tenant's charging state.
    case "account.updated": {
      const account = event.data.object as Stripe.Account;
      const { data: mirrored, error } = await supabase
        .from("organizations")
        .update(accountUpdateFields(account))
        .eq("stripe_account_id", account.id)
        .select("id");
      if (error) {
        return new Response(`account.updated sync failed: ${error.message}`, { status: 500 });
      }
      // The error check alone missed the 204 (audit v921): no org holds this stripe_account_id,
      // so the tenant's charging state never moved. Stripe retrying won't find the row, so say so
      // where the daily ops triage reads instead of 500-ing forever.
      if (!mirrored?.length) {
        reportError("stripe:webhook:account-no-org", new Error("no organization holds this stripe_account_id"), {
          accountId: account.id,
        });
      }
      break;
    }
    // A card was declined. Stripe Smart Retries keep trying in the background; our job
    // is to mirror the state (which starts the grace clock) and TELL the owner, because
    // the failure is silent to them otherwise until the day access stops.
    case "invoice.payment_failed": {
      const inv = event.data.object as Stripe.Invoice;
      if (!fromConnectedAccount && inv.subscription) {
        const sub = await getStripe().subscriptions.retrieve(inv.subscription as string);
        await syncSubscription(sub);
        const customerId = typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
        const { data: org } = await supabase
          .from("organizations")
          .select("id")
          .eq("stripe_customer_id", customerId ?? "")
          .maybeSingle();
        const orgId = (org as { id?: string } | null)?.id;
        if (orgId) {
          await notifyPeople(orgId, await orgStaffIds(orgId), "invoice_paid", {
            title: "Card declined",
            body: "Your Contractor North payment didn't go through. Update your card to keep the crew working.",
            url: "/settings",
          });
        }
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      // Our OWN billing only. A subscription living on a contractor's connected account
      // is their business with their customers, not our paywall.
      if (!fromConnectedAccount) await syncSubscription(event.data.object as Stripe.Subscription);
      break;
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.metadata?.kind === "invoice_payment") {
        /**
         * MONEY IS RECORDED WHEN IT SETTLES, NOT WHEN THE PAGE FINISHES (audit 8).
         *
         * `completed` only means the customer finished the Checkout flow. For a delayed method
         * — US bank debit, which a tenant can switch on in their own Express dashboard without
         * telling us — the funds are days away and can still FAIL. Recording it as paid marks
         * the invoice settled, stops the reminders, and shows the customer a paid receipt for
         * money that never arrives. payment_status is the settlement fact; Stripe sends either
         * completed(paid) OR completed(unpaid) followed by an async event, so this gate — not
         * the event-id unique index — is what keeps one payment from being booked twice.
         */
        const pi =
          typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);
        const bank = isBankCheckout(session);
        const credit = invoiceCredit((session.amount_total ?? 0) / 100, session.metadata);
        if (session.payment_status === "paid") {
          const landed = await recordInvoicePayment(
            session.metadata.invoice_id,
            session.metadata.org_id,
            credit,
            event.id,
            pi,
            eventAccount,
            // BK2: booked under the method it was actually paid with, and said that way.
            bank
              ? { note: "Online bank transfer", said: "paid by bank transfer", method: checkoutPaymentMethod(session) }
              : { note: "Online payment", said: "paid online", method: checkoutPaymentMethod(session) },
          );
          // BK3: a debit that was on its way has landed. Only after the money is booked (the
          // helper throws on anything that did not come to rest, and Stripe retries the event), and
          // only when the claim held: `landed` is false when the account does not own the org or
          // the invoice is not the org's, and then no marker is written in their name either.
          if (landed && bank && pi && session.metadata.invoice_id && session.metadata.org_id) {
            const done = await resolveTransfer(supabase, {
              orgId: session.metadata.org_id,
              invoiceId: session.metadata.invoice_id,
              paymentIntent: pi,
              checkoutSession: session.id ?? null,
              amount: credit,
              status: "cleared",
            });
            // A MARKER THAT DID NOT MOVE IS RETRIED, NEVER ACKED. A pending row left behind keeps
            // both Pay buttons hidden on a paid-but-partial invoice and the reminders quiet, for a
            // week, with the failure only in the ops log. Throwing answers 500 and Stripe resends
            // this event: the payment insert hits 23505 and heals without a second push, and
            // resolveTransfer moves only a row still 'pending'. A database before 0338 has no
            // marker to move ('no_table') and is acked.
            if (done.outcome === "failed") {
              reportError("stripe:webhook:bank-transfer-clear", done.error, { invoiceId: session.metadata.invoice_id, pi });
              throw new Error(`clearing the bank transfer marker for invoice ${session.metadata.invoice_id} failed`);
            }
          }
        } else if (event.type === "checkout.session.completed" && bank && pi) {
          /**
           * A BANK DEBIT STARTED (audit v994 BK3, 0338). completed(unpaid) books NO money - the
           * debit is days away and can still fail - but it is not nothing either: the invoice would
           * sit at its full balance with both Pay buttons, and the reminder cron would chase a
           * customer whose money is already moving. So a marker is written that no total reads, the
           * customer's page and /api/pay stop a second payment, and the office is told once.
           */
          const orgId = session.metadata.org_id;
          const invoiceId = session.metadata.invoice_id;
          const target = orgId && invoiceId ? await claimedInvoice(supabase, invoiceId, orgId, eventAccount) : null;
          if (target && orgId && invoiceId) {
            const started = await noteTransferStarted(supabase, {
              orgId,
              invoiceId,
              paymentIntent: pi,
              checkoutSession: session.id ?? null,
              amount: credit,
            });
            if (started.outcome === "failed") {
              // Retried, never acked (see the cleared branch above): with no marker the invoice
              // keeps both Pay buttons and the reminders chase a customer whose money is moving -
              // the second-payment door this marker exists to close. The upsert ignores a
              // duplicate, so Stripe's resend writes it once and tells the office once.
              reportError("stripe:webhook:bank-transfer-start", started.error, { invoiceId, pi });
              throw new Error(`marking the bank transfer on invoice ${invoiceId} as on its way failed`);
            } else if (started.outcome === "no_table") {
              reportError("stripe:webhook:bank-transfer-start", new Error("pending_bank_transfers is missing: migration 0338 is not applied"), { invoiceId, pi });
            } else if (started.outcome === "noted") {
              try {
                const { data: who } = await supabase
                  .from("invoices")
                  .select("customers(name)")
                  .eq("id", invoiceId)
                  .eq("org_id", orgId)
                  .maybeSingle();
                const cust = (who as { customers?: { name?: string | null } | null } | null)?.customers?.name;
                await notifyPeople(orgId, await orgStaffIds(orgId), "invoice_paid", {
                  title: "Bank transfer on its way",
                  body: `${formatCurrency(credit)} by bank transfer on ${target.invoice_number || "an invoice"}${cust ? ` — ${cust}` : ""}. It takes a few business days to clear, and nothing is recorded until it does. Don't record it by hand.`,
                  url: `/billing/${invoiceId}`,
                });
              } catch (e) {
                // The marker is written; only the courtesy failed. Never make Stripe retry for it.
                reportError("stripe:webhook:bank-transfer-start-push", e, { invoiceId });
              }
            }
          }
        }
      } else if (session.subscription && !fromConnectedAccount) {
        const sub = await getStripe().subscriptions.retrieve(
          session.subscription as string,
        );
        await syncSubscription(sub);
      }
      break;
    }
    /**
     * A BANK DEBIT THAT DID NOT GO THROUGH (audit v994 BK3). Nothing was ever booked for it - the
     * money is only recorded on async_payment_succeeded - so the invoice was open all along and
     * stays open. What changes is the marker: it ends as 'failed', /i offers Pay again, reminders
     * may chase again, and the office is told once, in words, so nobody waits on money that is not
     * coming. NEVER WRITES A PAYMENT. Behind the same org<->account and invoice<->org checks.
     */
    case "checkout.session.async_payment_failed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.metadata?.kind !== "invoice_payment") break;
      const orgId = session.metadata.org_id;
      const invoiceId = session.metadata.invoice_id;
      const pi = typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);
      if (!orgId || !invoiceId || !pi) break;
      const target = await claimedInvoice(supabase, invoiceId, orgId, eventAccount);
      if (!target) break;
      const amount = invoiceCredit((session.amount_total ?? 0) / 100, session.metadata);
      const ended = await resolveTransfer(supabase, {
        orgId,
        invoiceId,
        paymentIntent: pi,
        checkoutSession: session.id ?? null,
        amount,
        status: "failed",
      });
      if (ended.outcome === "failed") {
        // Retried, never acked: a marker left 'pending' hides both Pay buttons, silences the
        // reminders and sends no word to the office that the debit bounced, and a week later the
        // stale alert says it "has not cleared or failed", which is false. Throwing answers 500
        // and Stripe resends this event; the update moves only a row still 'pending', and the push
        // below fires only on 'resolved' or 'recorded', so the retry tells the office exactly once.
        reportError("stripe:webhook:bank-transfer-fail", ended.error, { invoiceId, pi });
        throw new Error(`ending the bank transfer marker for invoice ${invoiceId} failed`);
      } else if (ended.outcome === "no_table") {
        reportError("stripe:webhook:bank-transfer-fail", new Error("pending_bank_transfers is missing: migration 0338 is not applied"), { invoiceId, pi });
      }
      // Said once: a retried event finds the row already ended ('already') and stays quiet. The
      // customer believes they paid (audit 8), so the office has to hear it. A courtesy that can
      // never fail the webhook.
      if (ended.outcome === "resolved" || ended.outcome === "recorded" || ended.outcome === "no_table") {
        try {
          await notifyPeople(orgId, await orgStaffIds(orgId), "invoice_paid", {
            title: "Bank transfer failed",
            body: `${formatCurrency(amount)} by bank transfer on ${target.invoice_number || "an invoice"} didn't go through. Nothing was recorded, and the invoice is still open.`,
            url: `/billing/${invoiceId}`,
          });
        } catch (e) {
          reportError("stripe:webhook:bank-transfer-fail-push", e, { invoiceId });
        }
      }
      break;
    }
    /**
     * MONEY THAT WENT BACK OUT (audit 8). A contractor refunds an online payment from their own
     * Stripe dashboard, or a customer disputes one — CN never heard about either, so the invoice
     * still read paid-in-full while the cash was gone: A/R, job profitability, the customer's
     * own paid invoice, all asserting money the org no longer has. We do NOT rewrite the
     * invoice from here (a refund is a business decision with its own disposition, and the
     * office owns that call) — we make sure a human is told the moment it happens.
     */
    case "charge.refunded":
    case "charge.dispute.created": {
      const charge = event.data.object as Stripe.Charge & { payment_intent?: string | null };
      try {
        /**
         * THIS ALERT HAD NEVER FIRED, AND COULD NOT (audit v800 wave B).
         *
         * The lookup was `.eq("stripe_event_id", charge.payment_intent)`. stripe_event_id holds
         * an `evt_…`; payment_intent is a `pi_…`. Two id namespaces that can never collide, so
         * the match returned null every time, orgId was always null, and the `if (orgId)` below
         * meant the notification was unreachable code wearing a comment that called it
         * "best-effort". Migration 0220 gives the payments row somewhere to keep the pi_.
         *
         * TWO INDEPENDENT PATHS, because they fail differently and this alert must not be
         * silently droppable — money left the business and the invoice still says it didn't:
         *
         *   the PAYMENT tells us which invoice, so the notification can deep-link it;
         *   the ORG comes from event.account (Connect direct charges land on the tenant's own
         *   account), so the alert still goes out when the payment row is missing entirely —
         *   a refund of a payment recorded by hand, or of anything taken before 0220.
         */
        const pi = charge.payment_intent ?? "";
        const { data: pay } = pi
          ? await supabase
              .from("payments")
              .select("invoice_id, org_id, amount")
              .eq("stripe_payment_intent", pi)
              .maybeSingle()
          : { data: null };

        let orgId = (pay as { org_id?: string } | null)?.org_id ?? null;
        const connectedAccount = (event as { account?: string }).account ?? null;
        if (!orgId && connectedAccount) {
          const { data: org } = await supabase
            .from("organizations")
            .select("id")
            .eq("stripe_account_id", connectedAccount)
            .maybeSingle();
          orgId = (org as { id?: string } | null)?.id ?? null;
        }
        if (orgId) {
          const disputed = event.type === "charge.dispute.created";
          await notifyPeople(orgId, await orgStaffIds(orgId), "invoice_paid", {
            title: disputed ? "A card payment was disputed" : "An online payment was refunded",
            body: disputed
              ? "The customer's bank opened a dispute — the invoice still reads paid until you decide how to record it."
              : "The refund left Stripe — the invoice still reads paid until you record it here.",
            url: (pay as { invoice_id?: string } | null)?.invoice_id
              ? `/billing/${(pay as { invoice_id?: string }).invoice_id}`
              : "/billing",
          });
        }
      } catch {
        /* alerting is best-effort; never fail the webhook */
      }
      break;
    }
    /**
     * TAP TO PAY ON IPHONE — the phone was the card reader (2026-09-10, migration 0252).
     *
     * The tech's iPhone collected and confirmed a `card_present` PaymentIntent that
     * createTapPaymentIntent (billing/tap-actions.ts) minted ON the tenant's connected account, so
     * the event arrives on the connected-accounts endpoint with event.account set. Nothing
     * client-side writes the payment — the plugin doesn't even hand the confirmed PaymentIntent
     * back to JS — so this branch is the ONE place a tap becomes money on the invoice, through the
     * same recordInvoicePayment as an online payment (org↔account ownership check, invoice↔org
     * check, event-id idempotency, the shared recalc, the office push).
     *
     * ── THE DOUBLE-BOOKING HAZARD, AND WHY THE GATE IS METADATA, NOT THE EVENT ID ─────────────
     *
     * A hosted-Checkout payment ALSO emits payment_intent.succeeded. Checkout creates a
     * PaymentIntent under the hood, /api/pay stamps it with payment_intent_data.metadata
     * { invoice_id, org_id }, and Stripe then sends BOTH checkout.session.completed AND
     * payment_intent.succeeded for the same money — under two DIFFERENT event ids. The
     * checkout branch above already books the first; the stripe_event_id unique index cannot
     * stop the second, because it is a different event. An ungated branch here keyed on
     * invoice_id would therefore insert a second payments row for every online payment, and the
     * invoice would read overpaid (or $0 owed twice over) with the customer charged once.
     *
     * So this branch books ONLY what carries the marker no Checkout PaymentIntent has:
     *   metadata.source === "tap_to_pay"   — set solely by createTapPaymentIntent
     *   metadata.kind   === "invoice_payment" and an invoice_id — what recordInvoicePayment needs
     *   payment_method_types includes "card_present" — belt to the braces: Checkout never creates
     *                                                   a card_present PI, so even a copied
     *                                                   metadata blob could not slip through.
     * Everything else that arrives as payment_intent.succeeded — Checkout PIs, our own
     * subscription PIs on the platform account — falls through untouched. The checkout branch
     * is not changed by this.
     *
     * ── A DRAFT DOES NOT BECOME A BILL HERE (Connected North Phase 1) ─────────────────────────
     *
     * cn-v961 moved the draft's promotion here, "at the money", after opening the sheet had sent
     * Erik's half-built $6,412 INV-069. It was the same silent send one step later. A draft
     * becomes a bill when a person sends it: the tap door asks first and sends it on the yes
     * (createTapPaymentIntent), so this branch only settles, like every other.
     */
    case "payment_intent.succeeded": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const md = pi.metadata ?? {};
      const isTap =
        fromConnectedAccount &&
        md.source === "tap_to_pay" &&
        md.kind === "invoice_payment" &&
        !!md.invoice_id &&
        (pi.payment_method_types ?? []).includes("card_present");
      if (isTap) {
        await recordInvoicePayment(
          md.invoice_id,
          md.org_id,
          // amount_received is the settled figure; with capture_method automatic it equals amount.
          invoiceCredit((pi.amount_received ?? 0) / 100, pi.metadata as Record<string, string> | null),
          // NOT event.id: the key is derived from the PaymentIntent, the same one the Pay Now
          // sheet's own check books under (tapPaymentOutcome), so whichever writer is second hits
          // the unique index. A resend of this event carries the same pi.id, so it is still a
          // retry, not a second payment.
          tapPaymentKey(pi.id),
          pi.id,
          eventAccount,
          // Settles, never sends: createTapPaymentIntent mints on a draft only after the person said
          // yes to "Send INV-078 as the bill first?" and it was sent (lib/pay-door-send).
          TAP_VIA,
        );
      }
      break;
    }
    /**
     * TAP TO PAY ON IPHONE — THE CARD WAS DECLINED AND THE TECH MAY NOT HAVE SEEN IT (Apple 5.12).
     *
     * Apple: "When a transaction is not approved but the user has already closed the app before
     * seeing the result, ensure they receive a notification indicating this outcome." The phone
     * confirms the PaymentIntent itself; if the tech pockets the phone mid-confirm, the app is
     * backgrounded, the reader session ends, and the Declined screen is never on their eyes. Stripe
     * still emits payment_intent.payment_failed on the connected account — this is the one signal
     * that survives the app being closed, so it is the one that buzzes the phone.
     *
     * ONLY THE PERSON WHO HELD THE READER. metadata.user_id is stamped by createTapPaymentIntent
     * from the caller's session; a decline is that tech's moment, not the office's. Gated EXACTLY
     * like the succeeded branch above (connected account + tap marker + invoice kind + card_present)
     * so a Checkout PI's failure — which fires the same event — never reaches this. The metadata is
     * still a CLAIM (audit v921): the org must own the connected account the event came from, and
     * the user must belong to that org, or a copied metadata blob could buzz another tenant's phone
     * with an invoice number and a dollar figure.
     *
     * NEVER WRITES. Nothing was charged, so there is nothing to record; the invoice stays open and
     * the tech's screen (if they are still on it) already shows the decline with a Try Again. The
     * push is the whole effect — one per decline, which is also why it is not de-duplicated: a
     * second tap that declines again is a second thing worth hearing. A courtesy that can never
     * fail the webhook.
     */
    case "payment_intent.payment_failed": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const md = pi.metadata ?? {};
      const isTap =
        fromConnectedAccount &&
        md.source === "tap_to_pay" &&
        md.kind === "invoice_payment" &&
        !!md.invoice_id &&
        (pi.payment_method_types ?? []).includes("card_present");
      if (!isTap) break;
      try {
        const userId = md.user_id;
        if (!userId || !md.org_id) {
          // A tap PI minted before user_id was stamped (a deploy-window straggler). Nothing to
          // push to — but a decline nobody hears about is the exact silence 5.12 forbids, so it
          // goes to the ops log rather than nowhere.
          reportError("stripe:webhook:tap-declined-no-user", new Error("tap_to_pay PaymentIntent failed with no user_id in metadata"), {
            paymentIntentId: pi.id,
            invoiceId: md.invoice_id,
            orgId: md.org_id ?? null,
          });
          break;
        }
        // The org must own the account the event came from …
        const { data: owner } = await supabase
          .from("organizations")
          .select("id")
          .eq("id", md.org_id)
          .eq("stripe_account_id", eventAccount ?? "")
          .maybeSingle();
        if (!owner) {
          reportError("stripe:webhook:tap-declined-account-org-mismatch", new Error("tap PaymentIntent names an org that doesn't own the connected account"), {
            orgId: md.org_id,
            invoiceId: md.invoice_id,
            connectedAccount: eventAccount,
          });
          break;
        }
        // … the invoice must be the org's (and its number is what the push names) …
        const { data: inv } = await supabase
          .from("invoices")
          .select("id, invoice_number")
          .eq("id", md.invoice_id)
          .eq("org_id", md.org_id)
          .maybeSingle();
        // … and the person must be in that org. The push (notifyPeople) handles `active` and the
        // per-user toggle; the org membership is the tenant boundary and is checked HERE.
        const { data: who } = await supabase
          .from("profiles")
          .select("id")
          .eq("id", userId)
          .eq("org_id", md.org_id)
          .maybeSingle();
        if (!inv || !who) {
          reportError("stripe:webhook:tap-declined-mismatch", new Error("tap PaymentIntent names an invoice or user outside its org"), {
            orgId: md.org_id,
            invoiceId: md.invoice_id,
            userId,
            invoiceFound: !!inv,
            userFound: !!who,
          });
          break;
        }
        const number = (inv as { invoice_number?: string | null }).invoice_number;
        // Its own notification kind (Settings → Notifications → "Tap to Pay on iPhone"), not
        // "invoice_paid": 5.12 is an Apple requirement, and muting paid-invoice buzzes must not
        // silently mute it too. Full name in the title — Apple allows "Tap to Pay" on a button
        // only, and a lock-screen line is a sentence.
        // On his own bell too (notifyPeople): the decline he may never have seen stays there to read.
        await notifyPeople(md.org_id, [userId], "tap_to_pay", {
          title: "Card declined — Tap to Pay on iPhone",
          body: `${formatCurrency((pi.amount ?? 0) / 100)} by Tap to Pay on iPhone on ${number ? `invoice ${number}` : "an invoice"} wasn't approved — ${declineReason(pi.last_payment_error)}. Nothing was charged; the invoice is still open.`,
          url: `/billing/${md.invoice_id}`,
        });
      } catch (e) {
        // Best effort: a push that can't go out must not 500 Stripe into retrying a decline.
        reportError("stripe:webhook:tap-declined-push", e, { paymentIntentId: pi.id });
      }
      break;
    }
    default:
      break;
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { "Content-Type": "application/json" },
  });
}
