import { getStripe } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/server";
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

  const supabase = createServiceClient();

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
    const { data: pays } = await supabase
      .from("payments")
      .select("amount")
      .eq("invoice_id", invoiceId);
    const { data: inv } = await supabase
      .from("invoices")
      .select("total, status")
      .eq("id", invoiceId)
      .single();
    const paid =
      (pays ?? []).reduce((s: number, p: any) => s + Number(p.amount ?? 0), 0);
    let status = inv?.status ?? "sent";
    if (status !== "void") {
      const total = Number(inv?.total ?? 0);
      status = paid >= total && total > 0 ? "paid" : paid > 0 ? "partial" : status;
    }
    await supabase
      .from("invoices")
      .update({ amount_paid: paid, status })
      .eq("id", invoiceId);
  }

  async function syncSubscription(sub: Stripe.Subscription) {
    const orgId = sub.metadata?.org_id;
    const customerId =
      typeof sub.customer === "string" ? sub.customer : sub.customer.id;
    const update = {
      subscription_status: sub.status, // active, trialing, past_due, canceled…
      stripe_subscription_id: sub.id,
      plan: sub.items.data[0]?.price?.nickname || "pro",
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

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await syncSubscription(event.data.object as Stripe.Subscription);
      break;
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.metadata?.kind === "invoice_payment") {
        await recordInvoicePayment(
          session.metadata.invoice_id,
          session.metadata.org_id,
          (session.amount_total ?? 0) / 100,
          event.id,
        );
      } else if (session.subscription) {
        const sub = await getStripe().subscriptions.retrieve(
          session.subscription as string,
        );
        await syncSubscription(sub);
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
