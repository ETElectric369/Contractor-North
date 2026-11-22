import { pickSite } from "@/lib/site-address";
import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/print-button";
import { sharePdfReady } from "@/lib/pdf-cache";
import { companyFromOrg } from "@/components/doc-letterhead";
import { templateFor } from "@/components/doc-templates";
import { PublicQuoteAccept, type PublicDeposit } from "./accept";
import { QuoteDocument } from "@/components/quote-document";
import { isEstimateFormat, type EstimateFormat } from "@/lib/doc-style";
import { docLabel } from "@/lib/doc-label";
import { docPageTitle, projectionPlace } from "@/lib/doc-place";
import { NO_INDEX } from "@/lib/no-index";
import { cardFeeDecision, feePctLabel } from "@/lib/org-settings";
import type { Metadata } from "next";
import type { Organization } from "@/lib/types";

export const dynamic = "force-dynamic";
// THE CUSTOMER'S ACCEPT RUNS UNDER THIS ROUTE'S LIMIT: a server action (acceptPublicQuote) takes its
// route's maxDuration, and since cn-v1133 that one tap does the office door's whole work before it
// answers — the tasks, the work order, the take-off, the sync, the visit, the bell — seconds, not the
// default's ten (skeptic #39, S3).
export const maxDuration = 60;

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }): Promise<Metadata> {
  const { token } = await params;
  const supabase = await createClient();
  const { data } = await supabase.rpc("public_quote", { p_token: token });
  const q = (data as any)?.quote;
  // NEVER indexed — permanent bearer token + customer PII + pricing. See @/lib/no-index.
  // "E-017_13897 Honeysuckle": what Save As PDF names the file (lib/doc-place).
  return { title: q ? docPageTitle(q.quote_number, projectionPlace(data as any)) : "Quote", robots: NO_INDEX };
}

/**
 * THE DEPOSIT, READ OFF public_quote (cn-v1177, 0414; cn-v1178, 0416): deposit_amount (the sale's live
 * request's ask, else the figure the estimate stored), deposit_state ('none' | 'due' | 'requested' |
 * 'paid'), can_take_card, and since 0416 deposit_due (what is still owed on a live unpaid request, else
 * null) and card_fee_percent (the company's). A key that is missing, a state that is not one of the four,
 * or a figure that is not above 0 reads as NO deposit: an estimate saved before 0414 states nothing and
 * is offered nothing. A projection from before 0416 has neither new key: the button then names the ask
 * and no fee, as it always did. Not exported: a page exports its page.
 *
 * WHAT THE BUTTON NAMES IS WHAT THE CARD DOOR CHARGES (audit B3, D5): the door charges the request's
 * balance plus the company's card fee (/api/pay/<token>, cardFeeDecision), so the button names
 * deposit_due when there is one, else the ask, through THE SAME cardFeeDecision the invoice's own pay
 * page and the card door read, and says the fee the way that page does. A partly paid request says
 * what was received and what is left.
 */
function depositFromProjection(q: Record<string, unknown> | null | undefined): PublicDeposit {
  const amount = Number(q?.deposit_amount);
  const state = q?.deposit_state;
  if (!Number.isFinite(amount) || amount <= 0.005 || (state !== "due" && state !== "requested" && state !== "paid")) {
    return { amount: 0, state: "none", canTakeCard: false };
  }
  const ask = Math.round(amount * 100) / 100;
  const dueRaw = q?.deposit_due == null ? Number.NaN : Number(q.deposit_due);
  // What is still owed: deposit_due when the projection says it (never above the ask, never below 0).
  const owed = state === "paid" ? 0 : Number.isFinite(dueRaw) ? Math.min(ask, Math.max(0, Math.round(dueRaw * 100) / 100)) : ask;
  const received = state === "paid" ? ask : Math.round((ask - owed) * 100) / 100;
  const fee = cardFeeDecision(owed, Number(q?.card_fee_percent ?? 0));
  return {
    amount: ask,
    state,
    canTakeCard: q?.can_take_card === true,
    owed,
    received: received > 0.005 ? received : 0,
    charge: fee.cardTotal,
    fee: fee.fee > 0 ? { pct: feePctLabel(fee.pct), amount: fee.fee } : null,
  };
}

