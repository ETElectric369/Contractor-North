import { NextResponse } from "next/server";
import { getStripe, billingEnabled } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/server";
import { invoiceBalance } from "@/lib/invoice-math";
import { connectStateFromOrg, canAcceptPayments } from "@/lib/stripe-connect";

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
    .select("id, invoice_number, total, amount_paid, status, org_id, customers(email)")
    .eq("public_token", token)
    .maybeSingle();
  if (!inv) return new NextResponse("Invoice not found.", { status: 404 });

  // A VOID invoice's old email link stays live forever; a customer paying it hands us cash
  // the ledger then hides (recalc keeps status void, Collected and AR both exclude void), so
  // real money would sit with no entry and no tracked refund. A DRAFT isn't a bill yet — the
  // office may still be editing the lines. Neither is payable: send them to read-only view.
  if (inv.status === "void" || inv.status === "draft") {
    return NextResponse.redirect(`${site}/i/${token}`, { status: 303 });
  }

  const balance = invoiceBalance(inv.total, inv.amount_paid);
  if (balance <= 0) {
    return NextResponse.redirect(`${site}/i/${token}?paid=1`, { status: 303 });
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("name, stripe_account_id, stripe_account_status, stripe_charges_enabled")
    .eq("id", inv.org_id)
    .maybeSingle();

  // CONNECT (0161): the charge is created ON THE CONTRACTOR'S OWN Stripe account, so
  // their customer's money goes to their bank — we never hold it. Refuse rather than
  // fall back to the platform account: a silent fallback is exactly how a platform ends
  // up holding other people's money.
  const connect = connectStateFromOrg((org ?? {}) as any);
  if (!canAcceptPayments(connect)) {
    return new NextResponse(
      "This contractor hasn't finished setting up online payments yet. Please pay by check or call them.",
      { status: 503 },
    );
  }

  const stripe = getStripe();
  const session = await stripe.checkout.sessions.create(
    {
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
      // org_id rides along because on a direct charge the webhook arrives with the
      // CONNECTED account's context, not ours — this is how we know whose invoice it is.
      metadata: { kind: "invoice_payment", invoice_id: inv.id, org_id: inv.org_id },
      payment_intent_data: { metadata: { invoice_id: inv.id, org_id: inv.org_id } },
    },
    // THE line that makes it a direct charge.
    { stripeAccount: connect.accountId! },
  );

  return NextResponse.redirect(session.url!, { status: 303 });
}
