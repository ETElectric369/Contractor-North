import { NextResponse } from "next/server";
import {
  getOrgSettings,
  orgPublicBaseUrl,
  parsePayMethod,
  cardFeeDecision,
  feePctLabel,
} from "@/lib/org-settings";
import { getStripe, billingEnabled } from "@/lib/stripe";
import { createServiceClient } from "@/lib/supabase/server";
import { invoiceBalance } from "@/lib/invoice-math";
import { connectStateFromOrg, canAcceptPayments } from "@/lib/stripe-connect";
import { rateLimited, clientIp } from "@/lib/rate-limit";
import { reportError } from "@/lib/observe";

export const runtime = "nodejs";

/**
 * "BANK TRANSFER ISN'T SWITCHED ON" IS A DIFFERENT SENTENCE FROM "SOMETHING WENT WRONG".
 *
 * us_bank_account (ACH debit) is a capability the CONTRACTOR enables in their own Stripe
 * dashboard; we hold no key on their account and cannot read it from here. So the bank door is
 * offered, and a refusal is read out of the error Stripe throws rather than guessed at. Stripe
 * answers an un-activated method with an invalid_request on the payment_method_types param,
 * naming the type — that is a permanent no and the customer needs to hear it in words. A timeout,
 * a key in the wrong mode, a network blip: those are "try again", and telling that customer their
 * contractor doesn't take bank transfers would be a plain lie. Matched loosely on purpose (param,
 * code, or the type named in the message) because Stripe has worded this one three ways.
 */
function bankMethodRefused(e: unknown): boolean {
  const err = (e ?? {}) as { code?: string; param?: string; message?: string; raw?: { message?: string; param?: string } };
  const param = String(err.param ?? err.raw?.param ?? "");
  const code = String(err.code ?? "");
  const msg = `${err.message ?? ""} ${err.raw?.message ?? ""}`.toLowerCase();
  return (
    param.startsWith("payment_method_types") ||
    code === "payment_method_type_invalid" ||
    msg.includes("us_bank_account")
  );
}

