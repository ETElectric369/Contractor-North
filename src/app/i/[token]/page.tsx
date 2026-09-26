import { notFound } from "next/navigation";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { fetchSupplierNames } from "@/lib/supplier-names";
import { PrintButton } from "@/components/print-button";
import { sharePdfReady } from "@/lib/pdf-cache";
import { companyFromOrg } from "@/components/doc-letterhead";
import { billingEnabled } from "@/lib/stripe";
import { formatCurrency } from "@/lib/utils";
import { docPageTitle, projectionPlace } from "@/lib/doc-place";
import { NO_INDEX } from "@/lib/no-index";
import { customerLines, invoiceBalance } from "@/lib/invoice-math";
import { cardFeeDecision, feePctLabel, payUrl } from "@/lib/org-settings";
import { pendingTransfers, transferOnItsWaySentence, type PendingTransfer } from "@/lib/bank-transfer";
import { PublicInvoiceDocument, type PublicInvoiceData } from "@/components/public-invoice-document";
import type { Metadata } from "next";
import type { Organization } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const supabase = await createClient();
  const { data } = await supabase.rpc("public_invoice", { p_token: token });
  const inv = (data as any)?.invoice;
  // NEVER indexed. The token is a permanent bearer credential and the page carries the
  // customer's name + address + balance — one forwarded link must not become a search result.
  // "INV-080_235 Timbercreek": what Save As PDF names the file (lib/doc-place).
  return { title: inv ? docPageTitle(inv.invoice_number, projectionPlace(data as any)) : "Invoice", robots: NO_INDEX };
}

/** What the page needs to know about the org that owns this link, read as the service role and
 *  pinned to that one org and this one invoice. The link is the credential (the same one
 *  public_invoice took). The supplier names are never shown (they are scrubbed out of the lines);
 *  the bank transfers on their way are (audit v994 BK3, 0338). */
async function linkFacts(token: string): Promise<{ supplierNames: ReadonlySet<string>; pending: PendingTransfer[] }> {
  const none = { supplierNames: new Set<string>(), pending: [] as PendingTransfer[] };
  try {
    const svc = createServiceClient();
    const { data } = await svc.from("invoices").select("id, org_id").eq("public_token", token).maybeSingle();
    const orgId = (data as { org_id?: string | null } | null)?.org_id;
    const invoiceId = (data as { id?: string | null } | null)?.id;
    if (!orgId) return none;
    const [supplierNames, inFlight] = await Promise.all([
      fetchSupplierNames(svc, orgId).catch(() => new Set<string>()),
      invoiceId ? pendingTransfers(svc, orgId, [invoiceId]).catch(() => null) : Promise.resolve(null),
    ]);
    // A read that failed shows no banner; /api/pay refuses a second checkout on its own read anyway.
    return { supplierNames, pending: (invoiceId && inFlight?.byInvoice.get(String(invoiceId))) || [] };
  } catch {
    return none;
  }
}

