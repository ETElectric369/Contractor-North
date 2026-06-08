import { NextResponse } from "next/server";
import { getStripe, billingEnabled } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Opens a Stripe Checkout session to pay an invoice by its public token.
 * Used by the "Pay now" button on the public invoice page and "Collect payment"
 * in-app (works on any phone/tablet browser — card, Apple Pay, Google Pay).
 *   GET /api/pay/<invoice_public_token>
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const site = process.env.NEXT_PUBLIC_SITE_URL || "";

  if (!billingEnabled) {
    return new NextResponse(
      "Online payments aren't set up yet. Add STRIPE_SECRET_KEY to enable.",
      { status: 503 },
    );
  }

  let supabase;
  try {
    supabase = createServiceClient();
  } catch {
    return new NextResponse("Server not configured.", { status: 500 });
  }

  const { data: inv } = await supabase
    .from("invoices")
    .select("id, invoice_number, total, amount_paid, org_id, customers(email)")
    .eq("public_token", token)
    .maybeSingle();
  if (!inv) return new NextResponse("Invoice not found.", { status: 404 });

  const balance = Number(inv.total) - Number(inv.amount_paid);
  if (balance <= 0) {
    return NextResponse.redirect(`${site}/i/${token}?paid=1`, { status: 303 });
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", inv.org_id)
    .maybeSingle();

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: `${org?.name ?? ""} Invoice ${inv.invoice_number}`.trim() },
          unit_amount: Math.round(balance * 100),
        },
        quantity: 1,
      },
    ],
    customer_email: (inv as any).customers?.email ?? undefined,
    success_url: `${site}/i/${token}?paid=1`,
    cancel_url: `${site}/i/${token}`,
    metadata: { kind: "invoice_payment", invoice_id: inv.id, org_id: inv.org_id },
    payment_intent_data: { metadata: { invoice_id: inv.id } },
  });

  return NextResponse.redirect(session.url!, { status: 303 });
}
