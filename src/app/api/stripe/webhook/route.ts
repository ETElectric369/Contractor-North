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
      if (session.subscription) {
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