export default async function PublicQuotePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams?: Promise<{ deposit?: string | string[] }>;
}) {
  const { token } = await params;
  const sp = searchParams ? await searchParams : {};
  const supabase = await createClient();
  const { data } = await supabase.rpc("public_quote", { p_token: token });
  // NOT SERVED (cn-v1178, decision 3): public_quote answers nothing for a token it does not know AND for
  // an estimate the company took back to draft to change it (a sent estimate is the customer's copy;
  // Back to Draft is how it changes). The customer who opens the link they were sent in that window is
  // told the one thing true of both: it is not available now, and the company sends it again.
  if (!data) {
    return (
      <div className="min-h-screen bg-slate-100 px-4 py-16">
        <div className="mx-auto max-w-md rounded-xl bg-white px-6 py-8 text-center shadow-sm">
          <p className="text-base font-medium text-slate-800">This page isn&apos;t available right now.</p>
          <p className="mt-2 text-sm text-slate-600">If the company is updating it, they&apos;ll send it to you again when it&apos;s ready.</p>
        </div>
      </div>
    );
  }

  const q = data.quote;
  const pdfReady = await sharePdfReady("quote", token, String(q.status ?? ""));
  const items = data.items ?? [];
  const c = data.customer;
  const org = data.org as Organization | null;
  const co = companyFromOrg(org);
  const template = templateFor(org, "quote");
  const label = docLabel(q);
  const deposit = depositFromProjection(q as Record<string, unknown>);
  // THE CARD DOOR CAME BACK REFUSED (/api/pay/deposit/<token> → ?deposit=unavailable): one plain line,
  // with the company's phone when the letterhead projection carries one. The button stays, to try again.
  const depositTrouble =
    sp.deposit === "unavailable" && deposit.state !== "none"
      ? co.phone
        ? `We couldn't open the deposit payment just now. Try again, or call us at ${co.phone}.`
        : "We couldn't open the deposit payment just now. Try again in a few minutes."
      : null;
  // THE FORMAT, AS public_quote RESOLVED IT (0387, 0395; said outright since 0408). The RPC resolves
  // the estimate's own choice else the company's — the same coalesce estimateFormatFor makes for the
  // office's paper — and since 0408 ships that one word as quote.estimate_format, because a breakdown
  // now reads two ways ("detailed": each part; "grouped": ONE Materials figure) and its presence
  // alone no longer says which. It is the server's word about what it shipped, so it is taken as
  // said, and only when it is one of the three (isEstimateFormat).
  // UNTIL 0408 IS APPLIED the key is absent, and the old inference stands exactly as it was: the RPC
  // ships a line's breakdown ONLY when the estimate reads "detailed", so any item carrying a detail
  // means detailed and none means "tasks" — with no detail there is nothing to print either way.
  const said = (q as { estimate_format?: unknown }).estimate_format;
  const estimateFormat: EstimateFormat = isEstimateFormat(said)
    ? said
    : (items as { detail?: unknown }[]).some((it) => it?.detail != null)
      ? "detailed"
      : "tasks";

  return (
    <div className="min-h-screen bg-slate-100 py-8 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-3xl items-center justify-end gap-2 px-4">
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

      {/* THE SAME pickSite AS THE OFFICE PAGE. The RPC hands over RAW candidates and applies no
          precedence in SQL, so there is exactly one implementation of "which address wins" and
          these two surfaces — which render the identical QuoteDocument — cannot drift. */}
      <QuoteDocument
        docStyle={(data.org as { doc_style?: unknown } | null)?.doc_style}
        estimateFormat={estimateFormat}
        co={co}
        site={pickSite([
          ...(data.site_candidates ?? []),
          { source: "customer", parts: data.customer },
        ])}
        template={template}
        docLabel={label}
        number={q.quote_number}
        createdAt={q.created_at}
        validUntil={q.valid_until}
        title={q.title}
        description={q.description}
        circuits={q.circuits}
        customer={c}
        items={items}
        subtotal={q.subtotal}
        taxRate={q.tax_rate}
        tax={q.tax}
        total={q.total}
        notes={q.notes}
        // The deposit line under the totals (cn-v1177): the sale's request's ask, else the figure the
        // estimate stored; "Deposit received" once the request is paid (cn-v1178, audit B6).
        depositDue={deposit.state === "none" ? null : deposit.amount}
        depositReceived={deposit.state === "paid"}
        // The public RPC deliberately omits org.settings (no leak), so quote_terms /
        // document_footer aren't available on this surface — the document falls back
        // to its default footer, the same as before.
        showContact
        acceptSlot={
          // audit v921: public_quote serves 'expired' too, and an expired quote used to render the
          // full Accept button — both RPCs refuse anything but 'sent', so the only outcome of that
          // tap was a red "no longer available". Say it before the click, not after.
          q.status === "expired" ? (
            <div className="no-print flex items-center justify-center gap-2 rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
              This {label.toLowerCase()} has expired. Call us and we&apos;ll send you a fresh one.
            </div>
          ) : (
            <PublicQuoteAccept
              token={token}
              accepted={q.status === "accepted"}
              declined={q.status === "declined"}
              brand={co.brand}
              docLabel={label}
              deposit={deposit}
              depositTrouble={depositTrouble}
            />
          )
        }
      />
    </div>
  );
}
