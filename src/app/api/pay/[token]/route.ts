import { NextResponse } from "next/server";
import { getOrgSettings, orgPublicBaseUrl } from "@/lib/org-settings";
import { getStripe, billingEnabled } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/server";
import { invoiceBalance } from "@/lib/invoice-math";
import { connectStateFromOrg, canAcceptPayments } from "@/lib/stripe-connect";
import { rateLimited, clientIp } from "@/lib/rate-limit";
import { reportError } from "@/lib/observe";

export const runtime = "nodejs";

/**
 * Opens a Stripe Checkout session to pay an invoice by its public token.
 * Used by the "Pay now" button on the public invoice page and "Collect payment"
 * in-app (works on any phone/tablet browser — card, Apple Pay, Google Pay).
 *   GET /api/pay/<invoice_public_token>
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  // audit v921: every other public route carries a limiter and this one didn't — one leaked
  // invoice link (or a crawler following it) could loop this GET and mint unbounded Checkout
  // Sessions on the CONTRACTOR'S OWN Stripe account, which is their dashboard, not ours.
  if (
    (await rateLimited(`pay:${token}`, 10, 60)) ||
    (await rateLimited(`pay-ip:${clientIp(req.headers)}`, 30, 60))
  ) {
    return new NextResponse("Too many payment attempts in a row — give it a minute.", { status: 429 });
  }

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

  // The org is fetched HERE, above the early redirects, because every URL below has to be built
  // on the CONTRACTOR'S own domain. It used to come from NEXT_PUBLIC_SITE_URL, so a customer who
  // opened their invoice on the contractor's site, tapped Pay, and paid, landed back on the
  // software vendor's domain — three hosts in one payment, the last one a company they have never
  // heard of, on the screen that confirms money left their account.
  const { data: org } = await supabase
    .from("organizations")
    .select("name, settings, stripe_account_id, stripe_account_status, stripe_charges_enabled")
    .eq("id", inv.org_id)
    .maybeSingle();
  const site = orgPublicBaseUrl(getOrgSettings((org as { settings?: unknown } | null)?.settings));

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

  // CONNECT (0161): the charge is created ON THE CONTRACTOR'S OWN Stripe account, so
  // their customer's money goes to their bank — we never hold it. Refuse rather than
  // fall back to the platform account: a silent fallback is exactly how a platform ends
  // up holding other people's money.
  const connect = connectStateFromOrg((org ?? {}) as any);
  if (!canAcceptPayments(connect)) {
    // audit v921: this used to answer a bare text/plain 503 — a customer who tapped "Pay now" on
    // the contractor's own page landed on an unstyled dead end with no way back to their bill.
    // Send them back to the invoice, which says why (?pay=unavailable), like every other refusal
    // in this route does.
    return NextResponse.redirect(`${site}/i/${token}?pay=unavailable`, { status: 303 });
  }

  // Stripe refuses a card charge under $0.50, and both Pay buttons gate only on balance > 0 — a
  // partial payment leaving $0.30 owed used to reach sessions.create and throw, so the customer
  // got Next's blank 500 (audit v921). Say it on the invoice instead.
  if (balance < 0.5) {
    return NextResponse.redirect(`${site}/i/${token}?pay=too_small`, { status: 303 });
  }

  const stripe = getStripe();
  try {
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
    if (!session.url) {
      reportError("pay.checkout", "Stripe returned a session with no url", { org_id: inv.org_id, invoice_id: inv.id });
      return NextResponse.redirect(`${site}/i/${token}?pay=failed`, { status: 303 });
    }
    return NextResponse.redirect(session.url, { status: 303 });
  } catch (e) {
    // ANY Stripe-side refusal (a capability that lapsed since account.updated last spoke, a key
    // in the wrong mode, an amount it won't take) used to escape as a raw 500 on the contractor's
    // own domain. The customer goes back to their invoice with a reason; the operator gets the
    // real error in error_events (audit v921).
    reportError("pay.checkout", e, { org_id: inv.org_id, invoice_id: inv.id });
    return NextResponse.redirect(`${site}/i/${token}?pay=failed`, { status: 303 });
  }
}