export default async function PublicInvoicePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ paid?: string; pay?: string }>;
}) {
  const { token } = await params;
  const { paid, pay } = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase.rpc("public_invoice", { p_token: token });
  if (!data) notFound();

  const inv = data.invoice;
  const [pdfReady, { supplierNames, pending }] = await Promise.all([
    sharePdfReady("invoice", token, String(inv.status ?? "")),
    linkFacts(token),
  ]);
  // NO LINE NAMES A SUPPLIER (audit v994 PL1, scrub on read). public_invoice does this itself once
  // 0315 is applied; until then, and as the last door either way, the page does it with the same
  // rule (customerLines), including on bills that went out before the rule existed.
  data.items = customerLines(Array.isArray(data.items) ? data.items : [], supplierNames);
  const org = data.org as Organization | null;
  const co = companyFromOrg(org);
  const balance = invoiceBalance(inv.total, inv.amount_paid);
  // "Pay now" only when the ORG can actually take a card, not merely when the platform has a
  // Stripe key (audit v921 — 0247 ships can_take_card on the org projection). Before this, an org
  // that had never finished Connect onboarding still showed the button and the click died on a
  // plain-text 503.
  const orgTakesCard = (data.org as { can_take_card?: boolean } | null)?.can_take_card !== false;
  const payable = billingEnabled && orgTakesCard && inv.status !== "void" && inv.status !== "draft";
  // WHAT THE CARD DOOR COSTS, FROM THE SAME FUNCTION /api/pay CHARGES FROM — so the number on the
  // button and the number on the Stripe page cannot drift apart.
  //
  // THE PROJECTION LAW, STATED OUT LOUD: public_invoice()'s org projection carries
  // card_fee_percent since 0283, so this page reads the same percent /api/pay charges from. The
  // fee itself is still held shut in both places (CARD_FEE_READY), so both ends agree on zero
  // today; if the projection ever drops the field again, this reads undefined → 0 and the page
  // would print the bare balance on a button that charges more, which is the one thing a
  // surcharge must never do.
  const fee = cardFeeDecision(balance, Number((data.org as { card_fee_percent?: number | string | null } | null)?.card_fee_percent ?? 0));
  /**
   * THE BANK DOOR OPENS ONLY WHERE ITS SETTLEMENT EVENT EXISTS (three reviewers, 2026-09-20).
   *
   * A card settles inside Checkout and arrives as completed(paid), which the webhook books. ACH
   * arrives as completed(UNPAID) - rightly booked as nothing, the money is days away and can still
   * be refused - and only clears later, on `checkout.session.async_payment_succeeded`. That event
   * is not on a connected-accounts destination by default, and nothing here can read whether it
   * is. A bank button without it takes a customer's money and never closes the invoice: they pay,
   * the office sees nothing, and the next reminder chases a man who has already paid.
   *
   * So the door is shut until a person has done the Stripe step and said so. Same shape as the Tap
   * to Pay entitlement, for the same reason: the capability lives where this app cannot look.
   */
  const bankOpen = (data.org as { bank_transfer_enabled?: boolean } | null)?.bank_transfer_enabled === true;
  // audit v921: /api/pay used to answer its refusals with a bare text/plain 503 — a customer who
  // tapped "Pay now" landed on an unstyled page with no way back. It now sends them here with a
  // reason, and this line says it out loud. The sub-$0.50 case is stated even before a click,
  // because Stripe won't charge that amount and a button that can only fail is a dead end.
  //
  // bank_unavailable is its own sentence, and it is NOT "something went wrong": ACH is a
  // capability the contractor switches on in their own Stripe account, and we cannot read that
  // from here, so the door is offered and the no is turned into words. It names the card button
  // because the card button is still on the screen in that state, and it sits BELOW this banner
  // (the bank button is the only one that hides) — copy never names a control that isn't there,
  // and never points the wrong way at one that is.
  // A BANK TRANSFER ALREADY ON ITS WAY (audit v994 BK3). The balance still reads in full until it
  // clears, so the page says so and offers no second online payment (/api/pay refuses one too).
  const inFlight = !paid && pending.length > 0 && balance > 0;
  // (/api/pay's ?pay=pending needs no sentence of its own: while the transfer is pending the banner
  // below says it, and once it has cleared or failed the page is simply payable, or paid, again.)
  const payNotice =
    inFlight
      ? null
      : pay === "unavailable"
      ? "Card payments aren't switched on for this contractor yet. Please pay by check, or call them."
      : pay === "bank_unavailable"
        ? "Bank transfer isn't switched on for this contractor's account yet. You can still pay by card below, or pay by check."
        : pay === "failed"
          ? "The payment couldn't be started. Please try again in a moment, or pay by check."
          : payable && balance > 0 && balance < 0.5
            ? "This balance is under the $0.50 card minimum. Please pay by check, or call us."
            : null;

  return (
    <div className="min-h-screen bg-slate-100 py-8 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-3xl items-center justify-end gap-2 px-4">
        {/* THE REAL FILE, when a rendered copy exists (0198) — the same deterministic PDF the
            office sees, not the browser print dialog's approximation on a phone. */}
        {pdfReady && (
          <a
            href={`/api/share-pdf/${token}`}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Download PDF
          </a>
        )}
        <PrintButton label="Print / Save PDF" />
      </div>

      {paid && (
        <div className="no-print mx-auto mb-4 max-w-3xl px-4">
          {/* A BANK TRANSFER IS NOT A RECEIPT YET. Stripe hands the customer back the second they
              finish the ACH mandate, but the money is days away and can still be refused, so this
              page must not say "received" for it. It also has to head off the double payment the
              delay invites: nothing is recorded until the transfer clears, which means the balance
              and both Pay buttons are still sitting here if they come back tomorrow. Better they
              hear that from us now than pay twice and need a refund.
              AND IT PROMISES NOTHING THIS APP DOES NOT DO. There is no customer receipt email in
              this codebase — the webhook pushes the OFFICE, not the customer — so the draft that
              said "you will get a receipt by email" was copy naming a thing that does not exist. */}
          {paid === "bank" ? (
            <div className="rounded-xl bg-sky-50 px-4 py-3 text-center text-sm text-sky-900">
              <p className="font-medium">Your bank transfer is on its way. Thank you!</p>
              <p className="mt-1">
                Banks take a few business days to move it, and your contractor sees it the moment it lands. If you
                open this invoice again before it clears it will still show the balance, so please do not pay a
                second time.
              </p>
            </div>
          ) : (
            <div className="rounded-xl bg-green-50 px-4 py-3 text-center text-sm font-medium text-green-700">
              Payment received. Thank you!
            </div>
          )}
        </div>
      )}
      {inFlight && (
        <div className="no-print mx-auto mb-4 max-w-3xl px-4">
          <div className="rounded-xl bg-sky-50 px-4 py-3 text-center text-sm text-sky-900">
            <p className="font-medium">{transferOnItsWaySentence(pending)} Thank you!</p>
            <p className="mt-1">
              Banks take a few business days to move it. The balance below still shows until it clears, so please do not
              pay again. If the transfer does not go through, you can pay here once more.
            </p>
          </div>
        </div>
      )}
      {!paid && payNotice && (
        <div className="no-print mx-auto mb-4 max-w-3xl px-4">
          <div className="rounded-xl bg-amber-50 px-4 py-3 text-center text-sm font-medium text-amber-800">
            {payNotice}
          </div>
        </div>
      )}
      {/* TWO DOORS, BOTH PRICED, BEFORE ANYBODY TAPS. Andrew's note asked for the card cost to be
          "transparency, clearly visible" — which means visible BEFORE the commitment, not on the
          receipt afterwards, and it means the customer gets a free way to pay rather than just a
          bill for the fee. Each button states its own total and says what it costs and how long
          it takes, so the choice is made with both numbers on the screen.
          Stacked at 375px, side by side from sm up; both are full-width taps well over 44px. */}
      {!paid && !inFlight && balance >= 0.5 && payable && pay !== "unavailable" && (
        <div className="no-print mx-auto mb-4 max-w-3xl px-4">
          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:justify-center">
            <div className="sm:w-64">
              <a
                href={payUrl(token, "card")}
                className="flex min-h-[44px] w-full items-center justify-center rounded-xl px-6 py-3 text-center text-base font-semibold text-white shadow-sm"
                style={{ backgroundColor: co.brand }}
              >
                Pay {formatCurrency(fee.cardTotal)} By Card
              </a>
              <p className="mt-1.5 text-center text-xs text-slate-500">
                {fee.fee > 0
                  ? `Includes a ${feePctLabel(fee.pct)}% card processing fee of ${formatCurrency(fee.fee)}. Card, Apple Pay, or Google Pay.`
                  : "Card, Apple Pay, or Google Pay. Posts right away."}
              </p>
            </div>
            {/* Hidden only after the bank door has actually refused, so the customer is never sent
                back to a button that just failed. Offered otherwise, because whether ACH is switched
                on lives in the contractor's Stripe account and this page cannot read it. */}
            {bankOpen && pay !== "bank_unavailable" && (
              <div className="sm:w-64">
                <a
                  href={payUrl(token, "bank")}
                  className="flex min-h-[44px] w-full items-center justify-center rounded-xl border-2 bg-white px-6 py-3 text-center text-base font-semibold shadow-sm"
                  style={{ borderColor: co.brand, color: co.brand }}
                >
                  Pay {formatCurrency(balance)} By Bank Transfer
                </a>
                <p className="mt-1.5 text-center text-xs text-slate-500">
                  {fee.fee > 0 ? "No processing fee. " : ""}Straight from your bank account. Takes a few business
                  days to clear.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* The same mapping the portal job page uses for this bill (one door, one rendering). */}
      <PublicInvoiceDocument data={data as PublicInvoiceData} />
    </div>
  );
}
