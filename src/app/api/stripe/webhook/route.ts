import { invoiceOverpayment } from "@/lib/invoice-math";
import { getStripe } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/server";
import { sendPushToProfiles, orgStaffIds } from "@/lib/push";
import { formatCurrency } from "@/lib/utils";
import { recalcInvoice } from "@/lib/invoice-recalc";
import { accountUpdateFields } from "@/lib/stripe-connect";
import { tierForPriceId } from "@/lib/plans";
import type Stripe from "stripe";

export const runtime = "nodejs";

/**
 * Stripe webhook: keeps organizations.subscription_status / plan in sync.
 * Configure the endpoint URL in Stripe → Developers → Webhooks, and set
 * STRIPE_WEBHOOK_SECRET. Listens for subscription + checkout events.
 */
export async function POST(req: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return new Response("STRIPE_WEBHOOK_SECRET not configured", { status: 503 });
  }

  const sig = req.headers.get("stripe-signature");
  if (!sig) return new Response("Missing signature", { status: 400 });

  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(body, sig, secret);
  } catch (e: any) {
    return new Response(`Webhook signature failed: ${e?.message}`, { status: 400 });
  }

  let supabase: ReturnType<typeof createServiceClient>;
  try {
    supabase = createServiceClient();
  } catch {
    // Never let a missing service key surface as an unhandled 500 + stack trace.
    return new Response("Server not configured", { status: 500 });
  }

  async function recordInvoicePayment(
    invoiceId: string | undefined,
    orgId: string | undefined,
    amount: number,
    eventId: string,
  ) {
    if (!invoiceId || !orgId || amount <= 0) return;
    // org_id is set explicitly (the set_org_id trigger has no auth context here).
    // Idempotency: stripe_event_id is UNIQUE, so a retried webhook (Stripe resends
    // the SAME event.id on timeout) fails the insert and we stop — no double pay.
    const { error: insErr } = await supabase.from("payments").insert({
      invoice_id: invoiceId,
      org_id: orgId,
      amount,
      method: "card",
      note: "Online payment",
      stripe_event_id: eventId,
    });
    if (insErr) {
      if ((insErr as { code?: string }).code === "23505") return; // already recorded this event
      throw new Error(insErr.message);
    }
    // Settle through THE shared recalc (items + payments + open customer credits) instead
    // of a local payments-only sum. The old code blind-wrote `amount_paid = sum(payments)`,
    // which ERASED any posted credit: a $200 account credit + an $800 card payment on a
    // $1,000 invoice came back as $800 paid / status "partial", so the invoice kept a
    // phantom $200 balance forever — aged in A/R, dunned by the reminder cron, and payable
    // a SECOND time on the public page. One definition, both paths agree by construction.
    await recalcInvoice(supabase, invoiceId);
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
    await sendPushToProfiles(await orgStaffIds(orgId), "invoice_paid", over > 0.005
      ? {
          title: "Overpaid — action needed",
          body: `${formatCurrency(amount)} paid online on ${inv?.invoice_number || "an invoice"}${cust ? ` — ${cust}` : ""}. That's ${formatCurrency(over)} MORE than the total. Credit it or refund it.`,
          url: `/billing/${invoiceId}`,
        }
      : {
          title: "Payment received",
          body: `${formatCurrency(amount)} paid online on ${inv?.invoice_number || "an invoice"}${cust ? ` — ${cust}` : ""}`,
          url: `/billing/${invoiceId}`,
        });
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
    const update = {
      subscription_status: sub.status, // active, trialing, past_due, canceled…
      stripe_subscription_id: sub.id,
      plan: tierForPriceId(priceId) ?? sub.items.data[0]?.price?.nickname ?? "crew",
      stripe_price_id: priceId,
      current_period_end: new Date(sub.current_period_end * 1000).toISOString(),
    };
    // Match by org_id metadata if present, else by stripe_customer_id.
    if (orgId) {
      await supabase.from("organizations").update(update).eq("id", orgId);
    } else {
      await supabase
        .from("organizations")
        .update(update)
        .eq("stripe_customer_id", customerId);
    }
  }

  // CONNECT (0161): events for a DIRECT charge originate on the contractor's own
  // account and arrive here with `event.account` set. The invoice-payment branch below
  // handles them identically — the metadata we attached at checkout carries invoice_id
  // and org_id, so nothing depends on which account the event came from. Subscription
  // events are OURS (no event.account) and must never be read off a connected account.
  const fromConnectedAccount = !!(event as { account?: string }).account;

  switch (event.type) {
    // A contractor finished (or changed) their Stripe onboarding. Mirror the two facts
    // the pay route trusts. Guarded to the connected account so a platform-level event
    // can never flip a tenant's charging state.
    case "account.updated": {
      const account = event.data.object as Stripe.Account;
      const { error } = await supabase
        .from("organizations")
        .update(accountUpdateFields(account))
        .eq("stripe_account_id", account.id);
      if (error) {
        return new Response(`account.updated sync failed: ${error.message}`, { status: 500 });
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
          await sendPushToProfiles(await orgStaffIds(orgId), "invoice_paid", {
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
        if (session.payment_status === "paid") {
          await recordInvoicePayment(
            session.metadata.invoice_id,
            session.metadata.org_id,
            (session.amount_total ?? 0) / 100,
            event.id,
          );
        }
      } else if (session.subscription && !fromConnectedAccount) {
        const sub = await getStripe().subscriptions.retrieve(
          session.subscription as string,
        );
        await syncSubscription(sub);
      }
      break;
    }
    case "checkout.session.async_payment_failed": {
      // Nothing to unwind — the payment_status gate above means nothing was ever recorded.
      // But the customer believes they paid, so the office has to hear it (audit 8).
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.metadata?.kind === "invoice_payment" && session.metadata.org_id) {
        try {
          await sendPushToProfiles(await orgStaffIds(session.metadata.org_id), "invoice_paid", {
            title: "A customer's payment failed",
            body: "Their bank declined the transfer after checkout — the invoice is still open.",
            url: `/billing/${session.metadata.invoice_id}`,
          });
        } catch {
          /* the push is a courtesy; never fail the webhook on it */
        }
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