/**
 * Opens a Stripe Checkout session to pay an invoice by its public token.
 * Used by the Pay buttons on the public invoice page and "Collect payment" in-app
 * (works on any phone/tablet browser).
 *   GET /api/pay/<invoice_public_token>           → card (Apple Pay / Google Pay ride on it)
 *   GET /api/pay/<invoice_public_token>?method=bank → US bank transfer (ACH debit)
 *
 * TWO DOORS, AND THE DEFAULT IS THE OLD ONE. Every invoice email ever sent carries the bare URL,
 * and those links sit in inboxes for years — so no method, or any method we don't recognise, is a
 * card, exactly as it was before the bank door existed.
 *
 * WHY THE BANK DOOR IS WORTH A SECOND BUTTON. On 2026-09-20 two card payments, $6,068.03 and
 * $1,875.98, cost about $231 to accept. The same two by ACH would have cost about $10. The
 * customer pays the same money either way; the difference stays with the contractor.
 *
 * ── BEFORE THE BANK DOOR IS PUT IN FRONT OF A CUSTOMER: ONE STRIPE DASHBOARD STEP ────────────
 *
 * A card settles inside the Checkout flow and arrives as checkout.session.completed(paid). ACH
 * does NOT: it arrives as completed(UNPAID) — which the webhook correctly books as nothing — and
 * then, days later, as checkout.session.async_payment_succeeded. The handler for that event
 * already exists (api/stripe/webhook/route.ts), but the event is NOT on the "connected accounts"
 * webhook destination by default, exactly like payment_intent.succeeded wasn't until Tap to Pay
 * needed it on 2026-09-11. If it is missing, the transfer lands in the contractor's bank and the
 * invoice never closes: AR ages a bill that is paid and the dunning cron chases a customer who
 * paid. Add BOTH checkout.session.async_payment_succeeded and checkout.session.async_payment_failed
 * to that destination in Stripe → Developers → Webhooks → connected accounts.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  // Read before the limiter so every branch below (including the refusals) knows which door was
  // tapped and can say the right sentence about it.
  const method = parsePayMethod(new URL(req.url).searchParams.get("method"));

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
  const settings = getOrgSettings((org as { settings?: unknown } | null)?.settings);
  const site = orgPublicBaseUrl(settings);

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

  // THE CARD DOOR'S PRICE, DECIDED ONCE, BY THE SAME FUNCTION THE INVOICE PAGE PRINTS FROM.
  // Bank never carries a fee — that is the whole point of the second door — so it is not even
  // asked. Today the decision always comes back fee 0 (CARD_FEE_READY is false); when a fee IS
  // configured it comes back REFUSED, and a refusal is said out loud into the ops log rather than
  // swallowed, because an owner who set a number and got nothing deserves to find out why.
  const fee = method === "card" ? cardFeeDecision(balance, settings.card_fee_percent) : cardFeeDecision(balance, 0);
  if (fee.refused) {
    reportError("pay.card-fee-held-shut", new Error(fee.refused), { org_id: inv.org_id, invoice_id: inv.id });
  }

  const stripe = getStripe();
  try {
    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        // PINNED TO ONE METHOD PER DOOR, NOT LEFT TO THE ACCOUNT'S AUTOMATIC LIST. Two reasons.
        // The customer was shown a price for the door they tapped, so the checkout must not offer
        // a third thing at a different price — a fee quoted for a card and then paid by ACH would
        // be a surcharge on a bank transfer, which is both wrong and the exact confusion this
        // build exists to remove. And a bank door that silently falls back to a card is how the
        // $231 day happens again. Apple Pay and Google Pay ride inside "card" and are unaffected.
        payment_method_types: [method === "bank" ? "us_bank_account" : "card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: { name: `${org?.name ?? ""} Invoice ${inv.invoice_number}`.trim() },
              unit_amount: Math.round(balance * 100),
            },
            quantity: 1,
          },
          // THE FEE IS ITS OWN LINE, NEVER FOLDED INTO THE INVOICE LINE. It is the processor's
          // money passing through, not work that was done — folding it in would print a total on
          // a Stripe receipt that does not match the invoice the customer is holding.
          ...(fee.fee > 0
            ? [
                {
                  price_data: {
                    currency: "usd",
                    product_data: { name: `Card processing fee (${feePctLabel(fee.pct)}%)` },
                    unit_amount: Math.round(fee.fee * 100),
                  },
                  quantity: 1,
                },
              ]
            : []),
        ],
        customer_email: (inv as any).customers?.email ?? undefined,
        // A CARD IS DONE WHEN THE PAGE IS DONE. A BANK TRANSFER IS NOT. ACH sits pending for days
        // and can still fail, so the bank door lands on a different banner that says so — see
        // /i/[token]. Sending it to ?paid=1 would hand the customer "Payment received" for money
        // the contractor will not see until next week, which is a receipt for a thing that has
        // not happened.
        success_url: `${site}/i/${token}?paid=${method === "bank" ? "bank" : "1"}`,
        cancel_url: `${site}/i/${token}`,
        // org_id rides along because on a direct charge the webhook arrives with the
        // CONNECTED account's context, not ours — this is how we know whose invoice it is.
        //
        // invoice_amount IS THE NUMBER THE INVOICE GETS CREDITED, AND IT IS NOT amount_total.
        // The webhook books (session.amount_total / 100) today, which is fine while every session
        // is exactly the balance and WRONG the moment a fee line rides along: the invoice would be
        // credited the contractor's processing fee too and come back overpaid. Stamped on both the
        // session and the PaymentIntent (the tap door reads the PI, the link door reads the
        // session) so whichever branch books the money has the right figure sitting right there.
        metadata: {
          kind: "invoice_payment",
          invoice_id: inv.id,
          org_id: inv.org_id,
          pay_method: method,
          invoice_amount: fee.invoiceAmount.toFixed(2),
          card_fee: fee.fee.toFixed(2),
        },
        payment_intent_data: {
          metadata: {
            invoice_id: inv.id,
            org_id: inv.org_id,
            pay_method: method,
            invoice_amount: fee.invoiceAmount.toFixed(2),
            card_fee: fee.fee.toFixed(2),
          },
        },
      },
      // THE line that makes it a direct charge.
      { stripeAccount: connect.accountId! },
    );
    if (!session.url) {
      reportError("pay.checkout", "Stripe returned a session with no url", { org_id: inv.org_id, invoice_id: inv.id, method });
      return NextResponse.redirect(`${site}/i/${token}?pay=failed`, { status: 303 });
    }
    return NextResponse.redirect(session.url, { status: 303 });
  } catch (e) {
    // ANY Stripe-side refusal (a capability that lapsed since account.updated last spoke, a key
    // in the wrong mode, an amount it won't take) used to escape as a raw 500 on the contractor's
    // own domain. The customer goes back to their invoice with a reason; the operator gets the
    // real error in error_events (audit v921).
    //
    // AND THE BANK DOOR HAS ITS OWN REASON. ACH is a capability the contractor turns on in their
    // own Stripe dashboard; we cannot see it from here, so we offer the door and read the no off
    // the error. That customer must never land on a Stripe error page: they go back to their own
    // invoice, where the card button is still sitting there and one sentence says what happened.
    reportError("pay.checkout", e, { org_id: inv.org_id, invoice_id: inv.id, method });
    const reason = method === "bank" && bankMethodRefused(e) ? "bank_unavailable" : "failed";
    return NextResponse.redirect(`${site}/i/${token}?pay=${reason}`, { status: 303 });
  }
}
