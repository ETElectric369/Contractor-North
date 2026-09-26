"use server";
import { dbError } from "@/lib/db-error";
import { importExtras, extrasSentence } from "@/lib/import-extras";
import QRCode from "qrcode";
import { canAcceptPayments, connectStateFromOrg } from "@/lib/stripe-connect";
import { customerForInquiry } from "@/lib/actions/win-customer";
import { changeOrderLines, noChangeOrdersReason, type ChangeOrderRow } from "@/lib/change-order-billing";

import { revalidatePath } from "next/cache";
import { after } from "next/server";
import { headers } from "next/headers";
import { bustDocPdf, warmDocPdf } from "@/lib/pdf-cache";
import { revalidateMoney } from "@/lib/revalidate-money";
import { createClient } from "@/lib/supabase/server";
import { deliverInvoiceEmail } from "@/lib/invoice-email";
import { markInvoiceResent, markInvoiceSent } from "@/lib/invoice-sent-stamp";
import { needsSendRefusal, sendDraftForPayment } from "@/lib/pay-door-send";
import { jobBillForPayment, type JobBillRow } from "@/lib/job-bill-for-payment";
import { hasUnsentRevision, invoiceLineEditRefusal, stampInvoiceRevised } from "@/lib/invoice-revision";
import { billItemisation, editedRemainderDrift, editedRemainderSentence } from "@/lib/bill-itemisation";
import { isReturnBill, returnCreditRows, returnLinesAgainstPurchases, returnsSummaryParts, returnsThatFit, type ReturnOutcome } from "@/lib/supplier-returns";
import { sendSms, smsReadiness } from "@/lib/sms";
import { TEXT_NOT_READY_REFUSAL, TEXT_REFUSED } from "@/lib/sms-readiness";
import { pushInvoiceToQbo } from "@/lib/quickbooks";
import { getOrgSettings, orgDocUrl, orgPublicBaseUrl } from "@/lib/org-settings";
import { rowPlace } from "@/lib/doc-place";
import { tzLocalHourUtc } from "@/lib/tz";
import { requireStaff } from "@/lib/staff-guard";
import { computeJobLaborBilling, customerLaborRateForJob, customerMaterialMarkupForJob, fetchJobLaborRows, noBillRateWarnings, withoutClaimedLabor } from "@/lib/labor-billing";
import { claimedIdsOfLines, claimedSourcesOnJob, claimantNumbers, fixedBillingsNotYetNetted, joinNumbers, laborRowIds, unbilledWorkForJob, type ClaimedSources } from "@/lib/unbilled-work";
import { livePurchaseOrders } from "@/lib/job-progress-math";
import { resolveDrawCredit, shouldBlockStandardImport, invoiceBalance, isDrawKind, DRAW_KINDS, kindFromPriceBook, pickableLineKind, LINE_KIND_LABEL, type PickableLineKind } from "@/lib/invoice-math";
import { readPriceBookUnits } from "@/lib/price-book-kind";
import { contractDrawRefusal, isActualsDraw, openDraftOnJob, pulledIntoSentence, readDraftShape, type OpenDraft } from "@/lib/actuals-draw";
import { hoursWords, joinedSentence, leftOffSentence, planLaborOffer, type LaborJoin, type OwnLaborLine } from "@/lib/labor-offer";
import { removedLines, removedSentence, staleTombstones, textArrayLiteral } from "@/lib/import-reconcile";
import { linesByBillId, readBillLines, readInvoiceMarkup } from "@/lib/invoice-markup-read";
import { recalcInvoice } from "@/lib/invoice-recalc";
import { defaultDueDateIsoForOrg } from "@/lib/invoice-due";
import { standardBillingBlockerOnJob, standardBillingConflictError } from "@/lib/billing-guards";
import { scheduleStatus, contractTotalFromQuotes, type Milestone } from "@/lib/payment-schedule-math";
import { sendPushToProfiles, orgStaffIds } from "@/lib/push";
import { formatCurrency } from "@/lib/utils";
import { paymentMethodKey } from "@/lib/payment-method";
import { reportError } from "@/lib/observe";
import {
  readJobStock,
  stockImportRows,
  stockShortsSentence,
  stockZeroCostSentence,
  takesWords,
  unclaimedTakes,
  type StockShort,
  type StockTake,
} from "@/lib/stock-billing";

/** Post a credit/refund to the customer's account from an invoice. disposition
 *  "credit" keeps it on their account; "refund" flags accounting to pay it back. */
export async function createCustomerCredit(
  invoiceId: string,
  amount: number,
  disposition: "credit" | "refund",
  note?: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!(amount > 0)) return { ok: false, error: "Enter an amount." };

  // M2: bail if the invoice isn't visible to this org (cross-org id → null under
  // RLS) instead of inserting an orphan credit with customer_id:null.
  const { data: inv } = await supabase
    .from("invoices")
    .select("customer_id")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv) return { ok: false, error: "Invoice not found." };

  const { error } = await supabase.from("customer_credits").insert({
    customer_id: inv.customer_id ?? null,
    invoice_id: invoiceId,
    amount,
    disposition,
    note: note?.trim() || null,
    created_by: ctx.userId,
  });
  if (error) return { ok: false, error: dbError(error) };
  // C6: a credit on account reduces what the customer owes — fold it into amount_paid via
  // recalc so the balance + collected reflect it (recalcInvoice now sums open credits as
  // payments). A refund is a cash-OUT, tracked in `collected` already, so it doesn't recalc.
  if (disposition === "credit") await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  revalidateMoney();
  if (inv?.customer_id) revalidatePath(`/crm/${inv.customer_id}`);
  return { ok: true };
}

/**
 * THE CREDIT HAD NO WAY OUT (audit v921).
 *
 * A credit was pinned to the invoice it was posted FROM, and recalcInvoice only ever reads
 * credits on that same invoice (capped at its shortfall) — so the one case the Stripe webhook
 * steers the office to, "this invoice is overpaid, credit it or refund it", produced a row that
 * reduced nothing, could not reach the customer's next invoice, and had no button anywhere that
 * could close it. The CRM tile said "Account credit $X" forever. These three actions are the
 * way forward: see what's on the account, move an open credit onto the invoice you're looking
 * at, or close out a refund once accounting has actually paid it.
 */
export async function listCustomerCreditsForInvoice(
  invoiceId: string,
): Promise<{
  ok: boolean;
  error?: string;
  balance?: number;
  credits?: { id: string; amount: number; disposition: string; note: string | null; created_at: string; onThisInvoice: boolean }[];
}> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: inv } = await supabase
    .from("invoices")
    .select("customer_id, total, amount_paid")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv) return { ok: false, error: "Invoice not found." };
  if (!inv.customer_id) return { ok: true, balance: invoiceBalance(inv.total, inv.amount_paid), credits: [] };
  const { data: rows, error } = await supabase
    .from("customer_credits")
    .select("id, amount, disposition, note, created_at, invoice_id")
    .eq("customer_id", inv.customer_id)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return { ok: false, error: dbError(error) };
  return {
    ok: true,
    balance: invoiceBalance(inv.total, inv.amount_paid),
    credits: (rows ?? []).map((c: any) => ({
      id: c.id,
      amount: Number(c.amount) || 0,
      disposition: c.disposition,
      note: c.note ?? null,
      created_at: c.created_at,
      onThisInvoice: c.invoice_id === invoiceId,
    })),
  };
}

/** Move an open account credit onto THIS invoice so it actually reduces what the customer
 *  owes. The credit row is the ledger entry — it moves, it is never copied, or the same
 *  dollars would sit on the account twice (the CRM tile sums every open row). */
export async function applyCustomerCredit(
  creditId: string,
  invoiceId: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: inv } = await supabase
    .from("invoices")
    .select("customer_id, total, amount_paid, status")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv) return { ok: false, error: "Invoice not found." };
  if (inv.status === "void") return { ok: false, error: "This invoice is void — apply the credit to a live one." };

  const { data: credit } = await supabase
    .from("customer_credits")
    .select("id, amount, customer_id, invoice_id, disposition, status")
    .eq("id", creditId)
    .maybeSingle();
  if (!credit) return { ok: false, error: "Credit not found." };
  if (credit.status !== "open") return { ok: false, error: "That credit is already closed out." };
  if (credit.disposition !== "credit") return { ok: false, error: "That one is flagged for a refund — mark it refunded instead of applying it." };
  if (credit.invoice_id === invoiceId) return { ok: false, error: "That credit is already on this invoice." };
  // It is the CUSTOMER's money, not the invoice id's — never let one customer's credit land on
  // another's bill because an id came in from the page.
  if ((credit.customer_id ?? null) !== (inv.customer_id ?? null)) {
    return { ok: false, error: "That credit belongs to a different customer." };
  }

  // A credit may only ever reduce what is still OWED (invoice-math's cap), so applying one
  // bigger than the balance would quietly waste the difference on this invoice. Say so instead.
  const room = invoiceBalance(inv.total, inv.amount_paid);
  const amount = Number(credit.amount) || 0;
  if (!(room > 0.005)) return { ok: false, error: "This invoice has nothing left to cover." };
  if (amount > room + 0.005) {
    return {
      ok: false,
      error: `That credit is ${formatCurrency(amount)} and this invoice only has ${formatCurrency(room)} left to cover — apply it to a bigger invoice, or post it as a refund.`,
    };
  }

  const origin = (credit.invoice_id as string | null) ?? null;
  // MOVE THE CREDIT FROM WHERE WE READ IT, NOT FROM WHEREVER IT IS NOW. status stays 'open'
  // through a move, so the status filter alone could not see a lost race: two staff moving the
  // same credit to two different invoices both reported success, and the loser's invoice went on
  // showing a balance reduced by dollars that had gone somewhere else. Pinning the update to the
  // invoice_id this call read makes the loser write nothing and say so.
  const moveFrom = supabase
    .from("customer_credits")
    .update({ invoice_id: invoiceId })
    .eq("id", creditId)
    .eq("status", "open");
  const { data: moved, error } = await (origin ? moveFrom.eq("invoice_id", origin) : moveFrom.is("invoice_id", null)).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!moved?.length) return { ok: false, error: "That credit was just changed by someone else — reload and try again." };

  const landed = await recalcInvoice(supabase, invoiceId);
  // The invoice it came FROM loses it, so its balance has to be recomputed too.
  if (origin && origin !== invoiceId) await recalcInvoice(supabase, origin);

  /**
   * THE SECOND CREDIT FINDS NO ROOM.
   *
   * The room check above is a READ. Two credits applied to the same invoice in the same breath
   * both saw the same balance, both passed, and both landed — and recalcTotals caps the pair at
   * the shortfall (invoice-math, audit 8), so the later one sits on this invoice contributing
   * $0: still open, no longer counted on the account tile, and reachable only by someone who
   * thinks to look at this invoice for it. Read the invoice back and, if the open credits on it
   * now exceed what it can take, put this one back where it came from and say why.
   *
   * A failed read is not proof of anything, so it logs and leaves the move alone.
   */
  const [totalRes, paysRes, creditsRes] = await Promise.all([
    supabase.from("invoices").select("total").eq("id", invoiceId).maybeSingle(),
    supabase.from("payments").select("amount").eq("invoice_id", invoiceId),
    supabase.from("customer_credits").select("amount").eq("invoice_id", invoiceId).eq("disposition", "credit").eq("status", "open"),
  ]);
  const checkErr = totalRes.error || paysRes.error || creditsRes.error;
  if (checkErr || !totalRes.data) {
    reportError("applyCustomerCredit.verify", checkErr ?? new Error("invoice not found"), { creditId, invoiceId });
  } else {
    const sum = (rows: { amount: number | null }[] | null) => (rows ?? []).reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const over = sum(paysRes.data as any) + sum(creditsRes.data as any) - (Number((totalRes.data as any).total) || 0);
    if (over > 0.005) {
      const putBack = supabase
        .from("customer_credits")
        .update({ invoice_id: origin })
        .eq("id", creditId)
        .eq("status", "open")
        .eq("invoice_id", invoiceId);
      const { data: returned, error: backErr } = await putBack.select("id");
      await recalcInvoice(supabase, invoiceId);
      if (origin && origin !== invoiceId) await recalcInvoice(supabase, origin);
      revalidateMoney(invoiceId);
      if (origin) revalidateMoney(origin);
      revalidateMoney();
      if (inv.customer_id) revalidatePath(`/crm/${inv.customer_id}`);
      if (backErr || !returned?.length) {
        reportError("applyCustomerCredit.putBack", backErr ?? new Error("credit not returned"), { creditId, invoiceId, origin });
        return {
          ok: false,
          error: "Another credit reached this invoice first, so this one has nothing left to cover, and moving it back didn't go through. Open the customer's account and check where this credit sits.",
        };
      }
      return {
        ok: false,
        error: "Another credit reached this invoice first, so there is nothing left for this one to cover. It is still on the account, ready for a different invoice.",
      };
    }
  }

  revalidateMoney(invoiceId);
  if (origin) revalidateMoney(origin);
  revalidateMoney();
  if (inv.customer_id) revalidatePath(`/crm/${inv.customer_id}`);
  if (!landed) return { ok: false, error: "The credit moved but this invoice's balance didn't recompute — reload the invoice." };
  return { ok: true };
}

/** Close out a refund-flagged credit once accounting has actually paid it back. Only the
 *  refund disposition: a "keep on account" credit that is reducing an invoice would have its
 *  balance jump back up if this closed it, so that one is applied, not resolved. */
export async function markCreditRefunded(creditId: string): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: done, error } = await supabase
    .from("customer_credits")
    .update({ status: "resolved" })
    .eq("id", creditId)
    .eq("status", "open")
    .eq("disposition", "refund")
    .select("id, invoice_id, customer_id");
  if (error) return { ok: false, error: dbError(error) };
  if (!done?.length) return { ok: false, error: "That refund is already closed out (or it's an account credit — apply it to an invoice instead)." };
  const row = done[0] as { invoice_id: string | null; customer_id: string | null };
  if (row.invoice_id) revalidateMoney(row.invoice_id);
  revalidateMoney();
  if (row.customer_id) revalidatePath(`/crm/${row.customer_id}`);
  return { ok: true };
}

export async function sendInvoiceToQuickbooks(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff(); // was duplicated inline auth — use the one guard
  if ("error" in ctx) return { ok: false, error: ctx.error };
  // ctx.orgId was resolved and then DISCARDED here, which is what let a staff member of any tenant
  // push an invoice belonging to another one straight into that tenant's QuickBooks. It is
  // nullable on the guard's type, and a null org must REFUSE rather than fall through to an
  // unscoped read — that is the exact shape of the hole this closes.
  if (!ctx.orgId) return { ok: false, error: "No organization on your account." };
  const res = await pushInvoiceToQbo(id, ctx.orgId);
  if (res.ok) revalidateMoney(id);
  return { ok: res.ok, error: res.error };
}

/**
 * The customer-facing link for an invoice, on the CONTRACTOR'S OWN domain.
 *
 * This used to be built from NEXT_PUBLIC_SITE_URL — the platform's host — so a texted invoice
 * sent the customer to the software vendor's domain while the same invoice emailed from
 * lib/invoice-email.ts (which uses orgPublicBaseUrl) sent them to the contractor's. Two links to
 * the same document on two different domains, and the wrong one is the one that doesn't look
 * like the business the customer just hired.
 */
async function publicInvoiceLink(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string | null | undefined,
  token: string,
  place: string,
): Promise<string> {
  const { data: org } = orgId
    ? await supabase.from("organizations").select("settings").eq("id", orgId).maybeSingle()
    : { data: null };
  return orgDocUrl(getOrgSettings((org as { settings?: unknown } | null)?.settings), "i", token, place);
}

/**
 * SHARE SHEET payload for an invoice — the thing that was missing entirely.
 *
 * Erik went to send Jackie an invoice, found no Share button, and fell back to the iOS share
 * sheet from /print/pdf-preview. iOS shares the PAGE, so she received the root layout's metadata:
 * the title "Contractor North", the description "AI-powered field service platform for
 * contractors — CRM, quoting, scheduling…", and a link to app.contractornorth.com that is not in
 * PUBLIC_PATHS and therefore shows her a login screen. His software vendor's sales pitch and a
 * door she can't open. Nothing of hers leaked — but nothing useful arrived either.
 *
 * So the app has to own the payload rather than letting the OS guess it. Same wording as the SMS
 * (textInvoice, below) on purpose: one message, whichever way it goes out.
 */
export async function invoiceShareText(
  id: string,
  opts?: { sendIt?: boolean },
): Promise<{ ok: boolean; error?: string; needsSend?: boolean; title?: string; text?: string; url?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { data: invoice } = await ctx.supabase
    .from("invoices")
    .select("invoice_number, status, total, amount_paid, public_token, org_id, organizations(name), jobs(address), customers(address)")
    .eq("id", id)
    .maybeSingle();
  if (!invoice) return { ok: false, error: "Invoice not found." };
  const token = (invoice as { public_token?: string | null }).public_token;
  if (!token) return { ok: false, error: "This invoice has no customer link yet." };

  // A DRAFT'S LINK IS A 404, SO REFUSE RATHER THAN HAND IT OVER (cn-v700).
  //
  // Every invoice is born `draft`, and migration 0187 narrowed public_invoice to
  // ('sent','partial','paid','overdue') to stop unsent pricing being readable. Every OTHER way a
  // link leaves the building flips draft→sent on the way past — textInvoice below,
  // deliverInvoiceEmail. The share sheet has no send step to hang that on, so it was the one
  // egress that handed out a link to a page the customer cannot open.
  //
  // The refusal was the only egress with no way through — Erik, holding a customer with no email
  // and no number on file: "i hit the share button and it said it couldnt do it until i sent it
  // ... so that didnt work." STAMP FOLLOWS DEED: handing the customer their link IS sending, the
  // same deed textInvoice and emailInvoice stamp on the way out. But NOTHING SILENT still holds —
  // the flip happens only on the caller's explicit yes (needsSend → the button asks in plain
  // words), never as a side effect nobody chose.
  /**
   * A REVISED BILL SHARED AGAIN SETTLES ITS OWN RECORD (0269).
   *
   * Editing a delivered invoice leaves `revised_at > sent_at` standing — the page says the
   * customer is holding an older copy, and only a real re-delivery makes that false. The share
   * sheet is a delivery this app cannot watch (the OS takes over, and a cancelled sheet leaves no
   * trace), so it does the one thing it can: it ASKS, through the same needsSend door the draft
   * branch has used since cn-v700, and stamps only on the yes. A tap that was really "copy the
   * link for my own notes" then costs one "no" instead of quietly telling the office a corrected
   * bill went out that never did.
   */
  const isDraft = String((invoice as { status?: string | null }).status ?? "") === "draft";
  const resendNeeded = !isDraft && (await hasUnsentRevision(ctx.supabase, id));
  if (isDraft || resendNeeded) {
    if (!opts?.sendIt) {
      return {
        ok: false,
        needsSend: true,
        error: isDraft
          ? `Sharing marks ${invoice.invoice_number} as sent — the customer link only works on a sent invoice.`
          : `${invoice.invoice_number ?? "This invoice"} has changed since it went out, so the customer is holding an older copy. Sharing the link again records it as re-sent.`,
      };
    }
    // A re-send moves the DATE and nothing else — never the status, or sharing a paid invoice
    // would walk it back onto the AR list (see textInvoice).
    if (!isDraft) {
      const resent = await markInvoiceResent(ctx.supabase, id);
      if (!resent.ok) return { ok: false, error: resent.error ?? "Couldn't record this invoice as re-sent." };
      revalidateMoney(id);
    }
  }
  if (isDraft && opts?.sendIt) {
    // The stamp rides with the status because this IS the deed: the caller said yes to handing
    // the customer their link. 0267: `sent` alone can be manufactured by a pay door, `sent_at`
    // cannot. And the write is checked — a zero-row UPDATE is a 204, and handing out a link to a
    // page that still 404s because the flip never landed is the failure this branch exists to
    // prevent, not one to shrug at.
    const stamped = await markInvoiceSent(ctx.supabase, id);
    if (!stamped.ok) return { ok: false, error: stamped.error ?? "Couldn't mark this invoice as sent, so its customer link won't open yet." };
    // Same reason as setInvoiceStatus: a prepaid draft must land on paid/partial, not 'sent'.
    await recalcInvoice(ctx.supabase, id);
    revalidateMoney(id);
  }

  const who = (invoice as { organizations?: { name?: string } }).organizations?.name ?? "Your contractor";
  const balance = invoiceBalance(invoice.total, invoice.amount_paid);
  const url = await publicInvoiceLink(ctx.supabase, (invoice as { org_id?: string }).org_id, token, rowPlace(invoice));
  return {
    ok: true,
    title: `Invoice ${invoice.invoice_number} — ${who}`,
    text: `${who}: Invoice ${invoice.invoice_number}, balance ${formatCurrency(balance)}. View/pay:`,
    url,
  };
}

export async function textInvoice(
  id: string,
): Promise<{ ok: boolean; error?: string; notReady?: boolean }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: invoice } = await supabase
    .from("invoices")
    .select("invoice_number, total, amount_paid, status, public_token, org_id, customers(name, phone, address), jobs(address)")
    .eq("id", id)
    .maybeSingle();
  if (!invoice) return { ok: false, error: "Invoice not found." };
  const { data: org } = await supabase.from("organizations").select("name, settings").maybeSingle();
  // TEXTING NOT SET UP (lib/sms-readiness): said where he tapped, before the invoice is stamped
  // sent or anything is promised. The receipt row reads `notReady` and opens Text From This Phone.
  if (!smsReadiness(org).ready) return { ok: false, notReady: true, error: TEXT_NOT_READY_REFUSAL };
  const customer = (invoice as any).customers;
  if (!customer?.phone)
    return { ok: false, error: "This customer has no phone number." };

  const balance = invoiceBalance(invoice.total, invoice.amount_paid);
  const link = await publicInvoiceLink(supabase, (invoice as any).org_id, (invoice as any).public_token, rowPlace(invoice as any));
  const body = `${org?.name ?? "Your contractor"}: Invoice ${invoice.invoice_number}, balance $${balance.toFixed(2)}. View/pay: ${link}`;

  const sent = await sendSms(customer.phone, body, (org as any)?.settings?.sms_from_number);
  // Texting is set up (asked above), so a false here is the service refusing it; sendSms has
  // already logged why.
  if (!sent) return { ok: false, error: TEXT_REFUSED };
  // The text is already in the customer's hand, so the deed happened whatever the row does next
  // — which is why this is stamped (0267) and why a failure here is reported as "it went out but
  // the status didn't stick" rather than as a failed send. Silent is the one thing it can't be:
  // the office would be looking at a Draft badge on a bill the customer is reading.
  //
  // AND A SECOND TEXT IS A SECOND DELIVERY (0269). This used to stamp only inside the draft
  // branch, which was complete right up until a delivered invoice could be revised: fix a line on
  // a sent bill, text the customer the corrected one, and `revised_at > sent_at` would have
  // stayed true forever — the page nagging "they're holding an older copy" about the copy that
  // had just gone out, with no way at all to make it stop. The status half of the stamp is the
  // part that must not repeat: markInvoiceResent moves the DATE and leaves 'paid' alone, because
  // texting someone a copy of a bill they have paid must never put them back on the AR list.
  // A VOID invoice is texted without a stamp: it is not a bill, and its link does not open
  // (public_invoice is narrowed to sent/partial/paid/overdue), so recording a delivery on it
  // would put a date on a thing that was cancelled.
  const first = invoice.status === "draft";
  const label = invoice.invoice_number ?? "this invoice";
  const stamped = first ? await markInvoiceSent(supabase, id) : invoice.status === "void" ? { ok: true } : await markInvoiceResent(supabase, id);
  if (!stamped.ok) {
    // Two different failures, so two different sentences. A draft that missed its flip needs its
    // status set; a re-send that missed only lost the DATE, and telling the office to set a paid
    // invoice's status to Sent would walk it back onto the AR list to fix a cosmetic stamp.
    return {
      ok: false,
      error: first
        ? `The text went out, but ${label} didn't get marked as sent - reload and set its status to Sent. (${stamped.error ?? "try again"})`
        : `The text went out, but ${label} still reads as changed since it was last sent - send it again in a moment to clear that. (${stamped.error ?? "try again"})`,
    };
  }
  // Same reason as setInvoiceStatus: a prepaid draft must land on paid/partial, not 'sent'.
  if (first) await recalcInvoice(supabase, id);
  revalidateMoney(id);
  // Warm the stored PDF (0198) post-response so the customer's Download button works from
  // the first minute — after() never slows the send; the render carries the sender's cookies.
  const h = await headers();
  const warmHost = h.get("x-forwarded-host") ?? h.get("host");
  const warmProto = h.get("x-forwarded-proto") ?? "https";
  const warmCookie = h.get("cookie");
  // Headers are read BEFORE after() — request APIs inside the callback are on borrowed time.
  after(async () => {
    if (warmHost) await warmDocPdf("invoice", id, `${warmProto}://${warmHost}`, warmCookie);
  });
  return { ok: true };
}

export async function emailInvoice(
  id: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const res = await deliverInvoiceEmail(ctx.supabase, id);
  if (res.ok) {
    revalidateMoney(id);
    // Warm the stored PDF (0198) post-response so the customer's Download button works from
    // the first minute — after() never slows the send; the render carries the sender's cookies.
    const h = await headers();
    const warmHost = h.get("x-forwarded-host") ?? h.get("host");
    const warmProto = h.get("x-forwarded-proto") ?? "https";
    const warmCookie = h.get("cookie");
    // Headers are read BEFORE after() — request APIs inside the callback are on borrowed time.
    after(async () => {
      if (warmHost) await warmDocPdf("invoice", id, `${warmProto}://${warmHost}`, warmCookie);
    });
  }
  return res;
}

export type Result = { ok: boolean; error?: string; id?: string };

/** What an import actually did (migration 0175), so the UI can say it plainly instead of
 *  "imported" — the ambiguity of that one word is most of why the old behaviour felt like
 *  force-feeding. `kept_edited` is the number the office cares about: their negotiated prices.
 *  0255 adds the other half of the sentence: what this run deliberately LEFT on another invoice. */
export type ImportStats = {
  inserted: number;
  updated: number;
  kept_edited: number;
  removed: number;
  /** Source rows this run pulled in — time entries, bills + orders, change orders,
   *  estimate lines — that were NOT on the invoice before it: a refresh that re-wrote a line's
   *  claims unchanged, or an id an edited line already held, is not "pulled in". */
  pulled_in: number;
  /** Offered source rows that did NOT land: they belong on a line the office edited (which keeps
   *  its own numbers) or one it deleted (tombstoned, 0175). The count Start It Over is for — the
   *  run had rows to place and the RPC could place none of them. */
  held_back: number;
  /** Source rows skipped because another non-void invoice on this job already bills them (their claim). */
  skipped_claimed: number;
  /** The invoice numbers holding those claims, oldest first — e.g. ["INV-061"]. */
  claimed_on: string[];
  /** Materials only: takes from stock (Took From Stock) newly on the invoice this run, one line
   *  each. Counted apart from `pulled_in`, whose noun is "bills". */
  stock_pulled_in?: number;
  /** The sentence, ready to show: "5 time entries pulled in · 9 already on INV-061 skipped". */
  summary: string;
  /** Money the office should look at before sending, one sentence each (materials only, so far):
   *  an edited "Supplies & tax" row left behind by its re-priced parts (INV-074). */
  warnings?: string[];
  /** What this run did that the counts don't say, one clause each, for a caller that writes its
   *  own sentence instead of showing `summary` (refreshActualsDraw): a counter-preview price, a
   *  supplier return not credited or held, the invoice's own markup kept. Also in `summary`. */
  notes?: string[];
};
/** `emptyNote`: on an EMPTY run, a reason a caller should still pass on (a supplier return held
 *  back or not credited, with nothing else to bill), rather than the silent "nothing to pull". */
type ImportResult = Result & { empty?: boolean; emptyNote?: string; stats?: ImportStats };
type RpcStats = { inserted: number; updated: number; kept_edited: number; removed: number };

/**
 * DID THIS IMPORT CHANGE THE BILL? — the question the revision stamp (0269) asks of an importer.
 *
 * An import is idempotent by design: tapping "Import Labor" again on an invoice whose lines are
 * all `kept_edited` writes nothing at all. Stamping `revised_at` for that would tell the office
 * their customer is holding an older copy of a bill that did not move — and a nag that cries wolf
 * is one nobody reads by the third time, which is how NOTHING SILENT quietly stops working.
 *
 * An ABSENT stats object is treated as a change. The RPC returning nothing means we do not know,
 * and on a bill the customer is holding, "we don't know" has to resolve towards saying so.
 */
function importMovedMoney(stats?: RpcStats): boolean {
  if (!stats) return true;
  return Number(stats.inserted ?? 0) + Number(stats.updated ?? 0) + Number(stats.removed ?? 0) > 0;
}

/** Migration 0255 hasn't landed yet (a push deploys before its migration runs): claims are
 *  unknowable, so for those few minutes the old rule has to hold — never bill a second invoice's
 *  rows blind. ONE sentence for every importer, so labor and materials refuse alike, and it says
 *  how long. */
function midUpgradeRefusal(claims: ClaimedSources): Result {
  const other = claims.invoices[0];
  return {
    ok: false,
    error: `Billing is mid-upgrade for a few minutes — this job's time and materials can't be split across ${other?.invoice_number ?? "two invoices"} and this one until it finishes. Try again shortly.`,
  };
}

/**
 * WHAT ACTUALLY LANDED — the source ids the invoice's lines for `source` hold after the RPC ran.
 *
 * An EDITED line keeps its own claims and takes none of the new ones (0255), so what the RPC took
 * can be fewer than what it was handed; a stat that counted the offer would tell the office five
 * entries went on when two of them are still free. Before 0255 (no source_ids column) the same
 * answer comes from `edited` (0175): an unedited line for an offered key took that key's whole
 * offer. Returns null only when the read-back itself fails — the import DID land, so the caller
 * reports from the RPC's own counters instead of failing a write that succeeded.
 */
async function landedSourceIds(
  supabase: Awaited<ReturnType<typeof createClient>>,
  invoiceId: string,
  source: string,
  offered: ImportRow[],
): Promise<Set<string> | null> {
  const read = (withClaims: boolean) =>
    supabase.from("invoice_items").select(`import_key, edited${withClaims ? ", source_ids" : ""}`).eq("invoice_id", invoiceId).eq("import_source", source);
  let withClaims = true;
  let res: { data: unknown[] | null; error: unknown | null } = await read(true);
  if (res.error && isMissingColumn(res.error, "source_ids")) {
    withClaims = false;
    res = await read(false);
  }
  if (res.error) {
    reportError("landedSourceIds", res.error, { invoiceId, source });
    return null;
  }
  const offer = new Map(offered.map((r) => [r.import_key, r.source_ids ?? []] as const));
  const landed = new Set<string>();
  for (const line of (res.data ?? []) as { import_key?: string | null; edited?: boolean | null; source_ids?: string[] | null }[]) {
    if (withClaims) for (const sid of line.source_ids ?? []) landed.add(String(sid));
    else if (!line.edited) for (const sid of offer.get(String(line.import_key ?? "")) ?? []) landed.add(sid);
  }
  return landed;
}

/** landedSourceIds' answer from each side of the RPC — the two reads withClaimStats diffs. */
type LandedDiff = { before: Set<string>; after: Set<string> };

/** Both reads have to succeed for the diff to mean anything: a missing side would count every id
 *  as new (or none), so the RPC's own line counters speak instead. */
const landedDiff = (before: Set<string> | null, after: Set<string> | null): LandedDiff | null => (before && after ? { before, after } : null);

/** Fold the RPC's four counters together with what the claim filter did and what LANDED, and write
 *  the toast's sentence in the source's own noun ("time entries", "bills", "change orders",
 *  "estimate lines"). `offered` is what the app handed the RPC; `landed` is landedSourceIds'
 *  answer from BEFORE the RPC and AFTER it (null = a read-back failed, so only the RPC's own line
 *  counters may speak). pulled_in counts offered ids that are NEW to the invoice this run — never
 *  the offer itself, and never an id that was already there: an edited line keeps the ids it holds
 *  through every re-import, and a refresh re-writes an unedited line's ids unchanged, so counting
 *  "landed" alone told the office "5 time entries pulled in" on a tap that added nothing. That is
 *  the sentence that sends someone looking for the five. */
function withClaimStats(rpc: RpcStats | undefined, offered: ImportRow[], landed: LandedDiff | null, skippedIds: string[], claims: ClaimedSources, noun: string): ImportStats {
  const claimed_on = claimantNumbers(claims, skippedIds);
  const offer = [...new Set(offered.flatMap((r) => r.source_ids ?? []))];
  // Three buckets of the offer: on the invoice now, of which NEW since before the RPC; and not on it.
  const onInvoice = landed ? offer.filter((id) => landed.after.has(id)) : [];
  const took = landed ? onInvoice.filter((id) => !landed.before.has(id)).length : (rpc?.inserted ?? 0) + (rpc?.updated ?? 0);
  const heldBack = landed ? offer.length - onInvoice.length : 0;
  const skipped = skippedIds.length ? `${skippedIds.length} already on ${joinNumbers(claimed_on) || "another invoice"} skipped` : "";
  const parts = landed
    ? [
        took ? `${took} ${noun} pulled in` : `no new ${noun}`,
        // The RPC left an edited line alone, so the rows offered for it did not land (0255) and stay
        // free for the next invoice. Said, with the door out: Start It Over rebuilds the source.
        heldBack ? `${heldBack} not added — ${heldBack === 1 ? "it belongs" : "they belong"} on a line you edited, which keeps its own numbers (Start It Over rebuilds it)` : "",
        skipped,
      ]
    : [
        // The read-back failed: the only honest count is what the RPC itself reported, in lines.
        `${took} ${took === 1 ? "line" : "lines"} added or refreshed`,
        rpc?.kept_edited ? `${rpc.kept_edited} edited ${rpc.kept_edited === 1 ? "line" : "lines"} left alone` : "",
        skipped,
      ];
  return {
    inserted: 0,
    updated: 0,
    kept_edited: 0,
    removed: 0,
    ...(rpc ?? {}),
    pulled_in: took,
    held_back: heldBack,
    skipped_claimed: skippedIds.length,
    claimed_on,
    summary: parts.filter(Boolean).join(" · "),
  };
}

/** A push deploys before its migration runs (cn-v576 lesson): a write naming a column that isn't
 *  there yet fails the whole statement. This recognises exactly that shape — Postgres 42703 and
 *  PostgREST's schema-cache miss — and nothing else, so a real error still surfaces. */
function isMissingColumn(err: unknown, column: string): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  const msg = String((err as { message?: string })?.message ?? "");
  return code === "42703" || code === "PGRST204" || (msg.includes(column) && /does not exist|could not find/i.test(msg));
}

/** Default invoice due date = today (in the org tz) + the org's net terms, stamped to
 *  NOON in the org tz (same convention as setInvoiceDueDate / payment dates). Without a
 *  due date the Overdue tracker never fires, so EVERY creation path stamps one. Net terms
 *  come from the org's invoice_due_days setting; if it's unset/0 we fall back to Net 30.
 *  (Body lifted to @/lib/invoice-due so the unattended recurring-invoice cron — which has
 *  no auth context and must name its org explicitly — stamps the SAME date.) */
async function defaultDueDateIso(supabase: { from: (t: string) => any }): Promise<string> {
  return defaultDueDateIsoForOrg(supabase); // user client: RLS scopes the org read
}

/** Convert an accepted (or any) quote into a draft invoice, copying line items. */
export async function createInvoiceFromQuote(quoteId: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: quote, error: qErr } = await supabase
    .from("quotes")
    .select("*")
    .eq("id", quoteId)
    .maybeSingle();
  if (qErr || !quote) return { ok: false, error: "Quote not found." };

  // Idempotent: a quote maps to one LIVE invoice. Re-tapping "Create invoice" returns the
  // existing one instead of billing the customer twice. A VOID one is not "the" invoice — voiding
  // released its claims, and a quote whose invoice was voided can be billed again; handing the
  // void row back opened a dead document and made the estimate unbillable for good.
  const { data: existingInv } = await supabase
    .from("invoices")
    .select("id, invoice_number, status, invoice_kind")
    .eq("quote_id", quoteId)
    .neq("status", "void")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existingInv) {
    // REUSED ONLY WHILE IT'S A DRAFT (Connected North Phase 1; Tao Zhu J-002). Handing back a bill
    // that already went out made "New Invoice" open Tao's PAID $10,000 deposit as the place for new
    // work. A draft is still being built - open it. One that went out is said, with where to go.
    const ex = existingInv as { id: string; invoice_number: string | null; status: string | null; invoice_kind: string | null };
    if (ex.status === "draft") return { ok: true, id: ex.id };
    const label = ex.invoice_number ?? "an invoice that already went out";
    return {
      ok: false,
      id: ex.id,
      error: isDrawKind(ex.invoice_kind)
        ? `This estimate is billed with progress payments - ${label} came from it. Bill the next part with Progress Payment on the job's Invoices tab.`
        : `This estimate is already billed on ${label}. Open it from Billing, or bill anything extra as a change order.`,
    };
  }

  // H4: a job already on the draw path can't also be billed by a standard invoice
  // carrying the full quoted amount (no import step would ever credit the draws).
  const drawBlock = await blockStandardCreateOnDrawJob(supabase, quote.job_id);
  if (drawBlock) return drawBlock;

  const dueDate = await defaultDueDateIso(supabase);
  const { data: invoice, error } = await supabase
    .from("invoices")
    .insert({
      customer_id: quote.customer_id,
      job_id: quote.job_id,
      quote_id: quote.id,
      title: quote.title,
      /**
       * THE ESTIMATE'S NOTES DO NOT BECOME THE BILL'S (Erik, 8/18: "dont forget about all the
       * notes at the bottom from the estimate that shouldnt be there").
       *
       * A quote's notes describe an OFFER — "OPTIONS — not included in the total above",
       * A/B upgrades the customer didn't take, "this estimate is based on the assumption
       * that no obstacles arise". Copied onto an invoice they read as things being billed,
       * on a document that bills work already finished. Badger Lane's invoice carried its
       * estimate's options block verbatim, three weeks after the work was done.
       *
       * The invoice starts with its own empty notes. The work narrative has its own field
       * (description, printed above the line items) and the payment wording comes from the
       * org's invoice terms — neither is touched here.
       */
      notes: null,
      tax_rate: quote.tax_rate,
      subtotal: quote.subtotal,
      tax: quote.tax,
      total: quote.total,
      due_date: dueDate,
      status: "draft",
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: dbError(error) };

  const { data: items } = await supabase
    .from("quote_line_items")
    .select("id, description, quantity, unit, unit_price, sort_order")
    .eq("quote_id", quoteId)
    .order("sort_order");

  if (items?.length) {
    // STAMP THE COPIES WITH THE IMPORTER'S OWN IDENTITY (audit v800). These rows used to land
    // with import_source NULL — indistinguishable from hand-typed lines — so a later tap of
    // "From Estimate" matched nothing, inserted the whole estimate a SECOND time, and doubled
    // the invoice total with no warning (the confirm counts rows by import_source, so it read
    // "0 replacing" and never fired). Keyed identically to importQuoteItemsIntoInvoice, a
    // re-import now refreshes these rows in place.
    // AN ESTIMATE LINE PRICED FROM THE BOOK IS STILL A BOOK LINE ON THE BILL (0342): its leading
    // code finds its book item, which says labor (sold by the hour) or materials (it names a
    // supplier), so the customer's breakdown files it there instead of under Other. A line the book
    // does not know, or whose item says neither (installed work, a job-cost code), says nothing.
    const book = await readPriceBookUnits(supabase, ctx.orgId);
    let copies: Record<string, unknown>[] = items.map((it: any) => {
      const kind = kindFromPriceBook(it, book);
      return {
        invoice_id: invoice.id,
        description: it.description,
        quantity: it.quantity,
        unit: it.unit,
        unit_price: it.unit_price,
        sort_order: it.sort_order,
        import_source: "quote",
        import_key: `quote:${it.id}`,
        // THE CLAIM (0255): this line bills that estimate line, so no other invoice on the job pulls it in.
        source_ids: [String(it.id)],
        ...(kind ? { line_kind: kind } : {}),
      };
    });
    let itemsErr = (await supabase.from("invoice_items").insert(copies)).error;
    // A column that is not on this database yet (0255's claim, 0342's kind): land the lines without
    // it rather than fail the whole invoice. The key still names the source (the 0256 backfill
    // derives the claim from it) and a line with no kind reads as it always did.
    for (const col of ["line_kind", "source_ids"] as const) {
      if (itemsErr && isMissingColumn(itemsErr, col) && copies.some((c) => col in c)) {
        copies = copies.map(({ [col]: _gone, ...rest }) => rest);
        itemsErr = (await supabase.from("invoice_items").insert(copies)).error;
      }
    }
    if (itemsErr) {
      /**
       * DON'T LEAVE A BURNED INVOICE BEHIND.
       *
       * The header row is inserted first, so a rejected item insert — now a real possibility,
       * because the 0258 claim boundary refuses lines whose estimate rows another live invoice
       * already bills ("work already billed on INV-061") — used to return the error and leave
       * an EMPTY invoice holding a real invoice number. Worse, that empty row carries this
       * quote_id, so the next tap of Create Invoice matched it at the top of this function and
       * handed the office a blank document as if it were the bill.
       *
       * The lines land in one statement, so nothing of the invoice exists yet: take the header
       * back out and hand up the database's own sentence, which already names the invoice to
       * void or adjust.
       */
      const { data: gone, error: delErr } = await supabase.from("invoices").delete().eq("id", invoice.id).select("id");
      if (delErr || !gone?.length) {
        reportError("createInvoiceFromQuote.cleanup", delErr ?? new Error("empty invoice not removed"), { quoteId, invoiceId: invoice.id });
        return {
          ok: false,
          error: `${dbError(itemsErr)} An empty invoice was left behind for this estimate; delete it on Billing before trying again.`,
        };
      }
      return { ok: false, error: dbError(itemsErr) };
    }
  }

  // DERIVE THE TOTAL FROM THE LINES THAT LANDED (audit v921 high). The header was copied from
  // the quote row; the invoice's own line_totals are what every later recalc computes from. A
  // one-cent difference between the two meant the customer paid the sent total in full and the
  // first recalc (their payment) flipped the invoice to "partial, $0.01 owed" — into AR aging,
  // into the dunning cron, with a $0.01 pay link live on the customer's copy.
  await recalcInvoice(supabase, invoice.id);

  revalidateMoney();
  return { ok: true, id: invoice.id };
}

export async function createBlankInvoice(input: {
  customer_id: string | null;
  job_id?: string | null;
  title: string;
  description?: string | null;
  tax_rate: number;
}): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  // H4: a job already on the draw path is billed by draws, not a standard invoice.
  const drawBlock = await blockStandardCreateOnDrawJob(supabase, input.job_id);
  if (drawBlock) return drawBlock;

  // If a job is chosen, inherit its customer (and a title) so the invoice is
  // never orphaned from the job it belongs to — this is what makes the payment
  // show up on the job's revenue/costs.
  let customerId = input.customer_id;
  let title = input.title;
  if (input.job_id) {
    const { data: job } = await supabase
      .from("jobs")
      .select("customer_id, name, job_number")
      .eq("id", input.job_id)
      .single();
    if (job) {
      if (!customerId) customerId = job.customer_id ?? null;
      if (!title) title = job.name || job.job_number || "";
    }
  }

  const dueDate = await defaultDueDateIso(supabase);
  const { data, error } = await supabase
    .from("invoices")
    .insert({
      customer_id: customerId,
      job_id: input.job_id || null,
      title: title || null,
      description: input.description ?? null,
      tax_rate: input.tax_rate || 0,
      due_date: dueDate,
      status: "draft",
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error) return { ok: false, error: dbError(error) };

  revalidateMoney();
  if (input.job_id) revalidatePath(`/jobs/${input.job_id}`);
  return { ok: true, id: data.id };
}

/**
 * PUT THE LINES IN THE ORDER HE READS THEM IN (Erik, 8/18).
 *
 * "id really like to be able to move line items up and down just like the playbook so … if i
 * delete something and realize i want it i dont need to reimport", and "id like to be able to
 * group the labor together since itll be showing up at the bottom of the list."
 *
 * An invoice is a document a customer reads top to bottom, and until now its order was an
 * accident of when each line was imported or typed. sort_order existed and nothing could change
 * it. This writes the whole sequence in one call — the same shape the playbook's reorder uses —
 * so a move is atomic and can't leave two lines fighting over one position.
 *
 * Draft-only (the customer's copy is fixed once sent) and every id must belong to THIS invoice:
 * a crafted list can neither reach another tenant's line nor drag one invoice's item onto
 * another's. Ordering is presentation — it never touches an amount, so nothing here recalcs.
 */
/**
 * PARK A DRAFT (0206) — the ending that doesn't destroy anything.
 *
 * A draft waiting on a change order or the customer's go-ahead had only two exits: Void (which
 * unlinks the payment milestones) or Delete (which throws away the line items). Both record
 * something false about a bill that is simply not ready. This sets a date the office chooses;
 * the invoice leaves Needs action and comes BACK when the date passes — because "parked
 * forever" is how a real bill gets forgotten, which is the failure the feeder exists to prevent.
 */
export async function parkInvoice(invoiceId: string, until: string | null, reason?: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // Parking is a DRAFTING decision — a sent invoice is the customer's, and it owes money. The
  // line lock came off in 0269; this did not, because setting a bill aside before it goes out is
  // not the same act as fixing a line on one that already has.
  const block = await requireDraftInvoice(
    supabase,
    invoiceId,
    "Parking is for a bill that hasn't gone out yet, so it only works on a draft. This one is already with the customer - if it isn't going to be paid, void it, or use Credit / Refund in the Actions menu.",
  );
  if (block) return block;
  if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) return { ok: false, error: "Pick a date." };

  const { data: wrote, error } = await supabase
    .from("invoices")
    .update({ hold_until: until, hold_reason: until ? (reason?.trim() || null) : null })
    .eq("id", invoiceId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!wrote?.length) return { ok: false, error: "That didn't save - check your access and try again." };
  revalidateMoney(invoiceId);
  revalidatePath("/planner");
  return { ok: true };
}

export async function reorderInvoiceItems(invoiceId: string, orderedIds: string[]): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const block = await requireLiveInvoice(supabase, invoiceId);
  if (block) return block;

  const { data: mine } = await supabase.from("invoice_items").select("id").eq("invoice_id", invoiceId);
  const own = new Set(((mine ?? []) as { id: string }[]).map((r) => r.id));
  const ids = (orderedIds ?? []).filter((id) => own.has(id));
  // Any line the caller didn't name keeps its place at the end, so a stale tab can never
  // silently drop a row out of the document.
  const rest = [...own].filter((id) => !ids.includes(id));
  const finalOrder = [...ids, ...rest];
  if (!finalOrder.length) return { ok: true };

  for (let i = 0; i < finalOrder.length; i++) {
    const { data: wrote, error } = await supabase
      .from("invoice_items")
      .update({ sort_order: i })
      .eq("id", finalOrder[i])
      .eq("invoice_id", invoiceId)
      .select("id");
    if (error) return { ok: false, error: dbError(error) };
    // Silent-write law: an RLS-refused reorder must not report success.
    if (!wrote?.length) return { ok: false, error: "That didn't save — check your access and try again." };
  }
  // Ordering touches no amount, but it does change the DOCUMENT, and 0269 names reordering among
  // the revisions worth recording: a customer comparing their copy to this one would see a
  // different bill. On the record, like every other change to a delivered invoice.
  await stampInvoiceRevised(supabase, invoiceId, "reorderInvoiceItems");
  // AND THE STORED COPY HAS TO GO WITH IT (all three reviewers of cn-v962). Every other line
  // mutation ends in recalcInvoice, which busts the stored PDF on its way out (invoice-recalc.ts).
  // This one moves no money, so it never called recalc - harmless while reordering was draft-only,
  // and a lie the moment this wave allowed it on a bill the customer already has: Download PDF
  // would keep serving the old line order under a document that says it was revised. revalidateMoney
  // clears Next's cache and does not touch the PDF store at all. Best effort by design, so it
  // cannot cost the reorder that already landed.
  await bustDocPdf("invoice", invoiceId);
  revalidateMoney(invoiceId);
  return { ok: true };
}

export async function addInvoiceItem(
  invoiceId: string,
  /** `kind`: what the line IS when the door knows (0342): the price-book picker and a linked kit
   *  line say labor for a book item sold by the hour, materials for one that names a supplier.
   *  Omitted, the server reads the line's leading code against this org's price book by the same
   *  rule; no code, or an item that says neither, and the line says nothing. */
  item: { description: string; quantity: number; unit: string; unit_price: number; kind?: PickableLineKind | null },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (Math.abs((item.quantity || 1) * (item.unit_price || 0)) > 9_999_999_999)
    return { ok: false, error: "That amount is too large." };
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, job_id, invoice_kind, status")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv) return { ok: false, error: "Invoice not found." };
  // This door carried its own inline copy of the line lock rather than calling the helper, which
  // is exactly how a rule drifts: when the lock came off in 0269 there were two places to change
  // it, and one of them looked like an ordinary status check. Same decision, one source.
  const notEditable = invoiceLineEditRefusal(inv.status);
  if (notEditable) return { ok: false, error: notEditable };
  if (inv.job_id) {
    const conflict = await standardInvoiceOnDrawJob(supabase, inv, invoiceId);
    if (conflict) return conflict; // H4: can't add billable lines to a standard invoice on a draw job
  }
  /**
   * A NEW LINE GOES AT THE END (Erik, 8/18: "i just added a line item for labor - brian and it
   * automatically sent it to the top").
   *
   * The insert never set sort_order, so the column default of 0 applied — and 0 sorts ABOVE
   * every imported line (the importer numbers them as it goes). So every line typed by hand
   * jumped to the top of the customer's document, which reads as the app rearranging his
   * invoice behind his back. Append, then let him move it with the arrows.
   */
  const { data: last } = await supabase
    .from("invoice_items")
    .select("sort_order")
    .eq("invoice_id", invoiceId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextSort = Number((last as { sort_order?: number } | null)?.sort_order ?? -1) + 1;

  /**
   * A PRICE-BOOK LINE SAYS WHAT IT IS (Erik, INV-079: "Other instead of materials in invoice").
   * The door's word first (the picker knows the item it priced); failing that, the line's own
   * leading code against this org's book (hours = labor, a supplier = materials), the rule 0342's
   * backfill ran on the lines already out.
   * Neither, and the line stores nothing and is read by its words as it always was.
   */
  const said = pickableLineKind(item.kind);
  const lineKind = said ?? kindFromPriceBook(item, await readPriceBookUnits(supabase, ctx.orgId));
  const row: Record<string, unknown> = {
    invoice_id: invoiceId,
    description: item.description,
    quantity: item.quantity || 1,
    unit: item.unit || "ea",
    unit_price: item.unit_price || 0,
    sort_order: nextSort,
  };
  if (lineKind) row.line_kind = lineKind;
  let { error } = await supabase.from("invoice_items").insert(row);
  // 0342 not applied yet: land the line without its kind rather than refuse it. It reads as before.
  if (error && lineKind && isMissingColumn(error, "line_kind")) {
    delete row.line_kind;
    ({ error } = await supabase.from("invoice_items").insert(row));
  }
  if (error) return { ok: false, error: dbError(error) };
  await stampInvoiceRevised(supabase, invoiceId, "addInvoiceItem");
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  return { ok: true };
}

/** Replace this invoice's previously-imported rows for a given source with a fresh set, so
 *  re-importing REFRESHES the lines (current total) instead of duplicating them. Delegates
 *  to the atomic, advisory-locked RPC (0156) so two overlapping imports can't both land.
 *  Hand-entered rows (import_source null) and other sources are never touched. */
/** An imported line, carrying the stable identity of the thing it represents — and, since 0255,
 *  its CLAIM: the source row ids it bills (time entry / bill / PO / change order /
 *  estimate line). Another invoice on the job never imports a claimed row. */
type ImportRow = { import_key: string; description: string; quantity: number; unit: string; unit_price: number; source_ids?: string[] };

// A bill's lines (with 0268 billable / 0272 billed_amount) are read by lib/invoice-markup-read's
// readBillLines - the same read the invoice page's % box uses to say what the lines are priced at.

/**
 * ADDITIVE import (migration 0175). Matches incoming rows against what is already on the
 * invoice BY KEY, so one call can refresh, append and leave-alone independently:
 *
 *   new key                       -> appended   (the work that accrued since — the whole point)
 *   existing key, never edited    -> refreshed in place, keeping its sort_order
 *   existing key, edited by hand  -> LEFT ALONE (a negotiated price is not the importer's to touch)
 *   key deleted from this invoice -> never comes back (tombstoned in dismissed_import_keys)
 *   key gone from the source      -> removed, unless it was edited
 *
 * This replaces a delete-and-rebuild that had no key at all, so "import only the new time and
 * materials" was not merely unimplemented — there was nothing to match on. Still advisory-locked
 * per (invoice, source) and still SECURITY INVOKER, so RLS governs the writes exactly as before.
 */
async function upsertImportedItems(
  supabase: Awaited<ReturnType<typeof createClient>>,
  invoiceId: string,
  source: string,
  rows: ImportRow[],
): Promise<{ error?: string; stats?: RpcStats; removed?: RemovedLine[] }> {
  /**
   * A REFRESH NEVER SILENTLY DROPS A LINE THAT IS ON THE INVOICE (INV-078, 2026-09-24).
   *
   * The RPC filters the offer through dismissed_import_keys BEFORE it reconciles, and then removes
   * every unedited keyed line the (filtered) offer doesn't name. So a line that is ON the invoice
   * while its key also sits in the tombstones - put back by hand after a delete, as INV-078's Home
   * Depot 14-2 rolls were - is read as "gone from the source" and deleted, by the importer, so not
   * even re-tombstoned: $186.48 of wire left the bill and nothing said so. A line that is present is
   * the office's answer to "do you want this on the bill"; the tombstone that says otherwise is
   * stale. So it is cleared, checked, BEFORE the RPC runs - and when it can't be, nothing runs.
   *
   * And what the RPC does remove (a bill deleted, a receipt line marked not billable, an entry moved
   * to another job) is named, line by line, from a read on each side of it: `removed`.
   */
  const lineRead = () =>
    supabase.from("invoice_items").select("id, import_key, description, line_total").eq("invoice_id", invoiceId).eq("import_source", source);
  const [beforeLines, keysRow] = await Promise.all([lineRead(), supabase.from("invoices").select("dismissed_import_keys").eq("id", invoiceId).maybeSingle()]);
  if (beforeLines.error || keysRow.error) {
    reportError("upsertImportedItems.read", beforeLines.error ?? keysRow.error, { invoiceId, source });
    return { error: "Couldn't read this invoice's lines just now, so nothing was imported - try again in a moment." };
  }
  const present = ((beforeLines.data ?? []) as PresentLine[]).filter((l) => l.import_key);
  const dismissed = (((keysRow.data as { dismissed_import_keys?: string[] | null } | null)?.dismissed_import_keys ?? []) as string[]).map(String);
  const stale = staleTombstones(present, dismissed);
  if (stale.length) {
    // GUARDED ON THE VALUE IT READ. A line deleted between the read and this write tombstones its
    // key (0175's delete trigger appends it); an unguarded write would drop that new tombstone and
    // the RPC below would put the just-deleted line straight back. Zero rows = the invoice changed
    // while this ran: said, and nothing imported.
    const { data: cleared, error: clearErr } = await supabase
      .from("invoices")
      .update({ dismissed_import_keys: dismissed.filter((k) => !stale.includes(k)) })
      .eq("id", invoiceId)
      .filter("dismissed_import_keys", "eq", textArrayLiteral(dismissed))
      .select("id");
    if (clearErr || !cleared?.length) {
      reportError("upsertImportedItems.staleTombstones", clearErr ?? "zero rows", { invoiceId, source, stale });
      return {
        error: clearErr
          ? "Couldn't update this invoice just now, so nothing was imported (a line on it would have been dropped) - try again in a moment."
          : "This invoice's lines changed while the import ran, so nothing was imported - try again.",
      };
    }
  }
  const { data, error } = await supabase.rpc("upsert_imported_invoice_items", {
    p_invoice_id: invoiceId,
    p_source: source,
    p_rows: rows,
  });
  if (error) return { error: dbError(error) };
  const stats = (data ?? undefined) as RpcStats | undefined;
  let removed: RemovedLine[] | undefined;
  if (Number(stats?.removed ?? 0) > 0 || !stats) {
    const afterLines = await lineRead();
    if (afterLines.error) reportError("upsertImportedItems.readBack", afterLines.error, { invoiceId, source });
    else removed = removedLines(present, (afterLines.data ?? []) as PresentLine[]);
  }
  return { stats, removed };
}

/**
 * A TAKE'S LINE SAYS IT IS MATERIALS (0342's stored kind). The import RPC writes no line_kind, so
 * the lines for these keys that carry none get 'materials' here - never over a kind the office set.
 * Setting line_kind is not an edit (mark_invoice_item_edited reads only the words, count, unit and
 * price) and not a claim change. Checked (the silent-write law): a failure goes to the ops log and
 * nothing else, because the line already reads Materials from its import source everywhere.
 */
async function stampStockLinesMaterials(
  supabase: Awaited<ReturnType<typeof createClient>>,
  invoiceId: string,
  keys: string[],
): Promise<void> {
  if (!keys.length) return;
  const { error } = await supabase
    .from("invoice_items")
    .update({ line_kind: "materials" })
    .eq("invoice_id", invoiceId)
    .eq("import_source", "costs")
    .in("import_key", keys)
    .is("line_kind", null)
    .select("id");
  if (error && !isMissingColumn(error, "line_kind")) reportError("importCosts.stockLineKind", error, { invoiceId, keys: keys.length });
}

/** An imported line as the importer reads it on each side of the RPC. */
type PresentLine = { id: string; import_key: string | null; description: string | null; line_total: number | string | null };
/** A line the importer took off the invoice, in the office's words. */
type RemovedLine = { importKey: string; description: string; amount: number };

/** Put what the importer took off the invoice in front of the office - a warning, never silent. */
function sayRemoved(stats: ImportStats, removed: RemovedLine[] | undefined): ImportStats {
  const said = removedSentence(removed ?? []);
  if (said) stats.warnings = [...(stats.warnings ?? []), said];
  return stats;
}

/** Import the linked job's quote line items into this invoice (idempotent). */
export async function importQuoteItemsIntoInvoice(invoiceId: string): Promise<ImportResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, job_id, quote_id, invoice_kind")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv) return { ok: false, error: "Invoice not found." };
  // A DRAW NEVER TAKES THE ESTIMATE'S LINES. A contract draw is already a slice of that estimate,
  // and an actuals draw bills hours and receipts - the estimate on either bills the job twice. The
  // invoice page never offers From Estimate on a draw; this is the same rule where it holds.
  if (isDrawKind(inv.invoice_kind)) {
    return { ok: false, error: "A progress payment doesn't take the estimate's lines - it bills a part of the contract, or the hours and receipts. Put estimate lines on a standard invoice." };
  }
  const block = await requireLiveInvoice(supabase, invoiceId);
  if (block) return block; // 0269: void only. Re-billing is still impossible — the claims see to it
  if (inv.job_id) {
    const conflict = await standardInvoiceOnDrawJob(supabase, inv, invoiceId);
    if (conflict) return conflict; // H4: don't re-bill quoted scope onto a standard invoice on a draw job
  }

  let quoteId = inv.quote_id;
  if (!quoteId && inv.job_id) {
    const { data: q } = await supabase
      .from("quotes")
      .select("id")
      .eq("job_id", inv.job_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    quoteId = q?.id ?? null;
  }
  if (!quoteId) return { ok: false, error: "No quote found on this invoice's job." };

  const { data: items } = await supabase
    .from("quote_line_items")
    .select("id, description, quantity, unit, unit_price")
    .eq("quote_id", quoteId)
    .order("sort_order");
  if (!items?.length) return { ok: false, error: "The quote has no line items." };
  // An estimate line already on another non-void invoice of this job stays there (0255): this
  // invoice takes only what nobody billed yet, instead of being refused outright as under cn-v479.
  // Read by id as well as by job, so a line billed before the quote moved is still seen as claimed.
  const claims = await claimedSourcesOnJob(supabase, inv.job_id ?? null, invoiceId, (items as any[]).map((it) => String(it.id)));
  const skippedIds = (items as any[]).filter((it) => claims.owner.has(String(it.id))).map((it) => String(it.id));
  const free = (items as any[]).filter((it) => !claims.owner.has(String(it.id)));
  if (!free.length) {
    return { ok: false, empty: true, error: `Every line of that estimate is already on ${joinNumbers(claimantNumbers(claims, skippedIds))} — nothing new to pull in.` };
  }

  const rows: ImportRow[] = free.map((it: any) => ({
    import_key: `quote:${it.id}`,
    description: it.description,
    quantity: Number(it.quantity),
    unit: it.unit,
    unit_price: Number(it.unit_price),
    source_ids: [String(it.id)],
  }));
  // What the invoice's estimate lines claim BEFORE the RPC, so the toast counts only what this tap
  // added (withClaimStats diffs it against the read-back after).
  const before = await landedSourceIds(supabase, invoiceId, "quote", rows);
  // The estimate lines already on this invoice, by id: only a line this tap ADDS is filed from the
  // book, so a line the office handed back with "Read It From The Line" stays as they left it.
  const standing = await estimateLineIds(supabase, ctx.orgId, invoiceId);
  const rep = await upsertImportedItems(supabase, invoiceId, "quote", rows);
  if (rep.error) return { ok: false, error: rep.error };
  await fileEstimateLinesFromBook(supabase, ctx.orgId, invoiceId, standing);
  if (importMovedMoney(rep.stats)) await stampInvoiceRevised(supabase, invoiceId, "importQuoteItemsIntoInvoice");
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  // Report what actually happened — counted from the lines that LANDED, not the offer. "3 added,
  // 2 updated, 5 of your edited lines left alone" is a different sentence from "Materials imported",
  // and it is the one that tells the office whether their negotiated prices survived.
  const after = await landedSourceIds(supabase, invoiceId, "quote", rows);
  return { ok: true, stats: sayRemoved(withClaimStats(rep.stats, rows, landedDiff(before, after), skippedIds, claims, "estimate lines"), rep.removed) };
}

/** The ids of the estimate lines on this invoice right now (null = the read failed). */
async function estimateLineIds(supabase: any, orgId: string | null, invoiceId: string): Promise<Set<string> | null> {
  if (!orgId) return null;
  const { data, error } = await supabase
    .from("invoice_items")
    .select("id")
    .eq("invoice_id", invoiceId)
    .eq("org_id", orgId)
    .eq("import_source", "quote");
  if (error) {
    reportError("estimateLineIds", error, { invoiceId });
    return null;
  }
  return new Set(((data ?? []) as { id: string }[]).map((r) => String(r.id)));
}

/**
 * THE ESTIMATE'S BOOK LINES, FILED (0342). From Estimate lands its lines through the import RPC,
 * which knows nothing of kinds; this reads what landed and gives each estimate line THIS IMPORT
 * ADDED (not in `standing`, the ids read before the RPC) that starts with one of the org's codes
 * the kind its book item says (createInvoiceFromQuote does the same as it inserts). A line that was
 * already on the invoice is never touched: its kind is whatever it landed with or a person set,
 * and a null there may be the office's own "Read It From The Line", which a re-import must not
 * undo. No `standing` (the read failed) files nothing: the lines then read by their words.
 * Classification only - no words, amount or order - so a failure costs the import nothing; it is
 * reported, and the line reads by its words as before.
 */
async function fileEstimateLinesFromBook(supabase: any, orgId: string | null, invoiceId: string, standing: Set<string> | null): Promise<void> {
  if (!orgId || !standing) return;
  const { data: lines, error } = await supabase
    .from("invoice_items")
    .select("id, description, unit, line_kind")
    .eq("invoice_id", invoiceId)
    .eq("org_id", orgId)
    .eq("import_source", "quote")
    .is("line_kind", null);
  if (error) {
    if (!isMissingColumn(error, "line_kind")) reportError("fileEstimateLinesFromBook.read", error, { invoiceId });
    return;
  }
  const added = ((lines ?? []) as { id: string; description: string | null; unit: string | null }[]).filter((ln) => !standing.has(String(ln.id)));
  if (!added.length) return;
  const book = await readPriceBookUnits(supabase, orgId);
  for (const ln of added) {
    const kind = kindFromPriceBook(ln, book);
    if (!kind) continue;
    const { data: done, error: upErr } = await supabase
      .from("invoice_items")
      .update({ line_kind: kind })
      .eq("id", ln.id)
      .eq("invoice_id", invoiceId)
      .eq("org_id", orgId)
      .is("line_kind", null)
      .select("id");
    if (upErr || !done?.length) reportError("fileEstimateLinesFromBook.write", upErr ?? new Error("zero rows"), { invoiceId, itemId: ln.id });
  }
}

/**
 * THE OFFICE SAYS WHAT A LINE IS (0342): the Kind chip on the line editor, and Nort.
 *
 * Labor, Materials or Other, on any line of any live invoice; `null` hands the line back to the
 * app's own reading (its import, then its words and unit). Classification only: the line's words,
 * amount, unit and order are untouched, so nothing the customer owes moves, no revision is stamped
 * and the importer still refreshes the line (mark_invoice_item_edited looks only at description /
 * quantity / unit_price / unit, so new hours still join a labor line). The draw's own credit and
 * milestone lines stay locked, as every line write does. The stored PDF is dropped, because the
 * customer's Cost Breakdown is printed from this.
 */
export async function setInvoiceItemKind(
  itemId: string,
  invoiceId: string,
  kind: PickableLineKind | null,
): Promise<Result & { message?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!ctx.orgId) return { ok: false, error: "No company on this account." };
  const next = kind === null ? null : pickableLineKind(kind);
  if (kind !== null && !next) return { ok: false, error: "A line is Labor, Materials or Other." };
  const block = await requireLiveInvoice(supabase, invoiceId);
  if (block) return block;
  if (await isProtectedCreditLine(supabase, itemId)) return CREDIT_LINE_LOCKED;
  const { data: touched, error } = await supabase
    .from("invoice_items")
    .update({ line_kind: next })
    .eq("id", itemId)
    .eq("invoice_id", invoiceId) // L3: the item must belong to THIS invoice
    .eq("org_id", ctx.orgId)
    .select("id");
  if (error) {
    if (isMissingColumn(error, "line_kind")) return { ok: false, error: "Line kinds aren't switched on yet. Try again after the next update." };
    return { ok: false, error: dbError(error) };
  }
  if (!touched?.length) return { ok: false, error: "That line isn't on this invoice." };
  await bustDocPdf("invoice", invoiceId);
  revalidateMoney(invoiceId);
  return { ok: true, message: next ? `Filed under ${LINE_KIND_LABEL[next]}` : "Back to reading it from the line" };
}

// ── H4: one billing path per job ────────────────────────────────────────────
// A job billed via progress draws (deposit/progress/final) must NOT also be billed
// on a standard invoice — that double-bills the work the draws already cover. The
// guard lives at every chokepoint that puts billable content on a standard invoice
// (import labor/materials/quote-items, manual line add, create-from-quote/blank), so
// no single door is left open. A draw invoice itself is never blocked: it IS the path.

/** The job's active draw (deposit/progress/final, non-void) if any — the signal that
 *  the job is on the draw path. Excludes `excludeInvoiceId` (the invoice being acted
 *  on, so a draw never blocks itself). Returns the row (id/status/invoice_number). */
async function activeDrawOnJob(supabase: any, jobId: string, excludeInvoiceId?: string): Promise<any | null> {
  let q = supabase
    .from("invoices")
    .select("id, status, invoice_number")
    .eq("job_id", jobId)
    .neq("status", "void")
    .in("invoice_kind", [...DRAW_KINDS])
    .limit(1);
  if (excludeInvoiceId) q = q.neq("id", excludeInvoiceId);
  const { data } = await q;
  return data && data.length ? data[0] : null;
}

/** The H4 block message, pointing at the correct next action: a DRAFT draw must be
 *  sent/deleted (a 2nd draft is itself blocked, so "add a draw" would be a dead-end);
 *  a sent draw means the user should add a draw rather than bill standard. */
function drawConflictError(draw: any): Result {
  if (draw && draw.status === "draft") {
    const label = draw.invoice_number ? `Draft ${draw.invoice_number}` : "A draft draw";
    return {
      ok: false,
      error: `${label} is still open on this job — send or delete that draw instead of billing on a standard invoice.`,
    };
  }
  return {
    ok: false,
    error: "This job is billed with progress draws — add a progress/final draw instead of billing on a standard invoice.",
  };
}

/** Guard the IMPORT / ADD-content paths: block when the target is a STANDARD invoice
 *  on a job that already has an active draw. Returns an error Result, else null. */
async function standardInvoiceOnDrawJob(supabase: any, inv: any, invoiceId: string): Promise<Result | null> {
  if ((inv?.invoice_kind ?? "standard") !== "standard") return null;
  const draw = await activeDrawOnJob(supabase, inv.job_id, invoiceId);
  return shouldBlockStandardImport(inv?.invoice_kind, !!draw) ? drawConflictError(draw) : null;
}

/** Guard standard-invoice CREATION for a job: block making a new standard invoice for
 *  a job already on the draw path (createInvoiceFromQuote embeds the full quoted amount
 *  at creation, so the content guards never see it). Returns an error Result, else null. */
async function blockStandardCreateOnDrawJob(supabase: any, jobId: string | null | undefined): Promise<Result | null> {
  if (!jobId) return null;
  const draw = await activeDrawOnJob(supabase, jobId);
  return draw ? drawConflictError(draw) : null;
}

/**
 * H4, THE DRAW SIDE, ON THE SERVER (J-011, 2026-09-24). "A draw invoice IS the billing path, so
 * it's never blocked" was true while the invoice page hid its Import row on every draw — the only
 * thing standing between a 50%-of-the-estimate draw and the job's hours being itemized on top of
 * it was a hidden button. Now that a draw built from actuals takes new work like any invoice
 * (lib/actuals-draw), the line is drawn HERE, where every importer passes: a draw that bills a
 * slice of the contract (a %, a fixed $, a deposit, a milestone, anything on a scheduled job)
 * refuses labor, materials and change orders, and an actuals draw takes them. Standard invoices
 * pass untouched (their H4 guard is standardInvoiceOnDrawJob).
 *
 * `trustedActuals` is for the two callers that KNOW the draw is built from actuals before its lines
 * say so: createProgressReportInvoice filling the draw it just minted (no lines yet), and
 * reimportFromScratch after it has checked the draw and cleared a source. Never a parameter of an
 * exported action — a client can't pass it.
 */
async function contractDrawGuard(
  supabase: any,
  inv: { id: string; job_id: string; invoice_kind?: string | null; invoice_number?: string | null },
  what: string,
  trustedActuals = false,
): Promise<Result | null> {
  if (trustedActuals || !isDrawKind(inv.invoice_kind)) return null;
  try {
    const shape = await readDraftShape(supabase, { id: inv.id, jobId: inv.job_id, kind: inv.invoice_kind ?? null });
    if (!isActualsDraw(shape)) return { ok: false, error: contractDrawRefusal(inv.invoice_number, what) };
    // AN ACTUALS DRAW DOESN'T TAKE WORK A LATER DEPOSIT WAS MEANT TO COVER (review, 2026-09-24).
    // Netting happens once, when a progress report is made (createProgressReportInvoice →
    // resolveDrawCredit → one draw_credit line). A fixed-$ or %-of-estimate draw sent AFTER this
    // report is netted by the NEXT report - so itemising new hours onto this older one at full rate
    // leaves that lump un-netted, and the customer pays for the same work twice. So: when the job
    // carries lump money no bill has taken off (this draw's own credit counts - it is excluded from
    // the read and added back, because a draft's credit isn't counted by the fetcher), the new work
    // goes on the next progress report, which nets it.
    const [lump, own] = await Promise.all([
      fixedBillingsNotYetNetted(supabase, inv.job_id, inv.id),
      supabase.from("invoice_items").select("line_total").eq("invoice_id", inv.id).eq("import_source", "draw_credit"),
    ]);
    if (own.error) throw own.error;
    const ownCredit = ((own.data ?? []) as { line_total: unknown }[]).reduce((t, r) => t + Math.abs(Number(r.line_total) || 0), 0);
    const open = Math.round((lump - ownCredit) * 100) / 100;
    if (open > 0.005) {
      const doc = inv.invoice_number || "This progress payment";
      return {
        ok: false,
        error: `${doc} can't take ${what}: ${formatCurrency(open)} of deposit or set-amount billing on this job hasn't been taken off a bill yet, and adding the work here would bill it on top of that. Bill it on the next progress payment instead - that one takes the ${formatCurrency(open)} off.`,
      };
    }
    return null;
  } catch (e) {
    // A lost read is not permission: refuse, say so, nothing written.
    reportError("importGuard.drawShape", e, { invoiceId: inv.id });
    return { ok: false, error: "Couldn't check this draw just now, so nothing was imported - try again in a moment." };
  }
}

// ── The invariant lives on the ROW now (0255) ───────────────────────────────────────────────
// cn-v479's GAP B guard (billedOnAnotherStandardInvoice) refused to import labor / materials /
// change orders / estimate lines onto a second standard invoice for the job — "already billed on
// INV-061. Edit that invoice, or bill extra work as a progress payment." It was the only way to
// stop the Tao chandelier double while a labor line could not say WHICH hours it held, and it
// made billing anything NEW after the first invoice went out impossible: Erik, 85 Whitney,
// 2026-09-11 — three refusal sentences pointing at each other, none naming a door that worked.
// Each importer now reads the job's claims (claimedSourcesOnJob), skips the rows another non-void
// invoice holds, writes its own claims (invoice_items.source_ids + import_key), and reports
// "N pulled in · M already on INV-0xx skipped" instead of refusing. Draws claim too: a delta draw
// and a standard invoice are the same kind of claimant, so they can follow each other on one job
// without a row ever being billed twice. The claim dies with the line — delete it, void the
// invoice, or start the import over (0204) and the rows are free again.

/**
 * START ONE IMPORT SOURCE OVER (0204) — the release for 0175's three protections.
 *
 * Erik: "i tried to reimport the timcard entries so i could get the order right … but its not
 * working." Every guard was doing its job: the crew member's line he deleted was TOMBSTONED so
 * no import would resurrect it, and the lines that survived were `edited`, which an import must
 * never overwrite. So the import ran, changed nothing, and said so in numbers nobody reads as a
 * refusal. Deleting a line to re-import it in a different order is an ordinary thing to want;
 * without this there was no way back at all.
 *
 * Draft-only and staff-only (the RPC re-checks both), scoped to ONE source, and it drops the
 * lines as the IMPORTER so they aren't tombstoned again on the way out. The caller then runs
 * the importer, which rebuilds the source from scratch, in source order.
 */
export async function reimportFromScratch(
  invoiceId: string,
  source: "labor" | "costs" | "quote" | "change_orders",
  /** The % showing in the card's markup box. "Start it over" sits directly under "Materials
   *  From Costs" and must price identically (audit v800 verification): without this the two
   *  buttons in one card produced different money — the box's number for one, the customer's
   *  resolved default for the other — and neither the confirm nor the toast names a percent. */
  markupPercent?: number,
): Promise<ImportResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  /**
   * THE ONE DOOR 0269 COULD NOT OPEN FROM HERE, SAID IN PLAIN WORDS.
   *
   * reset_import_source is a SECURITY DEFINER function with its own draft gate baked in
   * (migrations 0204 / 0212 / 0223: `if v_status <> 'draft' then raise exception 'This invoice
   * has been sent — only a draft can be re-imported.'`). That is a DB ceiling, and a ceiling is
   * the right kind of thing to have — but it now disagrees with the app above it, and the way it
   * disagrees is the worst kind: a raised Postgres exception arriving at the office as a
   * refusal in a voice nothing else in the app uses, about a rule the rest of the page no longer
   * has. Relaxing it needs a migration, which belongs to whoever owns migrations.
   *
   * Until then this says so itself, and names the way through that DOES work now: the lines are
   * editable, so removing the ones that are wrong and importing again reaches the same place.
   */
  const { data: statusRow } = await supabase
    .from("invoices")
    .select("status, job_id, invoice_kind, invoice_number")
    .eq("id", invoiceId)
    .maybeSingle();
  const st = String((statusRow as { status?: string } | null)?.status ?? "");
  if (statusRow && st !== "draft") {
    return {
      ok: false,
      error:
        st === "void"
          ? invoiceLineEditRefusal("void")!
          : "Starting an import over is still only possible on a draft. On a bill that's gone out, delete the lines you want rebuilt and import that source again - it pulls back in whatever nobody has billed.",
    };
  }
  // A DRAW IS CHECKED BEFORE ANYTHING IS CLEARED. Resetting a source first would empty an actuals
  // draw of the very lines that say it is one, and the rebuild would then be refused; resetting a
  // contract draw's (nonexistent) labor and then refusing would be a write for nothing. So the
  // question is asked of the draw as it stands, and an actuals draw rebuilds on that answer.
  const row = statusRow as { job_id?: string | null; invoice_kind?: string | null; invoice_number?: string | null } | null;
  const draw = isDrawKind(row?.invoice_kind);
  if (draw && source === "quote") {
    return { ok: false, error: "A progress payment doesn't take the estimate's lines - it bills a part of the contract, or the hours and receipts." };
  }
  if (draw && row?.job_id) {
    const refused = await contractDrawGuard(
      supabase,
      { id: invoiceId, job_id: row.job_id, invoice_kind: row.invoice_kind, invoice_number: row.invoice_number },
      source === "labor" ? "the job's hours" : source === "costs" ? "the job's bills" : "change orders",
    );
    if (refused) return refused;
  }
  const { error } = await supabase.rpc("reset_import_source", { p_invoice_id: invoiceId, p_source: source });
  if (error) return { ok: false, error: dbError(error) };
  const run =
    source === "labor"
      ? importLaborCore(invoiceId, draw)
      : source === "costs"
        ? importCostsCore(invoiceId, markupPercent, draw)
        : source === "change_orders"
          ? importChangeOrdersCore(invoiceId, draw)
          : importQuoteItemsIntoInvoice(invoiceId);
  return run;
}

export async function importLaborIntoInvoice(invoiceId: string): Promise<ImportResult> {
  return importLaborCore(invoiceId, false);
}

/** The labor import. `trustedActuals` — see contractDrawGuard; only internal callers set it. */
async function importLaborCore(invoiceId: string, trustedActuals: boolean): Promise<ImportResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, job_id, invoice_kind, invoice_number")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv?.job_id) return { ok: false, error: "This invoice isn't linked to a job." };
  const conflict = await standardInvoiceOnDrawJob(supabase, inv, invoiceId);
  if (conflict) return conflict;
  const contract = await contractDrawGuard(supabase, inv, "the job's hours", trustedActuals);
  if (contract) return contract;
  // THE DOUBLE-CHARGE THIS USED TO GUARD IS GUARDED SOMEWHERE BETTER NOW (0269 reading 0255).
  //
  // The draft lock here was cn-v479's answer to Tao J-002: labor and materials piled onto an
  // already-partial deposit invoice AFTER a progress draw had billed the same actuals. But a
  // status was only ever a proxy for the real question — is this hour already on a bill? — and
  // since 0255/0258/0260 the LINE answers it: every imported line carries the source ids it
  // bills, one non-void invoice in the org may hold a given id, and the DB trigger enforces it
  // under concurrency. Importing onto a sent invoice now pulls in exactly the work nobody has
  // billed, which is the same arithmetic it does on a draft. Void is the only status refused.
  const block = await requireLiveInvoice(supabase, invoiceId);
  if (block) return block;

  // Bill the EXACT time on this job via the shared labor-billing helper (so the billed lines
  // reconcile to the penny with the "work to date" every panel shows) — MINUS every entry
  // another non-void invoice on the job already CLAIMS (0255). Re-importing into THIS
  // draft excludes only OTHER invoices' claims, so a refresh still works exactly as 0175 promised.
  const [labor, { data: org }, levelRate] = await Promise.all([
    fetchJobLaborRows(supabase, inv.job_id),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    customerLaborRateForJob(supabase, inv.job_id),
  ]);
  // Claims AFTER the rows, never beside them: the read looks every candidate up BY ID as well as by
  // job, so an entry billed on another job and moved here since is still seen as claimed.
  const claims = await claimedSourcesOnJob(supabase, inv.job_id, invoiceId, laborRowIds(labor));
  // Migration 0255 hasn't landed yet: labor claims are unknowable, so for these few minutes the
  // old rule has to hold — never bill a second invoice's labor blind (one sentence with costs).
  if (!claims.schemaReady && claims.invoices.length) return midUpgradeRefusal(claims);
  const defaultRate = getOrgSettings((org as any)?.settings).default_labor_rate; // via the settings SSOT
  // A split is a cut into ordinary entries (0288), and a piece that carries billed hours carries
  // the claim by its own id, so the free rows are simply the entries no other invoice holds.
  const free = withoutClaimedLabor(labor.jobEntries, new Set(claims.owner.keys()));
  const { lines } = computeJobLaborBilling(free.jobEntries, defaultRate, levelRate, labor.nonBillableCodes);
  if (lines.length === 0) {
    // Nothing free to bill — and the reason is the difference between "no hours yet" and "every
    // hour is already on INV-061". Only the second one should send the office looking elsewhere.
    return free.skippedIds.length
      ? { ok: false, empty: true, error: `Every hour on this job is already on ${joinNumbers(claimantNumbers(claims, free.skippedIds))} — nothing new to bill.` }
      : { ok: false, error: "No billable hours on this job yet.", empty: true };
  }

  // NEW HOURS JOIN THE PERSON'S LINE (lib/labor-offer, Erik's INV-078 rule). This invoice's own
  // labor lines and the keys the office deleted decide, per person: a new line, a refresh, or the
  // new hours joined onto the edited line at its rate. A lost read here is not "no lines": refuse,
  // nothing written.
  const [ownRead, keysRead] = await Promise.all([
    supabase.from("invoice_items").select("id, source_ids, import_key, edited, quantity, unit_price, unit, description").eq("invoice_id", invoiceId).eq("import_source", "labor"),
    supabase.from("invoices").select("dismissed_import_keys").eq("id", invoiceId).maybeSingle(),
  ]);
  if (ownRead.error || keysRead.error) {
    reportError("importLabor.ownLines", ownRead.error ?? keysRead.error, { invoiceId });
    return { ok: false, error: "Couldn't read this invoice's labor lines just now, so nothing was imported - try again in a moment." };
  }
  const ownLines = (ownRead.data ?? []) as OwnLaborLine[];
  // A line ON the invoice is never judged by a tombstone of its own key: upsertImportedItems clears
  // that stale key before the RPC runs, so the planner doesn't read the person as deleted either.
  const presentKeys = new Set(ownLines.map((l) => String(l.import_key ?? "")).filter(Boolean));
  const plan = planLaborOffer({
    entries: free.jobEntries,
    heldEntries: labor.jobEntries,
    ownLines,
    dismissed: new Set(
      ((keysRead.data as { dismissed_import_keys?: string[] | null } | null)?.dismissed_import_keys ?? []).map(String).filter((k) => !presentKeys.has(k)),
    ),
    bill: (entries) => computeJobLaborBilling(entries, defaultRate, levelRate, labor.nonBillableCodes).lines,
  });
  const invLabel = (inv as { invoice_number?: string | null }).invoice_number ?? "this invoice";

  const rows: ImportRow[] = plan.offer.map(({ importKey, line: l }) => ({
    // Keyed by PERSON: the importer aggregates a job's time per head, so "Erik" is one line whose
    // hours grow. Re-importing refreshes it; once the office has edited it (a negotiated rate), the
    // RPC leaves it alone and the new hours JOIN it below, at its rate (labor-offer).
    import_key: importKey,
    /**
     * THE LINE THE CUSTOMER READS SAYS WHO, AND THE NUMBERS SAY THE REST.
     *
     * This used to append the rate's provenance — "(Jimmy Santoliva's bill rate)" — because Erik
     * once stared at an import saying "still importing at 150" and nothing told him the number
     * was his tech's own bill_rate doing its job. That was a real confusion and the note answered
     * it, but it answered it IN THE WRONG PLACE: `description` is the line text on the invoice the
     * CUSTOMER receives, so an internal explanation was being mailed out, with the man's full name
     * repeated inside its own line. Erik, reading one: "Labor - Jimmy (the rest is repetitive and
     * unnecessary) Labor - Erik (nothing more needed)."
     *
     * The provenance is not lost, it is just not on the customer's paper: every line already shows
     * its own rate beside the hours ("25.5 hr · $50.00"), and the invoice editor now names where
     * that rate came from for the office only (invoice-detail.tsx). A hyphen, not an em-dash — this
     * string is user-facing copy and it prints.
     */
    description: `Labor - ${l.name}`,
    quantity: l.quantity,
    unit: "hr",
    unit_price: l.rate,
    // THE CLAIM: the entry ids behind this line ride with it and die with it. An edited line keeps
    // the claims it holds through the RPC; the ones it takes on are added by the join below.
    source_ids: l.sourceIds,
  }));
  // What the invoice's labor lines claim BEFORE the RPC, so the toast counts only the entries this
  // tap added — a re-import that refreshed Erik's line with the same nine entries pulled in none.
  const before = await landedSourceIds(supabase, invoiceId, "labor", rows);
  const rep = await upsertImportedItems(supabase, invoiceId, "labor", rows);
  if (rep.error) return { ok: false, error: rep.error };

  const join = await joinLaborHours(supabase, invoiceId, plan.joins);

  if (importMovedMoney(rep.stats) || join.joined.length) await stampInvoiceRevised(supabase, invoiceId, "importLaborIntoInvoice");
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  // Report what actually happened, in time entries, counted from the lines that LANDED: "5 time
  // entries pulled in · 9 already on INV-061 skipped" tells the office what this invoice carries and
  // what it deliberately left where it was — a different sentence from "Labor imported".
  const after = await landedSourceIds(supabase, invoiceId, "labor", rows);
  const stats = withClaimStats(rep.stats, rows, landedDiff(before, after), free.skippedIds, claims, "time entries");
  const said = join.joined.map(joinedSentence);
  if (said.length) {
    // A join is an update to a line: counted as one, so the invoice page never reads a run that
    // added hours as "stuck" and offers Start It Over over it.
    stats.updated += said.length;
    stats.summary = [...said, stats.summary].filter(Boolean).join(" · ");
    stats.notes = [...(stats.notes ?? []), ...said];
  }
  // An old ":2" line whose hours merged into its person's line is said as a merge, not as a line
  // "the job no longer bills".
  const joinedPeople = new Set(join.joined.map((j) => j.personId));
  const merged = (rep.removed ?? []).filter((r) => {
    const m = /^labor:([^:]+):\d+$/.exec(r.importKey);
    return !!m && joinedPeople.has(m[1]);
  });
  const warnings: string[] = [];
  if (merged.length) {
    warnings.push(`Merged ${merged.length === 1 ? `a second ${merged[0].description} line` : `${merged.length} second labor lines`} into the person's own labor line - one line per person`);
  }
  const plainRemoved = removedSentence((rep.removed ?? []).filter((r) => !merged.includes(r)));
  if (plainRemoved) warnings.push(plainRemoved);
  warnings.push(...join.failed);
  warnings.push(...plan.leftOff.map((l) => leftOffSentence(l, invLabel)));
  // NEVER THEIR PAY RATE, AND NEVER SILENTLY (audit v994 PL2): anyone priced at the level or
  // default rate because they have no bill rate is named, with the rate used and where to set theirs.
  // A person whose hours join an edited line bills at that line's rate, so isn't named for it.
  const joinedKeys = new Set(plan.joins.map((j) => j.importKey));
  warnings.push(...noBillRateWarnings(plan.offer.filter((o) => !joinedKeys.has(o.importKey)).map((o) => o.line)));
  if (warnings.length) stats.warnings = [...(stats.warnings ?? []), ...warnings];
  return { ok: true, stats };
}

/**
 * THE JOIN: quantity += the new hours, source_ids += the new entries; rate and `edited` untouched.
 *
 * Run AFTER the RPC, so an old unedited overflow line (":2") it just removed has let go of its
 * entries before they join the home line. Guarded on the quantity the plan read - a person changing
 * the line in the same second makes this land on zero rows, and that is SAID, never added on top of
 * a number nobody read - and checked (silent-write law). The claim trigger (0258/0259/0260) still
 * judges every id added here: an hour another invoice took in the meantime refuses the write in its
 * own words ("hours already billed on INV-0xx").
 */
async function joinLaborHours(
  supabase: Awaited<ReturnType<typeof createClient>>,
  invoiceId: string,
  joins: readonly LaborJoin[],
): Promise<{ joined: LaborJoin[]; failed: string[] }> {
  const out: { joined: LaborJoin[]; failed: string[] } = { joined: [], failed: [] };
  for (const j of joins) {
    const quantity = Math.round((j.fromQuantity + j.addHours) * 100) / 100;
    const source_ids = [...new Set([...j.heldIds, ...j.addIds])];
    const { data: wrote, error } = await supabase
      .from("invoice_items")
      .update({ quantity, source_ids })
      .eq("id", j.lineId)
      .eq("invoice_id", invoiceId)
      .eq("edited", true)
      .eq("quantity", j.fromQuantity)
      .select("id");
    if (error || !wrote?.length) {
      reportError("importLabor.join", error ?? "zero rows", { invoiceId, lineId: j.lineId });
      out.failed.push(
        error
          ? `${j.name}'s ${hoursWords(j.addHours)} couldn't join ${j.description}: ${dbError(error)}`
          : `${j.name}'s ${hoursWords(j.addHours)} didn't join ${j.description} - the line changed while this ran. Import Labor again`,
      );
      continue;
    }
    out.joined.push(j);
  }
  return out;
}

/**
 * AN APPROVED CHANGE ORDER BECOMES MONEY (audit v800 wave B).
 *
 * `change_orders` has a `co_number`, a `description`, an `amount` and an approve/reject control.
 * The amount was read by NOTHING. Not by any invoice, not by the contract total, not by job
 * profitability, not by analytics — verified by grepping every reader in the codebase. You could
 * raise a change order, print it, walk it to the customer, have them approve it, mark it
 * approved, and the money simply never existed anywhere in the app. On a deck build that is not
 * an edge case; change orders are how the job actually gets priced.
 *
 * THROUGH THE ONE BILLING PATH, not beside it. This is an importer with the same shape as labour
 * and costs — same draft lock, same draw-job conflict check, same idempotent upsert, same
 * `edited` protection — because a second way to put a line on an invoice is how Tao Zhu got
 * charged twice. Nothing here writes an invoice total; recalcInvoice does, as it does for
 * everything else.
 *
 * ONE LINE PER CHANGE ORDER, keyed `co:<id>`. Re-importing after the office revises an amount
 * updates that line rather than appending a second one, and a change order approved later
 * appends without disturbing what is already there. A line the office has since negotiated by
 * hand is `edited` and the importer leaves it alone — same contract as every other import.
 *
 * APPROVED ONLY. A pending change order is a proposal and a rejected one is a decision; billing
 * either would be inventing an agreement. This is also why nothing needs a "billed" flag on the
 * change order itself: the invoice line IS the record, and the double-bill guard below is what
 * stops the same approval landing on two standard invoices.
 */
export async function importChangeOrdersIntoInvoice(invoiceId: string): Promise<ImportResult> {
  return importChangeOrdersCore(invoiceId, false);
}

async function importChangeOrdersCore(invoiceId: string, trustedActuals: boolean): Promise<ImportResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, job_id, invoice_kind, invoice_number")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv?.job_id) return { ok: false, error: "This invoice isn't linked to a job." };
  const conflict = await standardInvoiceOnDrawJob(supabase, inv, invoiceId);
  if (conflict) return conflict;
  // An approved extra rides on an actuals draw like any invoice; a contract draw is a slice of the
  // price, and the change order is not part of that slice.
  const contract = await contractDrawGuard(supabase, inv, "change orders", trustedActuals);
  if (contract) return contract;
  const block = await requireLiveInvoice(supabase, invoiceId);
  if (block) return block; // 0269: void only. The claim on each change order is what stops a double

  const { data: cos, error: readErr } = await supabase
    .from("change_orders")
    .select("id, co_number, description, amount")
    .eq("job_id", inv.job_id)
    .eq("status", "approved")
    .order("created_at", { ascending: true });
  // A FAILED READ IS NOT AN EMPTY LIST (the recalcQuote lesson). supabase-js returns data:null on
  // error, and treating that as "no change orders" would tell the office there is nothing to bill
  // on a job that has thousands of dollars of approved extras.
  if (readErr) return { ok: false, error: dbError(readErr) };
  // Claims AFTER the read: looked up by id as well as by job (claimedSourcesOnJob).
  const claims = await claimedSourcesOnJob(supabase, inv.job_id, invoiceId, ((cos ?? []) as ChangeOrderRow[]).map((c) => String(c.id)));
  // The two decisions worth pinning — which ones count as money, and what the customer reads —
  // live in lib/change-order-billing where they are unit-tested. A credit (negative amount) is a
  // real change order and passes straight through; only $0 is dropped.
  const rows = (cos ?? []) as ChangeOrderRow[];
  // A change order already on another non-void invoice of this job stays there (0255) — its claim
  // is the record that it was billed, which is why the change order itself needs no "billed" flag.
  const skippedIds = rows.filter((c) => claims.owner.has(String(c.id))).map((c) => String(c.id));
  const free = rows.filter((c) => !claims.owner.has(String(c.id)));
  const lines = changeOrderLines(free);
  if (!lines.length) {
    return skippedIds.length
      ? { ok: false, empty: true, error: `Every approved change order on this job is already on ${joinNumbers(claimantNumbers(claims, skippedIds))} — nothing new to pull in.` }
      : { ok: false, error: noChangeOrdersReason(rows), empty: true };
  }

  const offer: ImportRow[] = lines.map((l) => ({ ...l, source_ids: [l.import_key.replace(/^co:/, "")] }));
  // Claims before the RPC, so the toast counts only the change orders this tap added.
  const before = await landedSourceIds(supabase, invoiceId, "change_orders", offer);
  const rep = await upsertImportedItems(supabase, invoiceId, "change_orders", offer);
  if (rep.error) return { ok: false, error: rep.error };
  if (importMovedMoney(rep.stats)) await stampInvoiceRevised(supabase, invoiceId, "importChangeOrdersIntoInvoice");
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  revalidatePath("/change-orders");
  const after = await landedSourceIds(supabase, invoiceId, "change_orders", offer);
  return { ok: true, stats: sayRemoved(withClaimStats(rep.stats, offer, landedDiff(before, after), skippedIds, claims, "change orders"), rep.removed) };
}

/** Import materials from the job's costs: purchase orders + supplier bills,
 *  marked up by `markupPercent` (so they bill at sell price, not cost — the
 *  contractor doesn't do the math by hand). Each line stays editable after. */
/** `markupPercent` is OPTIONAL, not defaulted to zero (audit v800). The old `= 0` default meant
 *  a caller that forgot it billed the customer at raw COST — and `reimportFromScratch`, the
 *  amber "Start it over" button that is the ONLY way forward on any invoice built before 0175,
 *  forgot it. When it is absent we resolve the customer's real markup here, so the mistake is
 *  no longer reachable from any call site, present or future. */
export async function importCostsIntoInvoice(
  invoiceId: string,
  markupPercent?: number,
  opts?: { keepInvoiceMarkup?: boolean },
): Promise<ImportResult> {
  return importCostsCore(invoiceId, markupPercent, false, opts?.keepInvoiceMarkup === true);
}

/**
 * The materials import. `trustedActuals` — see contractDrawGuard; only internal callers set it.
 * `keepInvoiceMarkup` is for the doors that bring an EXISTING draft up to date ("Add to INV-078",
 * Request Next Payment, New Invoice landing on a draft): the markup the invoice's own untouched
 * lines are priced at wins over `markupPercent` (lib/invoice-markup), so a % the office typed on
 * the invoice is not quietly put back to the customer's default by the next refresh. On the invoice
 * itself, Materials from Costs sets it too unless a number was typed in the % box: only a typed
 * number is the office choosing the markup (lib/invoice-markup materialsImportPlan).
 */
async function importCostsCore(
  invoiceId: string,
  markupPercent: number | undefined,
  trustedActuals: boolean,
  keepInvoiceMarkup = false,
): Promise<ImportResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, job_id, invoice_kind, invoice_number")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv?.job_id) return { ok: false, error: "This invoice isn't linked to a job." };
  // Resolve the markup when the caller did not state one — same resolver the manual import box
  // and the progress-draw path use, so every door prices a level customer's materials alike.
  let markup = markupPercent;
  if (markup === undefined) {
    const { data: orgRow } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
    markup = await customerMaterialMarkupForJob(
      supabase,
      inv.job_id,
      getOrgSettings((orgRow as { settings?: unknown } | null)?.settings).material_markup_percent,
    );
  }
  const conflict = await standardInvoiceOnDrawJob(supabase, inv, invoiceId);
  if (conflict) return conflict;
  const contract = await contractDrawGuard(supabase, inv, "the job's bills", trustedActuals);
  if (contract) return contract;
  const block = await requireLiveInvoice(supabase, invoiceId);
  if (block) return block; // 0269: void only (see importLaborIntoInvoice — the claims are the guard)

  // Bills and orders another non-void invoice on this job already claims stay there (0255): the
  // loops below skip them and the stats say so. This replaces cn-v479's refusal ("materials are
  // already billed on INV-061"), which made a second invoice impossible once the first went out.
  const [{ data: pos }, { data: bills }] = await Promise.all([
    supabase.from("purchase_orders").select("id, po_number, vendor, total, status").eq("job_id", inv.job_id),
    // A SET-ASIDE DUPLICATE IS NOT A COST, AND THIS WAS THE ONE READ THAT STILL BILLED IT
    // (two independent reviewers, 2026-09-19). 0271's `superseded_by_bill_id` is filtered by
    // /analytics, job-financials, unbilled-work and job-profitability - and was missed here, on
    // the read that decides what a CUSTOMER pays. Erik taps the duplicate picker before the job
    // is invoiced (sort the shoebox, then bill), so no 0255 claim exists to stop it, and the copy
    // he just set aside is itemised onto the invoice beside the one he kept. $95.27 of CED is in
    // exactly that state on 13631 Northwoods today.
    supabase
      .from("bills")
      // `pricing_provisional` (0271) rides in the same projection as `superseded_by_bill_id`, for
      // the same reason: both are facts about whether this receipt is a real cost, and this is the
      // read that decides what a CUSTOMER pays. THE PROJECTION LAW - the column existed, the
      // receipt reader set it, the price book already honoured it, and the one door where the
      // money reaches a homeowner never asked. See the flag below.
      // `created_at` is the order supplier returns spend the purchase they reverse (DB3).
      .select("id, supplier, bill_number, amount, po_id, pricing_provisional, created_at")
      .eq("job_id", inv.job_id)
      .is("superseded_by_bill_id", null),
  ]);
  const billIds = ((bills ?? []) as any[]).map((b) => String(b.id));
  // THE PIECES TAKEN FROM STOCK onto this job (Shop Stock, Phase 3): every live take, its pieces
  // net of any carried back, and the shorts no roll has settled yet. Read BEFORE the claims so
  // their move ids are looked up by id like the bills. Pinned to the office's own org as well as
  // RLS. A lost read is not "no pieces": nothing is imported and it says so.
  let stock: { takes: StockTake[]; shorts: StockShort[] };
  try {
    stock = await readJobStock(supabase, inv.job_id, ctx.orgId ? { orgId: ctx.orgId } : undefined);
  } catch (e) {
    reportError("importCosts.stock", e, { invoiceId });
    return { ok: false, error: "Couldn't read the pieces taken from stock for this job just now, so nothing was imported - try again in a moment." };
  }
  // Claims AFTER the rows, never beside them: the read looks every bill and order up BY ID as well
  // as by job, so one billed before it was moved to this job is still seen as claimed. The itemized
  // lines behind each bill ride along (the receipt-reader stores every receipt line): a bill WITH
  // lines goes onto the invoice item-by-item — real descriptions, quantities, per-item prices —
  // instead of one opaque "vendor · 1 lot" lump (Erik, 7/24). A bill without lines (hand-entered)
  // still imports as its lump.
  const [claims, blis] = await Promise.all([
    claimedSourcesOnJob(supabase, inv.job_id, invoiceId, [
      ...((pos ?? []) as any[]).map((p) => String(p.id)),
      ...billIds,
      ...stock.takes.flatMap((t) => t.moveIds),
    ]),
    readBillLines(supabase, billIds),
  ]);
  if (blis.error) return { ok: false, error: blis.error };
  // THE INVOICE'S OWN MARKUP, READ BACK FROM ITS LINES (see keepInvoiceMarkup above). A lost read
  // is not "no lines": refuse, nothing written - repricing on a guess is the bug this closes. The
  // read is lib/invoice-markup-read's, the same one the invoice page seeds its % box from, handed
  // the bills, orders and receipt lines this run is about to price.
  let keptMarkup: number | null = null;
  if (keepInvoiceMarkup) {
    const own = await readInvoiceMarkup(supabase, invoiceId, inv.job_id, {
      bills: ((bills ?? []) as any[]).map((b) => ({ id: String(b.id), amount: b.amount })),
      pos: ((pos ?? []) as any[]).map((p) => ({ id: String(p.id), total: p.total })),
      linesByBill: linesByBillId(blis.lines),
      // Stock lines vote on the invoice's markup too, off the same takes this run prices.
      takes: stock.takes,
    });
    if (!own.ok) return { ok: false, error: own.error };
    const found = own.reading.kind === "one" ? own.reading.pct : null;
    if (found !== null && Math.abs(found - (Number(markup) || 0)) > 0.05) {
      keptMarkup = found;
      markup = found;
    }
  }
  // THE DEPLOY WINDOW (0255 not applied): a claim written by id — every labor line, and every cost
  // line since 0255 — is unreadable, so a bill another invoice holds could be billed again here.
  // The same refusal labor gives, for the same few minutes; keys alone are not a boundary.
  if (!claims.schemaReady && claims.invoices.length) return midUpgradeRefusal(claims);
  const skippedIds: string[] = [];
  /** Bills whose PO is already billed elsewhere: the delivery was charged through the order. */
  const poCovered: { billId: string; poId: string }[] = [];
  /** Bills whose every line is marked not billable (0268): a real receipt, nothing on it to bill. */
  const nothingBillable: string[] = [];
  /**
   * A COUNTER PREVIEW IS NOT HIS PRICE, AND IT WENT OUT TO A CUSTOMER ANYWAY (0271, cn-v967).
   *
   * CED's Sunnyvale branch is not Erik's priced account. It masks the contract price with a run of
   * asterisks and prints its own retail counter price beside it, and the receipt reader records
   * those retail figures while correctly flagging the receipt `pricing_provisional`. 0271 taught
   * the price book to ignore those rows. Nothing taught THIS loop, so the $467.87 Sunnyvale ticket
   * on Jason Waldow's job was marked up and itemised onto his invoice at the counter's numbers, and
   * no screen ever said the prices were unconfirmed. When the real Truckee-priced invoice arrives
   * there is no mechanism to true up a bill that has already gone out.
   *
   * This SUGGESTS rather than blocks: billing the preview and truing up later is a legitimate call,
   * and it is Erik's to make. What is not negotiable is making it without being told. So the flag
   * rides out on the same toast the office already reads before it sends.
   */
  const provisional: string[] = [];
  /** Supplier returns (a bill below zero) this run credits, and the ones with nothing on them that
   *  was ever the customer's - both said in the summary. */
  const returnsNotCredited: (ReturnOutcome & { billId: string })[] = [];
  /** Returns with credit rows, decided below against what the invoice bills (returnsThatFit). */
  const returnsOffered: (ReturnOutcome & { billId: string; rows: ImportRow[]; provisional: boolean })[] = [];
  const linesByBill = new Map<string, any[]>();
  for (const l of blis.lines) {
    if (!linesByBill.has(l.bill_id)) linesByBill.set(l.bill_id, []);
    linesByBill.get(l.bill_id)!.push(l);
  }
  // Each return's lines, held to what the customer was billed for the purchase it reverses - a
  // box billed in part credits that part, a purchase switched off credits nothing. The Unbilled
  // card and the work-to-date panel call the same function over the same bills.
  //
  // A RETURN ALREADY CREDITED SPENDS THE PURCHASE FIRST (audit v994, DB3). Without the claim set
  // the budget went in uuid order, so a later return could take the purchase an earlier credited
  // one had already used up, and be credited again on top of it. "Already credited" is every
  // other non-void invoice (claims.owner) AND this one: a draft that already carries a return is
  // re-imported against the budget it spent, exactly as the Unbilled card (which excludes no
  // invoice) sees it, so the two agree on which return got which cents.
  const creditedReturns = new Set<string>(claims.owner.keys());
  if (((bills ?? []) as any[]).some((b) => isReturnBill(b.amount))) {
    const { data: held, error: heldErr } = await supabase
      .from("invoice_items")
      .select("source_ids")
      .eq("invoice_id", invoiceId)
      .eq("import_source", "costs");
    if (heldErr) {
      reportError("importCosts.returnsHeldHere", heldErr, { invoiceId });
      return { ok: false, error: "Couldn't read this invoice's materials lines just now, so nothing was imported - try again in a moment." };
    }
    for (const it of (held ?? []) as { source_ids?: unknown[] | null }[]) for (const s of it.source_ids ?? []) creditedReturns.add(String(s));
  }
  const returnLines = returnLinesAgainstPurchases((bills ?? []) as any[], (b) => linesByBill.get(b.id) ?? [], creditedReturns);

  // Mark up cost → sell price. Markup is NOT shown on the line (customers don't
  // see your margin); only the price reflects it.
  const mark = (cost: number) => Math.round(cost * (1 + (Number(markup) || 0) / 100) * 100) / 100;
  const rows: ImportRow[] = [];
  // Bill only LIVE purchase orders (the one shared rule): a draft/cancelled order was
  // never a real cost, and a PO whose supplier bill has arrived is superseded by that
  // bill — otherwise one CED delivery goes out on the invoice as two material charges.
  for (const p of livePurchaseOrders((pos ?? []) as any[], (bills ?? []) as any[])) {
    if (!(Number(p.total) > 0)) continue;
    if (claims.owner.has(String(p.id))) {
      skippedIds.push(String(p.id));
      continue;
    }
    rows.push({ import_key: `po:${p.id}`, description: `Materials — ${p.vendor} (PO ${p.po_number})`, quantity: 1, unit: "lot", unit_price: mark(Number(p.total)), source_ids: [String(p.id)] });
  }
  // ── THE ANCHOR INVARIANT (adversarial-review fix, 7/24) ──────────────────────────────
  // Each bill's itemized rows must sum to EXACTLY mark(bill.amount) — the same figure the
  // lump path bills, computeJobProgress reports, and livePurchaseOrders' PO-supersede math
  // subtracts. Itemization changes PRESENTATION, never the total. Mechanically:
  //  • line sell = round(signed line AMOUNT × (1+m)) — never per-unit rounding × qty
  //    (a 1000-count $25 line billed $30 that way). qty×unit renders whenever the rounded
  //    unit lands within pennies of the sell — the per-bill remainder row (which exists to
  //    absorb tax + rounding) trues up the cents, so the INVARIANT still holds while the
  //    customer sees "6 ea × $43.54" instead of a count buried in the description. Erik was
  //    hand-splitting "(N ea)" bundles line by line ("no per item price which is exactly
  //    what i need"); only a pathological split (drift past the cap, or a sub-cent unit)
  //    still folds the qty into the description.
  //  • negatives (discounts/returns) stay negative rows — dropping or abs()ing them
  //    overbilled above the bill's net.
  //  • receipt tax lines aren't itemized as fake marked-up "Sales Tax" rows; they land in
  //    the per-bill remainder row ("Supplies & tax"), same opacity as the lump always had.
  //  • the remainder row absorbs tax + rounding + unreadable/unpriced lines, so a bill
  //    whose lines are junk still bills its full amount (never $0), and a corrected
  //    bill.amount always wins over stale lines.
  for (const b of (bills ?? []) as any[]) {
    // A RETURN IS A CREDIT, NOT A BLANK (INV-078). This gate used to be "above zero or skip", so a
    // supplier return filed as a negative bill never reached the customer - INV-078 still billed
    // four housings that had gone back to CED. Zero is still neither a cost nor a credit.
    const isReturn = isReturnBill(b.amount);
    if (!(Number(b.amount) > 0) && !isReturn) continue;
    if (claims.owner.has(String(b.id))) {
      skippedIds.push(String(b.id));
      continue;
    }
    // The delivery this bill is for was already billed through its PO on another invoice. Billing
    // the bill too charges the same delivery twice; if it came in higher than the order, that
    // difference is the office's call, by hand — never invented here. Counted and said below.
    if (typeof b.po_id === "string" && b.po_id && claims.owner.has(b.po_id)) {
      poCovered.push({ billId: String(b.id), poId: b.po_id });
      continue;
    }
    if (isReturn) {
      // The return, read backwards through billItemisation: same markup, same line states, tax in
      // proportion, claimed by the bill's id like any purchase - see supplier-returns.ts.
      const creditRows = returnCreditRows(b, returnLines.get(b) ?? linesByBill.get(b.id) ?? [], markup);
      const outcome = { billId: String(b.id), supplier: String(b.supplier ?? "").trim() || "supplier", amount: Number(b.amount) };
      if (!creditRows.length) {
        returnsNotCredited.push({ ...outcome, credit: 0 });
        continue;
      }
      const credit = Math.round(-creditRows.reduce((s, r) => s + r.quantity * r.unit_price, 0) * 100) / 100;
      returnsOffered.push({
        ...outcome,
        credit,
        provisional: b.pricing_provisional === true,
        rows: creditRows.map((r) => ({ ...r, source_ids: [String(b.id)] })),
      });
      continue;
    }
    const billRows = billItemisation(b, linesByBill.get(b.id) ?? [], markup);
    // NOTHING LEFT TO CHARGE. Every line on this receipt was the company's own (0268) — Erik's
    // "mostly snacks and a $3 part" with the part flipped off too. Counted, and said below,
    // because "no purchase orders or bills on this job yet" would be a lie about a receipt he
    // can see on the job, and a screen that disagrees with the database is the bug we came from.
    if (!billRows.length) {
      nothingBillable.push(String(b.id));
      continue;
    }
    // Counted only for bills that actually produce lines: a receipt skipped above puts nothing on
    // this invoice, so warning about its prices would send the office looking for a charge that
    // isn't there.
    if (b.pricing_provisional === true) provisional.push(String(b.id));
    // Every row of a bill claims the BILL (0255): a bill is billed as a unit (its rows sum to the
    // marked-up BILLABLE total — the anchor invariant), so the claim is at bill level, not per line.
    rows.push(...billRows.map((r) => ({ ...r, source_ids: [String(b.id)] })));
  }
  /**
   * AFTER THE BILL ROWS, ONE LINE PER TAKE FROM STOCK (Shop Stock, Phase 3; the invoice-line law:
   * materials stay itemized, and a new take is a new line, never merged into another).
   *
   * "12/2 NM-B, 40 ft": the item and the count, never the shelf, a roll or a supplier. Priced at
   * `markup` - the same figure every bill row above was priced at, after the invoice's own markup
   * was read back (keepInvoiceMarkup) - on the pieces' stamped cost, rounded once. Claimed by the
   * take's move ids and keyed stock:<draw_group>; 0343 lets a move be held by one live line only.
   * A take any other invoice holds stays there, whole. A SHORT is never offered: it has no roll and
   * no cost yet, and it is said below instead.
   */
  const stockSplit = unclaimedTakes(stock.takes, claims.owner);
  const stockPlan = stockImportRows(stockSplit.free, markup);
  const stockRows: ImportRow[] = stockPlan.rows;
  const stockHeldIds = stockSplit.held.map((t) => t.moveIds.find((id) => claims.owner.has(id))!).filter(Boolean);
  const stockWarnings = [stockShortsSentence(stock.shorts), stockZeroCostSentence(stockPlan.zeroCost)].filter((x): x is string => !!x);
  // A CREDIT NEVER TAKES THE INVOICE BELOW ZERO (returnsThatFit): a return lands only where the
  // invoice bills at least as much as it credits; the rest are held, unclaimed, for the next one.
  let fit: { land: typeof returnsOffered; held: typeof returnsOffered } = { land: [], held: [] };
  if (returnsOffered.length) {
    const room = await invoiceRoomForReturns(supabase, invoiceId, [...rows, ...stockRows]);
    // A return row the office edited or dismissed does not land (its edited twin is already in the
    // base), so only the rows that WILL land count against the room.
    const landing = returnsOffered.map((r) => ({
      ...r,
      credit: Math.round(-r.rows.filter((x) => !room.skip.has(x.import_key)).reduce((t, x) => t + x.quantity * x.unit_price, 0) * 100) / 100,
    }));
    fit = returnsThatFit(room.base, landing);
  }
  const returnsCredited = fit.land;
  const returnsHeld = fit.held;
  for (const r of returnsCredited) {
    if (r.provisional) provisional.push(r.billId);
    rows.push(...r.rows);
  }
  if (!rows.length && !stockRows.length) {
    // Pieces taken past the shelf (no roll yet) and takes whose pieces cost nothing are never
    // billed; an empty run still says so, beside whichever reason below it gives.
    const stockSaid = stockWarnings.length ? ` ${stockWarnings.map((w) => w.replace(/\.$/, "")).join(". ")}.` : "";
    const stockNote = stockWarnings.map((w) => w.replace(/\.$/, "")).join("; ");
    const held = [...skippedIds, ...poCovered.map((c) => c.poId), ...stockHeldIds];
    if (held.length)
      return {
        ok: false,
        empty: true,
        error: `Every bill and order on this job is already on ${joinNumbers(claimantNumbers(claims, held))} — nothing new to bill.${stockSaid}`,
        ...(stockNote ? { emptyNote: stockNote } : {}),
      };
    if (stockNote && !nothingBillable.length && !returnsHeld.length && !returnsNotCredited.length)
      return { ok: false, empty: true, error: `Nothing here to bill yet.${stockSaid}`, emptyNote: stockNote };
    // A DEAD END IS A SCREEN THAT BLAMES THE WRONG THING. There IS a receipt here; every line on
    // it is switched off. Say that, and say where the switch is, instead of "no bills yet".
    if (nothingBillable.length)
      return {
        ok: false,
        empty: true,
        error: `Nothing here to bill: on ${nothingBillable.length === 1 ? "that receipt" : "those receipts"}, every line is marked as your own cost rather than the customer's. Open the bill to change what the customer pays for.`,
      };
    // The same sentence for a return: it is on the job, and the reason nothing came off is his own
    // switch, or an invoice with too little on it to take the credit - never "no bills yet" about
    // a piece of paper he can see.
    if (returnsHeld.length || returnsNotCredited.length)
      return {
        ok: false,
        empty: true,
        error: `Nothing here to bill or credit: ${returnsSummaryParts([], returnsNotCredited, returnsHeld).join("; ")}.${returnsNotCredited.length ? " Open the bill to change what the customer pays for." : ""}`,
        emptyNote: returnsSummaryParts([], returnsNotCredited, returnsHeld).join("; "),
      };
    return { ok: false, error: "No purchase orders or bills on this job yet.", empty: true };
  }

  // What the invoice's materials lines claim BEFORE the RPC, so the toast counts only the bills
  // and orders this tap added (withClaimStats diffs it against the read-back after).
  // The bill rows and the takes go to the RPC together: one source ("costs"), one reconcile, so a
  // take that is no longer on the job (undone, or carried back whole) comes off in the same pass
  // and is NAMED by upsertImportedItems' removed-lines read, never dropped in silence.
  const offered = [...rows, ...stockRows];
  const before = await landedSourceIds(supabase, invoiceId, "costs", offered);
  const rep = await upsertImportedItems(supabase, invoiceId, "costs", offered);
  if (rep.error) return { ok: false, error: rep.error };
  // A take's line IS materials (0342): stored, not inferred, so every reader and the Kind chip
  // agree. Only a line with no kind yet is set (a kind the office chose stays theirs). A failure
  // here is logged, not raised: the line still reads Materials from its import source.
  if (stockRows.length) await stampStockLinesMaterials(supabase, invoiceId, stockRows.map((r) => r.import_key));
  if (importMovedMoney(rep.stats)) await stampInvoiceRevised(supabase, invoiceId, "importCostsIntoInvoice");
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  // Report what actually happened, in bills, counted from the lines that LANDED: "2 bills pulled
  // in · 3 already on INV-061 skipped" is a different sentence from "Materials imported", and it is
  // the one that tells the office what this invoice now carries and what it deliberately left
  // where it was.
  const after = await landedSourceIds(supabase, invoiceId, "costs", offered);
  const stats = withClaimStats(rep.stats, rows, landedDiff(before, after), skippedIds, claims, "bills");
  // The takes, counted the same way (new on the invoice since before the RPC), in their own noun.
  // A take counts as landed when a move of it is on the invoice now and was not before; one whose
  // moves are on no line after the RPC was held back by a line the office deleted (tombstoned) or
  // edited, and is said with the door out, like a bill's. When the read-back failed, withClaimStats
  // already speaks in the RPC's own line count, and `offered` put the take lines in that count, so
  // the takes are not counted again on top of it (that said "3 lines ... · 3 takes" for 3 lines).
  const stockLanded = before && after
    ? stockRows.filter((r) => (r.source_ids ?? []).some((id) => after.has(id) && !before.has(id))).length
    : 0;
  const stockHeldBack = after ? stockRows.filter((r) => !(r.source_ids ?? []).some((id) => after.has(id))).length : 0;
  const stockParts: string[] = [];
  if (stockLanded) stockParts.push(`${takesWords(stockLanded)} pulled in`);
  if (stockHeldBack)
    stockParts.push(`${takesWords(stockHeldBack)} not added — on a line you edited or deleted (Start It Over rebuilds ${stockHeldBack === 1 ? "it" : "them"})`);
  if (stockHeldIds.length) {
    stockParts.push(`${takesWords(stockHeldIds.length)} already on ${joinNumbers(claimantNumbers(claims, stockHeldIds)) || "another invoice"} skipped`);
    stats.skipped_claimed += stockHeldIds.length;
    stats.claimed_on = [...new Set([...stats.claimed_on, ...claimantNumbers(claims, stockHeldIds)])];
  }
  stats.stock_pulled_in = stockLanded;
  if (stockParts.length) stats.summary = rows.length ? `${stats.summary} · ${stockParts.join(" · ")}` : stockParts.join(" · ");
  // Money a person must look at before sending: pieces taken past the shelf that no roll covers
  // yet, and takes whose roll has no cost on it. Neither is on the bill; both are said.
  if (stockWarnings.length) stats.warnings = [...(stats.warnings ?? []), ...stockWarnings];
  if (poCovered.length) {
    const n = poCovered.length;
    stats.skipped_claimed += n;
    stats.summary += ` · ${n} ${n === 1 ? "bill" : "bills"} left off — the order ${n === 1 ? "it names is" : "they name are"} already on ${joinNumbers(claimantNumbers(claims, poCovered.map((c) => c.poId)))}; bill any difference by hand`;
  }
  // Say the preview pricing out loud, and only about receipts whose lines are ON this invoice —
  // `after` is what the read-back found, so a bill held back behind a line the office edited by
  // hand isn't named (that line carries the office's own typed number, not the counter's). When
  // the read-back itself failed we can't tell, so every flagged receipt is named rather than none:
  // an extra look costs a minute, an unflagged counter price costs his word to a customer.
  const notes: string[] = [];
  if (keptMarkup !== null) {
    const kept = `materials priced at the ${keptMarkup}% markup already on this invoice`;
    stats.summary += ` · ${kept}`;
    notes.push(kept);
  }
  const flagged = after ? provisional.filter((id) => after.has(id)) : provisional;
  if (flagged.length) {
    const n = flagged.length;
    const preview = `${n === 1 ? "one receipt's prices are" : `${n} receipts' prices are`} a counter preview, not your account's pricing - check ${n === 1 ? "it" : "them"} before you send`;
    stats.summary += ` · ${preview}`;
    notes.push(preview);
  }
  // Returns, said: the credit THIS tap landed (read back and diffed against before, like the claim
  // counts above - a re-import of a draft already holding the credit does not say it twice, and a
  // return whose rows sit behind an edited line is not claimed as credited), any return with
  // nothing on it that was ever the customer's, and any held back for a bigger invoice.
  const creditedLanded = after ? returnsCredited.filter((r) => after.has(r.billId) && !before?.has(r.billId)) : returnsCredited;
  const returnParts = returnsSummaryParts(creditedLanded, returnsNotCredited, returnsHeld);
  if (returnParts.length) stats.summary += ` · ${returnParts.join(" · ")}`;
  // The credited return is counted by the caller's own before/after measure; the ones that did NOT
  // land (nothing on them was the customer's, or held for a bigger invoice) are only said here.
  notes.push(...returnsSummaryParts([], returnsNotCredited, returnsHeld));
  if (notes.length) stats.notes = notes;
  const drift = await editedRemainderWarnings(supabase, invoiceId, (bills ?? []) as { id: string; supplier?: string | null; amount?: unknown }[], rows, markup);
  if (drift.length) stats.warnings = [...(stats.warnings ?? []), ...drift];
  return { ok: true, stats: sayRemoved(stats, rep.removed) };
}

/**
 * WHAT THE INVOICE WILL BILL WITHOUT ANY SUPPLIER RETURN, once this import lands - the room a
 * credit has before the invoice would go below zero (returnsThatFit).
 *
 * The RPC's own rules, read forward: every line that is not an unedited materials line stays as it
 * is (labor, hand lines, change orders, and any materials line the office edited - including an
 * edited return row, whose credit is already in it); the offered rows replace the rest, except a
 * row whose key the office edited or dismissed, which does not land. A lost read is logged and
 * counts only the offered rows - the room a fresh invoice would have.
 */
async function invoiceRoomForReturns(
  supabase: Awaited<ReturnType<typeof createClient>>,
  invoiceId: string,
  rows: ImportRow[],
): Promise<{ base: number; skip: Set<string> }> {
  const cents = (n: number) => Math.round(n * 100) / 100;
  const skip = new Set<string>();
  let kept = 0;
  const [{ data: items, error }, { data: invRow }] = await Promise.all([
    supabase.from("invoice_items").select("import_source, import_key, line_total, edited").eq("invoice_id", invoiceId),
    supabase.from("invoices").select("dismissed_import_keys").eq("id", invoiceId).maybeSingle(),
  ]);
  if (error) {
    reportError("importCostsIntoInvoice.returnRoom", error, { invoiceId });
  } else {
    for (const it of (items ?? []) as { import_source?: string | null; import_key?: string | null; line_total?: unknown; edited?: boolean | null }[]) {
      const importedCost = it.import_source === "costs" && it.edited !== true;
      if (!importedCost) kept = cents(kept + (Number(it.line_total) || 0));
      if (it.import_source === "costs" && it.edited === true && it.import_key) skip.add(it.import_key);
    }
  }
  for (const k of ((invRow as { dismissed_import_keys?: string[] | null } | null)?.dismissed_import_keys ?? [])) skip.add(k);
  // Offered rows only - the returns themselves are not in `rows` yet.
  for (const r of rows) if (!skip.has(r.import_key)) kept = cents(kept + r.quantity * r.unit_price);
  return { base: kept, skip };
}

/**
 * NAME THE EDITED "SUPPLIES & TAX" ROWS THIS IMPORT LEFT BEHIND (INV-074, $0.77 short).
 *
 * Read after the RPC, because only the invoice knows which rows the office edited. A failed read
 * does not fail the import (it already landed and the office is about to be told so); it goes to
 * the ops log, and the toast says what it can.
 */
async function editedRemainderWarnings(
  supabase: Awaited<ReturnType<typeof createClient>>,
  invoiceId: string,
  bills: { id: string; supplier?: string | null; amount?: unknown }[],
  offered: ImportRow[],
  markup: number | undefined,
): Promise<string[]> {
  try {
    const { data, error } = await supabase
      .from("invoice_items")
      .select("import_key, line_total, edited")
      .eq("invoice_id", invoiceId)
      .eq("import_source", "costs");
    if (error) {
      reportError("importCostsIntoInvoice.remainderDrift", error, { invoiceId });
      return [];
    }
    const lines = (data ?? []) as { import_key?: string | null; line_total?: unknown; edited?: boolean | null }[];
    return editedRemainderDrift(bills, offered, lines).map((d) => editedRemainderSentence(d, markup));
  } catch (e) {
    reportError("importCostsIntoInvoice.remainderDrift", e, { invoiceId });
    return [];
  }
}

/**
 * A PROGRESS / FINAL DRAW IS THE DELTA (0255) — the work logged since the last bill, itemized.
 *
 * It used to be cumulative (AIA-style): re-itemize ALL of the job's labor + materials every time,
 * then credit every prior invoice's subtotal so the balance came out to the new work. That was the
 * only honest build while a labor line could not say which hours it held — and it is why Erik's
 * "Progress Payment" and "Request Next Payment" on 85 Whitney both refused: a paid standard
 * invoice on the job made the re-itemization a double bill, so the guard forbade the draw.
 *
 * Now every imported row carries its claim, so the draw imports ONLY the rows no non-void invoice
 * on the job holds (labor at bill rate, materials with markup) and credits ONLY money paid against
 * work rather than for itemized work — a fixed-$ / %-of-estimate deposit not yet netted
 * (fixedBillingsNotYetNetted). Prior standard invoices and prior delta draws are not credited:
 * nothing on them is on this document. On J-028 that is Brian's 5.25 hr and the two CED bills,
 * and nothing else — and "New Invoice", "Progress Payment → Actual T&M" and "Request Next Payment"
 * all produce that same draft.
 *
 * When nothing is unclaimed it says so and names where the work is ("Everything worked so far is
 * already on INV-061.") instead of minting an empty draw.
 */
/** What the progress-report door hands back. `note` is the sentence to put in front of the office
 *  before it lands on the draw ("Pulled 12 hours and 1 bill into INV-078."); `partial` means part of
 *  it did NOT happen. `openDraft` rides on a refusal whose way out is a document: the caller offers
 *  "Open INV-0xx" instead of a dead end. */
export type ProgressReportResult = Result & { note?: string; partial?: true; openDraft?: { id: string; number: string } };

/**
 * BRING AN OPEN ACTUALS DRAW UP TO DATE (J-011, INV-078) — exactly what New Invoice does to a
 * standard draft: pull the unclaimed hours at bill rate and the unclaimed bills at the job's
 * customer markup (the resolver this door already prices with), recalc (the importers do), never
 * touch the status. What landed is MEASURED from the job's own unbilled picture before and after,
 * so the sentence names hours and bills — "Pulled 12 hours and 1 bill into INV-078." — and what
 * is still off it. A failed import is said, never swallowed.
 */
async function refreshActualsDraw(
  supabase: Awaited<ReturnType<typeof createClient>>,
  jobId: string,
  open: OpenDraft,
  markup: number,
  asKind: "progress" | "final" = "progress",
): Promise<ProgressReportResult> {
  const label = open.number ?? "the open progress payment";
  const measure = () =>
    unbilledWorkForJob(supabase, jobId).catch((e) => {
      reportError("refreshActualsDraw.measure", e, { jobId, invoiceId: open.id });
      return null;
    });
  const fail = (e: unknown): ImportResult => ({ ok: false, error: String((e as { message?: unknown })?.message ?? e) });
  const before = await measure();
  const lab = await importLaborCore(open.id, true).catch(fail);
  // keepInvoiceMarkup: a % the office typed on this draw's Materials box stays (lib/invoice-markup);
  // `markup` is only the answer for a draw with nothing on it to read one from.
  const cos = await importCostsCore(open.id, markup, true, true).catch(fail);
  const after = await measure();
  revalidatePath(`/jobs/${jobId}`);
  revalidateMoney(open.id);

  const missed: string[] = [];
  if (!lab.ok && !lab.empty) {
    reportError("refreshActualsDraw.labor", lab.error, { jobId, invoiceId: open.id });
    missed.push(`the hours (${lab.error ?? "the import failed"})`);
  }
  if (!cos.ok && !cos.empty) {
    reportError("refreshActualsDraw.costs", cos.error, { jobId, invoiceId: open.id });
    missed.push(`the bills (${cos.error ?? "the import failed"})`);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  let said: string;
  if (before && after) {
    said = pulledIntoSentence(
      label,
      {
        hours: Math.max(0, r2(before.hours - after.hours)),
        bills: Math.max(0, before.billsCount - after.billsCount),
        returns: Math.max(0, before.returnsCount - after.returnsCount),
        returnsCredit: Math.max(0, r2(before.returnsCredit - after.returnsCredit)),
        stock: Math.max(0, (before.stockCount ?? 0) - (after.stockCount ?? 0)),
      },
      { hours: after.hours, bills: after.billsCount, returns: after.returnsCount, stock: after.stockCount ?? 0 },
      formatCurrency,
    );
  } else {
    // The measure failed but the imports ran: speak in the importers' own counts.
    const n = (r: ImportResult) => (r.ok ? r.stats?.pulled_in ?? 0 : 0);
    const takes = cos.ok ? cos.stats?.stock_pulled_in ?? 0 : 0;
    const bits = [
      n(lab) ? `${n(lab)} time ${n(lab) === 1 ? "entry" : "entries"}` : "",
      n(cos) ? `${n(cos)} ${n(cos) === 1 ? "bill" : "bills"}` : "",
      takes ? takesWords(takes) : "",
    ].filter(Boolean);
    said = bits.length ? `Pulled ${bits.join(" and ")} into ${label}.` : `Nothing new to pull into ${label}.`;
  }
  // Money the importers want a person to look at: an edited tax row left behind (warnings), and
  // what the counts don't say (notes) - a counter-preview price to check before sending, a return
  // not credited or held and why, the invoice's own markup kept.
  const extra = [
    // "Added 6 h to Labor - Erik Taylor at $100" (Erik's INV-078 rule), then anything the labor run
    // could not put on, or took off, in plain words.
    ...(lab.ok ? [...(lab.stats?.notes ?? []), ...(lab.stats?.warnings ?? [])] : []),
    ...(cos.ok ? [...(cos.stats?.notes ?? []), ...(cos.stats?.warnings ?? [])] : []),
    // An "empty" costs run carries its reason in `error` (e.g. a return held, nothing else to bill).
    ...(!cos.ok && cos.empty && before && before.returnsCount > 0 && cos.error ? [cos.error.replace(/\.$/, "")] : []),
    // ...and pieces taken past the shelf with no roll yet, which an empty run still has to say.
    ...(!cos.ok && cos.empty && cos.emptyNote && !(before && before.returnsCount > 0) ? [cos.emptyNote] : []),
  ];
  if (extra.length) said += ` ${extra.map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join(". ")}.`;
  // "Final" chosen on the Progress Payment modal while this report is open: the report becomes the
  // final one rather than the choice being dropped. Checked (silent-write law); a failure is said.
  if (asKind === "final" && open.kind !== "final") {
    const { data: flipped, error: flipErr } = await supabase
      .from("invoices")
      .update({ invoice_kind: "final" })
      .eq("id", open.id)
      .eq("status", "draft")
      .select("id");
    if (flipErr || !flipped?.length) {
      reportError("refreshActualsDraw.final", flipErr ?? "zero rows", { jobId, invoiceId: open.id });
      return { ok: true, id: open.id, partial: true, note: `${said} But ${label} couldn't be marked as the final payment just now - it is still a progress payment.${missed.length ? ` And ${missed.join(" and ")} couldn't be pulled in - review the lines before sending.` : ""}` };
    } else {
      await supabase.from("invoices").update({ title: "Final invoice" }).eq("id", open.id).eq("title", "Progress payment");
      said += ` ${label} is now the final payment.`;
    }
  }
  if (missed.length) {
    return { ok: true, id: open.id, partial: true, note: `${said} But ${missed.join(" and ")} couldn't be pulled in - review the lines before sending.` };
  }
  return { ok: true, id: open.id, note: said };
}

/**
 * THE JOB'S OPEN DRAW IS THE DOOR, NOT A WALL. One draft draw per job is still the rule (a second
 * would race the first for the same rows). What changed is what happens when there is one: an
 * actuals draw takes the new work (refreshActualsDraw); a contract draw can't, so the refusal
 * carries the document itself and the caller offers "Open INV-0xx".
 */
async function landOnOpenDraw(
  supabase: Awaited<ReturnType<typeof createClient>>,
  jobId: string,
  open: OpenDraft,
  asKind: "progress" | "final" = "progress",
): Promise<ProgressReportResult> {
  const label = open.number ?? "A draft progress payment";
  if (!open.refreshable) {
    return {
      ok: false,
      error: `${label} is still open on this job and bills a set part of the contract, so new hours and bills can't go on it. Open it to send it (or delete it), then bill the new work.`,
      ...(open.number ? { openDraft: { id: open.id, number: open.number } } : {}),
    };
  }
  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const markup = await customerMaterialMarkupForJob(supabase, jobId, getOrgSettings((org as { settings?: unknown } | null)?.settings).material_markup_percent);
  return refreshActualsDraw(supabase, jobId, open, markup, asKind);
}

export async function createProgressReportInvoice(
  jobId: string,
  kind: "progress" | "final",
): Promise<ProgressReportResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const [{ data: job }, { data: org }, { data: sched }] = await Promise.all([
    supabase.from("jobs").select("customer_id, name").eq("id", jobId).maybeSingle(),
    supabase.from("organizations").select("settings").maybeSingle(),
    supabase.from("payment_milestones").select("id").eq("job_id", jobId).limit(1).maybeSingle(),
  ]);
  if (!job) return { ok: false, error: "Job not found." };
  // Mutual exclusion: a job billing on a payment schedule must draw via "Request next
  // payment" (the milestone path), not this ad-hoc work-to-date draw.
  if (sched)
    return { ok: false, error: "This job bills on a payment schedule — use “Request next payment” from the schedule instead." };
  // H3/M6: at most one draft draw per job — a second would re-import and re-bill the whole job.
  // An open ACTUALS draw is brought up to date instead of refused (J-011: "Draft INV-078 is still
  // open" was a dead end on the one document the new hours belong on); a contract draw names itself.
  let open: OpenDraft | null;
  try {
    open = await openDraftOnJob(supabase, jobId);
  } catch (e) {
    reportError("createProgressReportInvoice.openDraft", e, { jobId });
    return { ok: false, error: "Couldn't read this job's invoices just now, so nothing was billed. Try again in a moment." };
  }
  if (open && isDrawKind(open.kind)) return landOnOpenDraw(supabase, jobId, open, kind);
  // H4 (reverse), narrowed (0255): only a DRAFT standard invoice with content blocks — it is the
  // open door new work belongs on. A sent/paid one is finished business; the delta below bills
  // only what it (and every other non-void invoice) doesn't already claim.
  const stdBlocker = await standardBillingBlockerOnJob(supabase, jobId);
  if (stdBlocker) return standardBillingConflictError(stdBlocker);
  // THE DELTA, decided before a row is written. unbilledWorkForJob is the same arithmetic the
  // importers run below, so "nothing unclaimed" is known up front and no empty draft is minted.
  // IT THROWS NOW, AND A RAW POSTGREST ERROR IS NOT A SENTENCE (review, 2026-09-20). The bills
  // read inside unbilledWorkForJob was changed to throw rather than report $0 of material - right,
  // because a lost read that reads as "no materials" bills a customer short - but this caller had
  // no catch, so the failure would have surfaced as library text on the one button that creates a
  // document a customer sees.
  let unbilled: Awaited<ReturnType<typeof unbilledWorkForJob>>;
  let fixedToNet: Awaited<ReturnType<typeof fixedBillingsNotYetNetted>>;
  try {
    [unbilled, fixedToNet] = await Promise.all([unbilledWorkForJob(supabase, jobId), fixedBillingsNotYetNetted(supabase, jobId)]);
  } catch (e) {
    reportError("createProgressReportInvoice.unbilled", e, { jobId });
    return { ok: false, error: "Couldn't read this job's work just now, so nothing was billed. Try again in a moment." };
  }
  if (!unbilled.schemaReady) {
    return { ok: false, error: "Billing is mid-upgrade for a few minutes — a progress payment can't tell new time from billed time until it finishes. Try again shortly." };
  }
  // THE GATE IS THE NEW WORK, NOT THE NET (review of this wave). `total` is now net of pending
  // supplier returns, and gating on it refused to bill $20 of real, unclaimed labor because a $60
  // return outweighed it - then said "everything is already invoiced", which was false. The draw
  // bills the work; a return rides on it only when the draw still bills more than the credit
  // (importCostsIntoInvoice holds it otherwise, so the draw never goes below zero).
  const newWork = Math.round((unbilled.laborAmount + unbilled.billsBilled + (unbilled.stockBilled ?? 0)) * 100) / 100;
  if (newWork <= 0.005) {
    // Pieces taken past the shelf are work too, just not billable yet: said, never hidden behind
    // "nothing to bill".
    const shorts = unbilled.stockShortsWords ? ` ${unbilled.stockShortsWords}` : "";
    const on = unbilled.claimedOn.length ? joinNumbers(unbilled.claimedOn) : unbilled.lastInvoiceNumber;
    // A return is money the customer is owed, and a refusal that talks only about hours would hide
    // it. Said, with where it goes.
    const owed =
      unbilled.returnsCount > 0
        ? ` A supplier return of ${formatCurrency(unbilled.returnsCredit)} is owed back to the customer; a progress payment can't go below zero, so it comes off the next one that bills more than that.`
        : "";
    return {
      ok: false,
      error: (on && unbilled.claimedCount ? `Everything worked so far is already on ${on}.` : "No labor or materials are logged on this job yet to bill.") + owed + shorts,
    };
  }
  // A DEPOSIT THAT STILL COVERS THE WORK IS SAID BEFORE A NUMBER IS TAKEN (review, 2026-09-24). The
  // decision below (resolveDrawCredit, after the import) used to be the only one: the draw was
  // inserted - taking the next invoice number - then deleted with "The deposit already covers…",
  // and every tap on the card's "Create Invoice" burned another number the same way. The new work
  // before any return comes off is the MOST the import can itemise, so when the lump covers even
  // that, it certainly covers what would land: refuse here, nothing written.
  const upFront = resolveDrawCredit(newWork, fixedToNet);
  if (!upFront.ok && upFront.reason === "covered") {
    return {
      ok: false,
      error: `The ${formatCurrency(fixedToNet)} deposit not yet taken off a bill already covers the ${formatCurrency(newWork)} worked since the last bill — nothing new to bill yet.`,
    };
  }
  const settings = getOrgSettings((org as any)?.settings);
  // Seed from the customer's pricing level (falling back to the org default) — the same
  // resolver the manual import box and the work-to-date panel use, so a draw can't bill a
  // level customer's materials at a different rate than a standard invoice would.
  const markup = await customerMaterialMarkupForJob(supabase, jobId, settings.material_markup_percent);
  const dueDate = await defaultDueDateIso(supabase);

  const { data: inv, error } = await supabase
    .from("invoices")
    .insert({
      customer_id: job.customer_id,
      job_id: jobId,
      status: "draft",
      title: kind === "final" ? "Final invoice" : "Progress payment",
      invoice_kind: kind,
      tax_rate: 0,
      subtotal: 0,
      tax: 0,
      total: 0,
      due_date: dueDate,
    })
    .select("id, invoice_number")
    .single();
  if (error) {
    if ((error as any).code === "23505") {
      // Lost a race to another tap that opened a draw a moment ago: land on THAT one, the same way
      // the check above would have, instead of a refusal with no door.
      const raced = await openDraftOnJob(supabase, jobId).catch(() => null);
      if (raced && isDrawKind(raced.kind)) return landOnOpenDraw(supabase, jobId, raced, kind);
      return { ok: false, error: "A draft draw is already open on this job — send or delete it before creating another." };
    }
    return { ok: false, error: dbError(error) };
  }

  // Itemize the UNCLAIMED work (labor at bill rate + materials with markup): both importers drop
  // the rows another non-void invoice claims.
  //
  // A REAL IMPORT FAILURE IS THE ONE THING THIS MUST NOT SWALLOW (cn-v967). It used to log and
  // carry on, which is how the single failure 0260 was built to make LOUD got muffled by the one
  // function that mints a customer-facing document. Two staff tap progress billing on the same job
  // in the same second; the advisory lock serialises them and the loser's import comes back with
  // 'hours already billed on INV-062'. Logged server-side, shrugged off here: the draw shipped
  // with no labor line at all and a clean success toast, or - if both sides lost - the fresh
  // invoice was deleted and the office was told "No labor or materials are logged on this job yet
  // to bill", which is a lie in exactly the case that caused it. There ARE logged hours. The
  // import to itemise them failed.
  //
  // `empty: true` still means "nothing on that side to bill" and still passes quietly, so a
  // labor-only or materials-only job behaves exactly as before. Only a genuine failure changes,
  // and it changes from a false success into the importer's own sentence.
  //
  // Why DELETE rather than keep the half-built draft: invoices_one_open_draft_draw means an
  // orphaned draft draw blocks every future attempt on this job ("Draft INV-0xx is still open on
  // this job"), which is a dead end. Deleting takes the lines - and the claims that ride on them -
  // with it, the same thing the no-work branch below already does, so a retry starts clean.
  // trustedActuals: this draw was minted a moment ago FOR the actuals and has no lines yet to say so.
  const pLabor = await importLaborCore(inv.id, true);
  if (!pLabor.ok && !pLabor.empty) {
    reportError("createProgressReportInvoice.labor", pLabor.error, { jobId, invoiceId: inv.id });
    const rolled = await rollBackDraw(supabase, inv.id, jobId, "labor");
    return {
      ok: false,
      error: (pLabor.error ?? "Couldn't pull this job's hours onto the draw just now, so nothing was billed.") + rolled,
    };
  }
  const pCosts = await importCostsCore(inv.id, markup, true);
  if (!pCosts.ok && !pCosts.empty) {
    reportError("createProgressReportInvoice.costs", pCosts.error, { jobId, invoiceId: inv.id });
    const rolledC = await rollBackDraw(supabase, inv.id, jobId, "materials");
    return { ok: false, error: (pCosts.error ?? "Couldn't pull this job's materials onto the draw just now - nothing was billed. Try again in a moment.") + rolledC };
  }

  // SUBTOTAL, not total (audit 8): the credit line is inserted INSIDE this draw's subtotal, so
  // netting a tax-INCLUSIVE figure against pre-tax work credited the customer their own tax.
  const { data: afterImport } = await supabase.from("invoices").select("subtotal").eq("id", inv.id).maybeSingle();
  const importedTotal = Number(afterImport?.subtotal ?? 0);

  // What still has to be netted is ONLY money paid against work rather than for itemized work — a
  // fixed-$ / %-of-estimate deposit not yet credited. Prior standard invoices and prior delta draws
  // are NOT credited: nothing on them is re-itemized here, so there is nothing to net. (The old
  // cumulative credit against every prior subtotal is what read the $400 referral hand line on
  // INV-061 as "previously billed work" and left the modal $400 low.)
  // H1: a draw must never go negative. The pure, unit-tested resolveDrawCredit decides whether to
  // bail (nothing new / the deposit still covers it) or how much to credit (floored at $0 owed).
  const decision = resolveDrawCredit(importedTotal, fixedToNet);
  if (!decision.ok) {
    await supabase.from("invoices").delete().eq("id", inv.id);
    return {
      ok: false,
      error:
        decision.reason === "no-work"
          ? "No labor or materials are logged on this job yet to bill."
          : `The deposit already covers the ${formatCurrency(importedTotal)} worked since the last bill — nothing new to bill yet.`,
    };
  }
  if (decision.credit > 0.005) {
    // Stamp it import_source:"draw_credit" so it's tamper-evident — deleting/editing
    // this negative line would wipe the prior-billings offset and re-bill the deposit,
    // so updateInvoiceItem/deleteInvoiceItem refuse to touch it. (org_id via trigger.)
    await supabase.from("invoice_items").insert({
      invoice_id: inv.id,
      description: "Less previous billings (deposit & prior draws)",
      quantity: 1,
      unit: "lot",
      unit_price: -decision.credit,
      import_source: "draw_credit",
    });
    await recalcInvoice(supabase, inv.id);
  }

  revalidatePath(`/jobs/${jobId}`);
  revalidateMoney();
  // Said, so a click from the job card lands on a new document with the sentence of what it is -
  // and names the deposit that came off, so a figure below the card's is never a surprise.
  const num = (inv as { invoice_number?: string | null }).invoice_number ?? "a new progress payment";
  // What the importers said besides their counts (audit v994 SI5): a return held or not credited,
  // a counter-preview price, an edited tax row left behind. A warning makes this a heads-up.
  const extras = importExtras([pLabor, pCosts]);
  const note =
    (decision.credit > 0.005
      ? `Started ${num} for the work not yet billed, less the ${formatCurrency(decision.credit)} deposit not yet taken off a bill.`
      : `Started ${num} for the work not yet billed - its total is that work.`) + extrasSentence(extras);
  return { ok: true, id: inv.id, note, ...(extras.warnings.length ? { partial: true as const } : {}) };
}

// ── Payment schedule (Fixed-Bid "payment structure") ────────────────────────────

/** Contract total for a job = the agreed amount (shared rule — see contractTotalFromQuotes). */
async function jobContractTotal(supabase: any, jobId: string): Promise<number> {
  const { data: quotes } = await supabase.from("quotes").select("total, status, created_at").eq("job_id", jobId);
  return contractTotalFromQuotes((quotes ?? []) as any);
}

/** Replace a job's payment schedule. Only allowed before any milestone has been
 *  billed (a draw drafted against it) — once billing starts the schedule is locked. */
export async function setPaymentSchedule(
  jobId: string,
  milestones: { label: string; percent?: number | null; amount?: number | null }[],
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  // Org guard: the job must be visible to this caller (RLS) before we attach a schedule.
  const { data: job } = await supabase.from("jobs").select("id").eq("id", jobId).maybeSingle();
  if (!job) return { ok: false, error: "Job not found." };

  // Mutual exclusion: a payment schedule and the ad-hoc draw path can't both bill a
  // job. Refuse to attach a schedule once ANY draw exists on the job.
  const { data: draw } = await supabase
    .from("invoices")
    .select("invoice_number")
    .eq("job_id", jobId)
    .neq("status", "void")
    .in("invoice_kind", [...DRAW_KINDS])
    .limit(1)
    .maybeSingle();
  if (draw)
    return { ok: false, error: "This job already has draws — a payment schedule can only be set before any billing starts." };

  const { data: existing } = await supabase
    .from("payment_milestones")
    .select("id, invoice_id")
    .eq("job_id", jobId);
  if ((existing ?? []).some((m: any) => m.invoice_id))
    return { ok: false, error: "Billing has already started on this schedule — manage the remaining draws from Billing." };

  if ((existing ?? []).length) await supabase.from("payment_milestones").delete().eq("job_id", jobId);

  const rows = (milestones ?? [])
    .map((m, i) => ({
      job_id: jobId,
      sort_order: i,
      label: (m.label || `Payment ${i + 1}`).slice(0, 80),
      percent: m.percent != null && Number(m.percent) > 0 ? Number(m.percent) : null,
      amount: m.amount != null && Number(m.amount) > 0 ? Number(m.amount) : null,
    }))
    .filter((m) => m.percent != null || m.amount != null);
  if (!rows.length) {
    revalidatePath(`/jobs/${jobId}`);
    return { ok: true };
  }

  // C5: a schedule partitions the contract — its draws (percent AND fixed-amount, each its
  // own invoice) can't sum past the contract or they silently over-bill. Cap the TOTAL
  // scheduled $ (so a MIXED percent+fixed schedule can't slip past a percent-only check),
  // and surface a percent schedule that sums UNDER 100% as a silent underbill.
  const contract = await jobContractTotal(supabase, jobId);
  const sched = scheduleStatus(rows as Milestone[], contract);
  if (sched.overContract)
    return {
      ok: false,
      error: `Those milestones total ${formatCurrency(sched.scheduledTotal)} — more than the ${formatCurrency(contract)} contract. Lower the percentages or amounts so they don't exceed it.`,
    };
  // Percent-only over-bill (no contract yet to price the dollars against): keep the 100% cap.
  if (sched.scheduledPct > 100.01)
    return { ok: false, error: `Those milestones add up to ${Math.round(sched.scheduledPct)}% — a draw schedule can't exceed 100% of the contract.` };
  if (sched.percentUnder)
    return {
      ok: false,
      error: `Those milestones add up to ${Math.round(sched.scheduledPct)}% — they don't cover the full contract. Add up to 100% so nothing goes unbilled.`,
    };

  const { error } = await supabase.from("payment_milestones").insert(rows); // org_id via trigger
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

/**
 * TAKE THE HALF-BUILT DRAW BACK OUT, AND SAY SO IF IT WILL NOT GO.
 *
 * A draw whose importer failed has to be deleted: `invoices_one_open_draft_draw` means an orphaned
 * draft blocks every future attempt on this job, which is a dead end. But the delete was written
 * and thrown away (review of the audit fix wave, 2026-09-20) - no `.select`, no error check - in
 * the one function that mints a customer-facing document. If it refused, the office read "nothing
 * was billed" while an empty draw sat on the job barring the retry the sentence just invited.
 */
async function rollBackDraw(
  supabase: { from: (t: string) => any },
  invoiceId: string,
  jobId: string,
  side: string,
): Promise<string> {
  const { data, error } = await supabase.from("invoices").delete().eq("id", invoiceId).select("id");
  if (error || !data?.length) {
    reportError("createProgressReportInvoice.rollback", error ?? "zero rows deleted", { jobId, invoiceId, side });
    return " The empty draw it started could not be removed either, so open this job's billing and delete that draft before trying again.";
  }
  return " Nothing was billed and the draft was removed, so you can try again.";
}

/** Request the next payment per the job's structure:
 *  Fixed Bid with a schedule → draft the next milestone draw;
 *  otherwise (T&M, or fixed with no schedule) → bill the work logged since the last bill. */
export async function requestNextPayment(jobId: string): Promise<ProgressReportResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: job } = await supabase
    .from("jobs")
    .select("billing_type, customer_id")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return { ok: false, error: "Job not found." };

  const { data: milestones } = await supabase
    .from("payment_milestones")
    .select("*")
    .eq("job_id", jobId)
    .order("sort_order");

  const isFixed = (job as any).billing_type !== "tm";
  if (isFixed && (milestones ?? []).length) {
    const contract = await jobContractTotal(supabase, jobId);
    const status = scheduleStatus((milestones ?? []) as Milestone[], contract);
    if (!status.next) return { ok: false, error: "Every scheduled payment has already been billed." };
    return createMilestoneDraw(supabase, jobId, (job as any).customer_id ?? null, status);
  }
  // T&M (or fixed without a schedule): bill the work logged since the last bill.
  return createProgressReportInvoice(jobId, "progress");
}

/** Internal: draft one milestone draw — a single fixed line at the milestone's $,
 *  linked back to the milestone. No prior-billings credit: milestones partition the
 *  contract, so each draw is its own slice (unlike the work-to-date progress draw). */
async function createMilestoneDraw(
  supabase: any,
  jobId: string,
  customerId: string | null,
  status: ReturnType<typeof scheduleStatus>,
): Promise<Result> {
  const next = status.next;
  if (!next) return { ok: false, error: "Every scheduled payment has already been billed." };
  if (!(next.dollars > 0))
    return { ok: false, error: "That payment is $0 — set the contract total (a quote) or a fixed amount on the schedule first." };

  // H3: at most one draft draw open per job.
  const { data: existingDraft } = await supabase
    .from("invoices")
    .select("invoice_number")
    .eq("job_id", jobId)
    .eq("status", "draft")
    .in("invoice_kind", [...DRAW_KINDS])
    .limit(1)
    .maybeSingle();
  if (existingDraft)
    return { ok: false, error: `Draft ${(existingDraft as any).invoice_number} is still open on this job — send or delete it before requesting the next payment.` };

  // H4 (reverse): a standard invoice already billing this job's work blocks a draw.
  const stdBlocker = await standardBillingBlockerOnJob(supabase, jobId);
  if (stdBlocker) return standardBillingConflictError(stdBlocker);

  const count = status.rows.length;
  const payNum = next.index + 1;
  const dueDate = await defaultDueDateIso(supabase);
  const { data: inv, error } = await supabase
    .from("invoices")
    .insert({
      customer_id: customerId,
      job_id: jobId,
      status: "draft",
      title: next.label || (next.kind === "final" ? "Final payment" : next.kind === "deposit" ? "Deposit" : "Progress payment"),
      invoice_kind: next.kind,
      tax_rate: 0,
      subtotal: 0,
      tax: 0,
      total: 0,
      due_date: dueDate,
    })
    .select("id")
    .single();
  if (error) {
    // The partial unique index (one open draft draw per job) backstops a double-submit
    // race that slips past the SELECT above — surface the friendly message, not raw SQL.
    if ((error as any).code === "23505")
      return { ok: false, error: "A draft draw is already open on this job — send or delete it before requesting the next payment." };
    return { ok: false, error: dbError(error) };
  }

  const pctNote = Number(next.percent) > 0 ? ` (${Number(next.percent)}% of contract)` : "";
  await supabase.from("invoice_items").insert({
    invoice_id: inv.id,
    description: `${next.label || "Payment"} — payment ${payNum} of ${count}${pctNote}`,
    quantity: 1,
    unit: "lot",
    unit_price: next.dollars,
    import_source: "milestone",
  });
  await recalcInvoice(supabase, inv.id);

  // Link the milestone to the draw (this is what marks it "billed"; deleting the draft
  // nulls the FK and re-offers it). Reported, never silently desynced.
  if (next.id) {
    const { data: claimed, error: mErr } = await supabase
      .from("payment_milestones")
      .update({ status: "billed", invoice_id: inv.id, billed_amount: next.dollars })
      .eq("id", next.id)
      .is("invoice_id", null) // CLAIM only if still unbilled — wins the race vs a concurrent draw
      .select("id");
    if (mErr) {
      reportError("createMilestoneDraw.link", mErr, { jobId, milestoneId: next.id });
    } else if (!claimed || !claimed.length) {
      // Another request already drafted this milestone (the partial unique index usually blocks the
      // second invoice first; this is the belt-and-suspenders for a delete-then-redraw race). Roll
      // back the draft we just created so we don't leave an orphaned invoice claiming the slot.
      await supabase.from("invoices").delete().eq("id", inv.id);
      return { ok: false, error: "That payment was just drafted by another request — refresh and request the next one." };
    }
  }

  revalidatePath(`/jobs/${jobId}`);
  revalidateMoney();
  return { ok: true, id: inv.id };
}

export async function updateInvoiceItem(
  itemId: string,
  invoiceId: string,
  item: { description?: string; quantity?: number; unit?: string; unit_price?: number },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const block = await requireLiveInvoice(supabase, invoiceId);
  if (block) return block; // 0269: any live bill may be corrected; void is the ending
  // Unchanged by 0269, and checked directly after: the draw's auto credit and its milestone line
  // stay locked whatever the invoice's status is. Editing either desyncs the prior-billings
  // offset or payment_milestones, which is a different failure from "fix a typo on a bill".
  if (await isProtectedCreditLine(supabase, itemId)) return CREDIT_LINE_LOCKED;
  // PATCH semantics (mirrors updateBill): write ONLY the keys the caller sent — an
  // omitted field never touches its column (it used to reset qty to 1 / price to $0).
  const clean: Record<string, unknown> = {};
  if (item.description !== undefined) {
    if (!item.description.trim()) return { ok: false, error: "Description is required." };
    clean.description = item.description.trim();
  }
  if (item.quantity !== undefined) clean.quantity = item.quantity || 1;
  // The UNIT is the contractor's own word for what he sold — hrs, lot, ea, ft, days (Erik,
  // 8/18: "when i add a new line item i dont have a choice to label it differently"). It was
  // writable only by the importers, so every hand-added line said "ea" forever.
  if (item.unit !== undefined) clean.unit = String(item.unit).trim().slice(0, 12) || "ea";
  if (item.unit_price !== undefined) clean.unit_price = item.unit_price || 0;
  if (Object.keys(clean).length === 0) return { ok: false, error: "Nothing to update." };
  const { data: touched, error } = await supabase
    .from("invoice_items")
    .update(clean)
    .eq("id", itemId)
    .eq("invoice_id", invoiceId) // L3: the item must belong to THIS invoice
    .select("id"); // audit v800: a zero-row write is a failure, not a quiet success
  if (error) return { ok: false, error: dbError(error) };
  if (!touched?.length) return { ok: false, error: "That line isn't on this invoice." };
  await stampInvoiceRevised(supabase, invoiceId, "updateInvoiceItem");
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  return { ok: true };
}

export async function deleteInvoiceItem(
  itemId: string,
  invoiceId: string,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const block = await requireLiveInvoice(supabase, invoiceId);
  if (block) return block; // 0269: any live bill may be corrected; void is the ending
  if (await isProtectedCreditLine(supabase, itemId)) return CREDIT_LINE_LOCKED; // unchanged by 0269
  const { data: gone, error } = await supabase
    .from("invoice_items")
    .delete()
    .eq("id", itemId)
    .eq("invoice_id", invoiceId) // L3: the item must belong to THIS invoice
    .select("id"); // audit v800: a zero-row delete is a failure, not a quiet success
  if (error) return { ok: false, error: dbError(error) };
  if (!gone?.length) return { ok: false, error: "That line isn't on this invoice." };
  // A DELETED LINE RELEASES ITS CLAIM (0255: the claim dies with the line), which is the point —
  // Erik's Smartwater comes off this bill and its receipt line is billable again. The stamp is
  // what stops that being silent on an invoice the customer is already holding.
  await stampInvoiceRevised(supabase, invoiceId, "deleteInvoiceItem");
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  return { ok: true };
}

/** The auto-calculated "less previous billings" draw credit is tamper-evident: it
 *  carries import_source:"draw_credit". Editing or deleting it would wipe the
 *  prior-billings offset and re-bill the customer for the deposit + earlier draws,
 *  so the item mutations refuse it. */
const CREDIT_LINE_LOCKED: Result = {
  ok: false,
  error:
    "That's the automatic “less previous billings” credit — it can't be edited or deleted, since it's what keeps this draw from re-billing the deposit and prior draws.",
};
// A draw's auto credit line AND its milestone line are tamper-evident: hand-editing either
// desyncs the prior-billings offset or payment_milestones. (M2 — lock milestone like draw_credit.)
async function isProtectedCreditLine(supabase: any, itemId: string): Promise<boolean> {
  const { data } = await supabase.from("invoice_items").select("import_source").eq("id", itemId).maybeSingle();
  return data?.import_source === "draw_credit" || data?.import_source === "milestone";
}

/**
 * THE LOCK COMES OFF THE LINES (Erik, 2026-09-18, migration 0269).
 *
 * This used to be `requireDraftInvoice` for every line-level write: add, edit, delete, reorder,
 * the tax rate and all four importers refused outright once an invoice left draft. The stated
 * reason was that changing them "would change a bill the customer already has" — true, and not a
 * reason to forbid it:
 *
 *   "even if i did sent it ill always need to be able to go back and make changes as per a
 *    client's request or my own review catches errors"
 *
 * One night gave two of them. A client emailed asking that a PAID invoice be reissued in the
 * property owner's name instead of the agent's. And INV-069 itself had Erik's own Smartwater
 * billed to the customer, caught on his own review. What the refusal was really guarding is
 * narrower than what it forbade — a bill changing without the customer ever learning it changed —
 * and that is a RECORD, not a lock. lib/invoice-revision.ts holds both halves: the one status
 * that is still refused, and the stamp that goes on every money change to a delivered bill.
 *
 * Void is the one ending: its lines released their claims on the job's hours and materials
 * (0255), so editing them could move work another live invoice now bills.
 */
async function requireLiveInvoice(supabase: any, invoiceId: string): Promise<Result | null> {
  const { data: inv } = await supabase.from("invoices").select("status").eq("id", invoiceId).maybeSingle();
  if (!inv) return { ok: false, error: "Invoice not found." };
  const refusal = invoiceLineEditRefusal(inv.status);
  return refusal ? { ok: false, error: refusal } : null;
}

/**
 * STILL DRAFT-ONLY, AND ON PURPOSE — the two doors that are not line edits.
 *
 * Parking (0206) is a decision about a bill that has not gone out, and re-pointing an invoice at
 * a different customer or job moves recorded payments and job costs between people. Neither is
 * "fix a line on the bill", so neither rode along when the line lock came off. Each names its own
 * way forward, because one shared sentence about locked lines is how the old refusal ended up
 * pointing at a feature that does not exist.
 */
async function requireDraftInvoice(supabase: any, invoiceId: string, refusal: string): Promise<Result | null> {
  const { data: inv } = await supabase.from("invoices").select("status").eq("id", invoiceId).maybeSingle();
  if (!inv) return { ok: false, error: "Invoice not found." };
  if (inv.status !== "draft") return { ok: false, error: refusal };
  return null;
}

const INVOICE_STATUSES = ["draft", "sent", "partial", "paid", "overdue", "void"];

/** The invoice a status change is about, with the lines that carry its claims. */
type StatusRow = {
  id: string;
  status: string;
  job_id: string | null;
  invoice_number: string | null;
  amount_paid: number | null;
  /** 0267. NULL means this bill never left the desk, whatever `status` says. */
  sent_at?: string | null;
  invoice_items: { import_source?: string | null; import_key?: string | null; source_ids?: string[] | null }[] | null;
};

/** One read, tolerant of BOTH deploy windows (a select naming a missing column fails whole): 0255's
 *  `source_ids` and 0267's `sent_at`. `sentAtKnown` says whether the answer for delivery is real or
 *  simply absent — the demotion guard below must not read a column it never got as "not sent",
 *  which would hand it the loosest possible answer at the one moment it is least sure. */
async function invoiceForStatusChange(supabase: Awaited<ReturnType<typeof createClient>>, id: string): Promise<{ row: StatusRow | null; error?: string; sentAtKnown: boolean }> {
  const read = (withClaims: boolean, withSentAt: boolean) =>
    supabase
      .from("invoices")
      .select(`id, status, job_id, invoice_number, amount_paid${withSentAt ? ", sent_at" : ""}, invoice_items(import_source, import_key${withClaims ? ", source_ids" : ""})`)
      .eq("id", id)
      .maybeSingle();
  let withClaims = true;
  let sentAtKnown = true;
  let res: { data: unknown; error: unknown | null } = await read(withClaims, sentAtKnown);
  if (res.error && isMissingColumn(res.error, "sent_at")) {
    sentAtKnown = false;
    res = await read(withClaims, sentAtKnown);
  }
  if (res.error && isMissingColumn(res.error, "source_ids")) {
    withClaims = false;
    res = await read(withClaims, sentAtKnown);
  }
  if (res.error) return { row: null, error: dbError(res.error), sentAtKnown };
  return { row: (res.data ?? null) as StatusRow | null, sentAtKnown };
}


/**
 * UN-VOID MUST NOT RESURRECT A CLAIM ANOTHER INVOICE NOW HOLDS.
 *
 * Voiding releases every row the invoice billed (claimedSourcesOnJob reads non-void only — that is
 * the whole design of 0255: the claim dies with the invoice, no tidy-up). The next invoice on the
 * job may have picked those rows up since. Flipping this one back would put the same hours and
 * bills on two live invoices — the exact double 0255 exists to end, reached through the status
 * menu instead of an importer. So the way back is closed while another non-void invoice holds
 * any of them, and the sentence names it. Nort's invoice.setStatus lands here too, so the rule
 * holds whichever door asks. Looked up by id as well as by job, so a claimant on another job (the
 * entry moved after it was billed) counts and is named with its job.
 *
 * A LABOR LINE THAT CLAIMS NOTHING IS A LEGACY LINE, and it closes the way back too. 0256 stamped
 * claims onto NON-VOID invoices only, so an invoice voided before 0255 carries labor lines with
 * empty source_ids — nothing says which entries they billed. The held-ids check below cannot see
 * a conflict for an id that was never written, which is exactly how such an invoice would walk
 * back through this guard and put its hours beside whatever the job's live invoices now bill.
 * With any other non-void invoice on the job, the only safe door is a fresh invoice (the
 * importers pull in only unclaimed rows); with none, un-voiding restores the state 0256 handles.
 */
async function unvoidConflict(supabase: Awaited<ReturnType<typeof createClient>>, inv: StatusRow): Promise<Result | null> {
  const items = inv.invoice_items ?? [];
  const mine = claimedIdsOfLines(items);
  // ANY imported line that claims nothing is a legacy line — labor, or a cost line from before
  // 0255 whose only key was bli:<line> (no bill id anywhere on it). Both walk past the held-ids
  // check the same way, so both close the way back while another invoice is live on the job.
  const legacyLabor = items.some((it) => !!it.import_source && !it.source_ids?.length && !claimedIdsOfLines([it]).length);
  if (!mine.length && !legacyLabor) return null; // hand-typed lines only: nothing on it can be on another invoice
  const claims = await claimedSourcesOnJob(supabase, inv.job_id ?? null, inv.id, mine);
  const label = inv.invoice_number ?? "this invoice";
  const Label = label.charAt(0).toUpperCase() + label.slice(1);
  if (!claims.schemaReady && claims.invoices.length) {
    return {
      ok: false,
      error: `Billing is mid-upgrade for a few minutes — ${label} can't come back from void until it's certain no other invoice bills its hours and materials. Try again shortly.`,
    };
  }
  if (legacyLabor && claims.invoices.length) {
    // Named oldest first — the job's own live invoices, any of which may now bill those hours.
    const live = joinNumbers([...claims.invoices].sort((a, b) => a.created_at.localeCompare(b.created_at)).map((i) => i.invoice_number ?? "an unnumbered invoice"));
    return {
      ok: false,
      error: `${Label} can't come back from void: it was built before an invoice's lines recorded which hours and bills they bill, so nothing can check it against ${live} — un-voiding it could bill the same work twice. Leave ${label} void and bill the work on a fresh invoice instead; New Invoice on the job pulls in only the hours and bills nobody has billed yet.`,
    };
  }
  const held = mine.filter((sid) => claims.owner.has(sid));
  if (!held.length) return null;
  // Say WHAT is held in the office's words — hours, materials, change orders, estimate lines.
  const what = new Set<string>();
  for (const it of items) {
    if (!claimedIdsOfLines([it]).some((sid) => claims.owner.has(sid))) continue;
    const src = it.import_source ?? null;
    what.add(src === "labor" ? "hours" : src === "costs" ? "materials" : src === "change_orders" ? "change orders" : src === "quote" ? "estimate lines" : "lines");
  }
  const on = joinNumbers(claimantNumbers(claims, held));
  return {
    ok: false,
    error: `${Label} can't come back from void: the ${joinNumbers([...what])} on it are already billed on ${on}, so un-voiding it would bill them twice. Void ${on} first, or leave ${label} void — the work is billed there.`,
  };
}

export async function setInvoiceStatus(
  id: string,
  status: string,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // A whitelisted status only, and never back to Draft once a bill the customer HOLDS has money
  // on it (audit v921): a draft is line-editable and off the AR list, so demoting a delivered
  // paid/partial invoice hides real revenue and lets its lines change under recorded payments.
  if (!INVOICE_STATUSES.includes(status)) return { ok: false, error: "That isn't a valid invoice status." };
  const { row: cur, error: readErr, sentAtKnown } = await invoiceForStatusChange(supabase, id);
  if (readErr) return { ok: false, error: readErr };
  if (!cur) return { ok: false, error: "Invoice not found." };
  /*
   * THE DEPOSIT WAS NOT SUPPOSED TO BE THE LOCK (Erik, INV-069, 2026-09-18).
   *
   * This guard used to read `amount_paid > 0` and nothing else. That is exactly right for an
   * invoice the customer is holding: its lines must not move under money they have already paid
   * against a document in their hands. It is exactly wrong for a draft with a deposit on it —
   * which is a workflow this app deliberately invites, since a DRAFT never auto-advances on
   * payment (invoice-math.ts paidStatus; billing/page.tsx "Payments record on DRAFTS too"). So
   * when Pay Now promoted his still-being-built $6,412 draft to 'sent' without a card ever being
   * tapped, his own $200 cash deposit became the thing that stopped him getting back to it:
   *
   *   "its not sent its in draft mode thats partially why this is confusing"
   *
   * 0267 gave the row a way to tell the two apart. Money bars the way back only when the bill
   * ACTUALLY reached the customer — sent_at, which no pay door may ever stamp.
   */
  if (status === "draft" && Number(cur.amount_paid ?? 0) > 0) {
    const label = cur.invoice_number ?? "This invoice";
    // Mid-deploy, before 0267 runs, there is no evidence either way. Hold the OLD, stricter line
    // rather than guessing "never delivered" on a money boundary, and say it is temporary.
    if (!sentAtKnown)
      return { ok: false, error: `Billing is mid-update for a few minutes - ${label} can't go back to Draft until it's certain the customer isn't already holding it. Try again shortly.` };
    if (cur.sent_at != null)
      return {
        ok: false,
        error: `${label} went out to the customer and has money on it, so it can't go back to Draft - its lines would change under a bill they already have. Void it, or use Credit / Refund in the Actions menu.`,
      };
  }
  // Leaving "void" resurrects this invoice's claims — refused while another invoice holds any.
  if (cur.status === "void" && status !== "void") {
    const back = await unvoidConflict(supabase, cur);
    if (back) return back;
  }
  // "Sent - I sent it myself" is a PERSON DECLARING THE DEED: they put the bill in the customer's
  // hands by some door this app doesn't own (printed it, handed it over, sent it from their own
  // mail). That is a delivery and it stamps, exactly as email/text/share do. Every other status
  // writes nothing here; a pay door writes nothing here ever (0267).
  //
  // AN EXISTING STAMP IS LEFT ALONE — UNLESS THE BILL HAS CHANGED SINCE (0269). "The date the
  // bill really went is the date it really went, and re-picking Sent later is not a second
  // delivery" was the whole rule until a delivered invoice could be revised. Now there is a case
  // where re-picking Sent IS a second delivery and the only one this app can be told about: the
  // office corrected a line, printed the corrected bill and handed it over again. Refusing to
  // move the date there would leave `revised_at > sent_at` true forever, and a banner that cannot
  // be cleared by doing the thing it asks for is worse than no banner.
  const redelivered = status === "sent" && sentAtKnown && !!cur.sent_at && (await hasUnsentRevision(supabase, id));
  const patch: { status: string; sent_at?: string } =
    status === "sent" && sentAtKnown && (!cur.sent_at || redelivered)
      ? { status, sent_at: new Date().toISOString() }
      : { status };
  const { data: wroteS, error } = await supabase.from("invoices").update(patch).eq("id", id).select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!wroteS?.length) return { ok: false, error: "Invoice not found." };
  // A DRAFT never auto-advances on payment (cn-v549), so a draft that was fully prepaid
  // (Jackie's Venmo before the invoice went out) leaves this call marked 'sent' and stays
  // there forever — never 'paid', permanently on the AR list. Recompute once the row is no
  // longer a draft; recalcInvoice re-derives status from total vs amount_paid.
  if (status !== "draft" && status !== "void") await recalcInvoice(supabase, id);
  // Voiding a milestone draw re-opens its milestone — the FK only auto-clears on
  // delete, not void — so "Request next payment" offers that slice again and the
  // schedule's billed-to-date stops counting a cancelled draw.
  if (status === "void") {
    const { error: mErr } = await supabase
      .from("payment_milestones")
      .update({ status: "pending", invoice_id: null, billed_amount: null })
      .eq("invoice_id", id);
    if (mErr) reportError("setInvoiceStatus.unlinkMilestone", mErr, { invoiceId: id });
  }
  revalidateMoney();
  revalidateMoney(id);
  return { ok: true };
}

/** A "YYYY-MM-DD" payment date → a stable ISO timestamp at NOON IN THE ORG'S TZ. Delegates to the tz
 *  helper so it's deterministic across deploy environments — the old bare `new Date(`${d}T12:00:00`)`
 *  had no Z, so it was parsed in the SERVER's timezone (the exact trap tz.ts exists to replace). */
function dateToIso(d: string | null | undefined, tz: string): string | undefined {
  if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return undefined;
  const t = tzLocalHourUtc(d, 12, tz);
  return isNaN(t.getTime()) ? undefined : t.toISOString();
}

/** The org's configured timezone (for stamping date-only inputs). Defaults to Pacific. */
async function orgTz(supabase: { from: (t: string) => any }): Promise<string> {
  const { data } = await supabase.from("organizations").select("settings").maybeSingle();
  return getOrgSettings((data as { settings?: unknown } | null)?.settings).timezone || "America/Los_Angeles";
}

export async function recordPayment(input: {
  invoice_id: string;
  amount: number;
  method: string;
  note: string;
  paid_at?: string | null;
}): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!input.amount || input.amount <= 0)
    return { ok: false, error: "Enter a payment amount." };
  if (input.amount > 9_999_999) return { ok: false, error: "That amount is too large." };

  // M2: confirm the invoice is visible to this org (a cross-org id returns null
  // under the org-scoped read policy) before recording a payment against it.
  const { data: inv } = await supabase
    .from("invoices")
    .select("id, org_id, invoice_number, total, amount_paid, customers(name)")
    .eq("id", input.invoice_id)
    .maybeSingle();
  if (!inv) return { ok: false, error: "Invoice not found." };

  // M4: a misheard amount ("$30k" on a $3k invoice) shouldn't silently overpay + mark paid.
  // invoiceBalance already rounds to cents AND floors at 0 — the exact cap this guard wants.
  const cap = invoiceBalance(inv.total, inv.amount_paid);
  if (input.amount > cap + 0.01) {
    return {
      ok: false,
      error: `That's more than the $${cap.toLocaleString()} balance on invoice ${inv.invoice_number}. Enter up to the balance, or fix the invoice first.`,
    };
  }

  const paidAt = dateToIso(input.paid_at, await orgTz(supabase));
  // L2: a payment can't be dated into the future (wrong tax / reporting period).
  if (paidAt && Date.parse(paidAt) > Date.now() + 86_400_000) {
    return { ok: false, error: "That payment date is in the future." };
  }
  const { error } = await supabase.from("payments").insert({
    invoice_id: input.invoice_id,
    amount: input.amount,
    // A KEY, never the chip label (0287): "Cash" and "cash" are one way of being paid.
    method: input.method?.trim() ? paymentMethodKey(input.method) : "check",
    note: input.note || null,
    recorded_by: ctx.userId,
    ...(paidAt ? { paid_at: paidAt } : {}),
  });
  if (error) return { ok: false, error: dbError(error) };

  await recalcInvoice(supabase, input.invoice_id);
  // Cash-in ping to the OTHER office staff (the recorder already knows).
  const cust = (inv as any).customers?.name as string | undefined;
  void sendPushToProfiles(
    (await orgStaffIds(inv.org_id)).filter((id) => id !== ctx.userId),
    "invoice_paid",
    {
      title: "Payment recorded",
      body: `${formatCurrency(input.amount)} on ${inv.invoice_number || "an invoice"}${cust ? ` — ${cust}` : ""}`,
      url: `/billing/${input.invoice_id}`,
    },
  );
  revalidateMoney(input.invoice_id);
  revalidateMoney();
  return { ok: true };
}

/** Edit a recorded payment (amount / method / note) and recompute the invoice. */
export async function updatePayment(
  paymentId: string,
  invoiceId: string,
  patch: { amount: number; method: string; note: string; paid_at?: string | null },
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!patch.amount || patch.amount <= 0) return { ok: false, error: "Enter a payment amount." };
  if (patch.amount > 9_999_999) return { ok: false, error: "That amount is too large." };
  // EDIT must obey the same two rules as recording (M4 overpay cap, L2 future date) — an
  // edit is just a second way to write the same number, and the typo it fixes is as likely
  // as the typo it introduces. Cap against the balance the OTHER payments leave, i.e. the
  // current balance plus whatever this payment is contributing today.
  const [{ data: inv }, { data: cur }] = await Promise.all([
    supabase.from("invoices").select("total, amount_paid, invoice_number").eq("id", invoiceId).maybeSingle(),
    // Read the payment WITH its invoice_id + stripe link so we can prove it belongs here (audit v921).
    supabase.from("payments").select("amount, invoice_id, stripe_payment_intent").eq("id", paymentId).maybeSingle(),
  ]);
  if (!inv) return { ok: false, error: "Invoice not found." };
  if (!cur || (cur as { invoice_id?: string }).invoice_id !== invoiceId) {
    return { ok: false, error: "That payment isn't on this invoice." };
  }
  if ((cur as { stripe_payment_intent?: string | null }).stripe_payment_intent) {
    return { ok: false, error: "This is an online card payment — adjust it in Stripe (refund), not here." };
  }
  const cap =
    invoiceBalance((inv as any).total, (inv as any).amount_paid) + Number((cur as any)?.amount ?? 0);
  if (patch.amount > cap + 0.01) {
    return {
      ok: false,
      error: `That's more than the $${cap.toLocaleString()} this invoice can take. Enter up to that, or fix the invoice first.`,
    };
  }
  const paidAt = dateToIso(patch.paid_at, await orgTz(supabase));
  if (paidAt && Date.parse(paidAt) > Date.now() + 86_400_000) {
    return { ok: false, error: "That payment date is in the future." };
  }
  const { data: updP, error } = await supabase
    .from("payments")
    .update({
      amount: patch.amount,
      method: patch.method?.trim() ? paymentMethodKey(patch.method) : "check",
      note: patch.note || null,
      ...(paidAt ? { paid_at: paidAt } : {}),
    })
    .eq("id", paymentId)
    .eq("invoice_id", invoiceId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!updP?.length) return { ok: false, error: "That payment isn't on this invoice." };
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  revalidateMoney();
  return { ok: true };
}

/** Remove a recorded payment (typo'd entry etc.) and recompute the invoice. */
export async function deletePayment(paymentId: string, invoiceId: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // An ONLINE card payment must not be deleted like a mistyped check (audit v921): deleting it
  // reopens the balance for a SECOND charge and severs refund/dispute matching (the stripe intent
  // is the only key charge.refunded can match on). Refund it in Stripe instead.
  const { data: pay } = await supabase
    .from("payments")
    .select("id, invoice_id, stripe_payment_intent")
    .eq("id", paymentId)
    .maybeSingle();
  if (!pay || (pay as { invoice_id?: string }).invoice_id !== invoiceId) {
    return { ok: false, error: "That payment isn't on this invoice." };
  }
  if ((pay as { stripe_payment_intent?: string | null }).stripe_payment_intent) {
    return { ok: false, error: "This was paid online by card — refund it in Stripe rather than deleting it here." };
  }
  const { data: del, error } = await supabase
    .from("payments")
    .delete()
    .eq("id", paymentId)
    .eq("invoice_id", invoiceId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!del?.length) return { ok: false, error: "That payment isn't on this invoice." };
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  revalidateMoney();
  return { ok: true };
}

/** Delete an invoice — only while it is still a DRAFT and no payments are
 *  recorded against it (a sent bill is the customer's; void those instead). */
export async function deleteInvoice(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  /**
   * DELETING A SENT INVOICE IS A SILENT RE-BILL.
   *
   * Every line-level mutation on this file goes through a status gate (requireLiveInvoice since
   * 0269); delete checked only for payments, and the Actions menu offers it at every status. And
   * delete is the one act 0269 changes nothing about — a bill the customer holds may be CORRECTED
   * now, but it may still never vanish, because a document in someone's hands with no row behind
   * it is exactly what the record is for. So a sent, unpaid
   * INV-061 could be deleted outright — and its lines carried the claims on the hours and
   * materials it billed (0255/0258). The delete cascade took the claims with it, those rows
   * read as unbilled again, and the next New Invoice on the job charged the customer for the
   * same work a second time. The document the customer is holding left the books with nothing
   * recorded. Void is the ending for a sent invoice: the number and the history stay, and the
   * claims are released on purpose, where someone can see it happened.
   */
  const { data: inv, error: invErr } = await supabase
    .from("invoices")
    .select("status")
    .eq("id", id)
    .maybeSingle();
  if (invErr) return { ok: false, error: dbError(invErr) };
  if (!inv) return { ok: false, error: "Invoice not found." };
  if (inv.status === "void") {
    // Already ended the right way. Say that plainly rather than pointing at Void again.
    return {
      ok: false,
      error: "This invoice is void, which is the record that it was cancelled. It bills nothing and holds nothing, so it stays on the books.",
    };
  }
  if (inv.status !== "draft") {
    return {
      ok: false,
      error:
        "This invoice has already been sent, so it can't be deleted. Mark it void instead: that keeps the record and releases the hours and materials it billed.",
    };
  }

  const { count, error: countErr } = await supabase
    .from("payments")
    .select("id", { count: "exact", head: true })
    .eq("invoice_id", id);
  // FAIL CLOSED (audit 8): a transient error made `count` undefined, the guard fell through,
  // and the CASCADE took the payment rows with the invoice — the money simply vanished from
  // the books with nothing to reconcile against.
  if (countErr) return { ok: false, error: dbError(countErr) };
  if (count && count > 0) {
    return { ok: false, error: "This invoice has recorded payments — delete those first or mark the invoice void." };
  }
  // Keep the milestone reset symmetric with void: the FK nulls invoice_id on delete,
  // but clear the status/snapshot too so no stale 'billed' row lingers.
  await supabase
    .from("payment_milestones")
    .update({ status: "pending", billed_amount: null })
    .eq("invoice_id", id);
  // The silent-write law on the last act a document ever takes: a zero-row delete is a 204, and
  // reporting ok on one sends the office back to a list that still has the invoice in it.
  // AND THE DELETE CARRIES THE RULE IT WAS CHECKED AGAINST. Reading `status` and then deleting by
  // id alone is the same check-then-write shape the claim trigger was just fixed for: between the
  // read above and this line another tab can send the invoice, and the delete would take a SENT
  // document and its claims with it — the very thing the draft gate exists to stop. `.eq("status",
  // "draft")` makes the database do the checking, so a lost race deletes nothing and says so.
  const { data: gone, error } = await supabase
    .from("invoices")
    .delete()
    .eq("id", id)
    .eq("status", "draft")
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!gone?.length) {
    return {
      ok: false,
      error:
        "That invoice didn't delete — it was sent or voided while you were deleting it, or you don't have access. Reload the invoice to see where it stands.",
    };
  }
  revalidateMoney();
  return { ok: true };
}

/** Set the invoice tax rate (percent in → stored as decimal) and recompute. */
export async function setInvoiceTaxRate(
  invoiceId: string,
  ratePercent: number,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // THE ONE MONEY MUTATION THAT HAD NO LOCK AT ALL (audit 8): every item edit and importer had
  // one, but the tax dropdown stayed live — so a mis-tap on a PAID invoice silently re-totalled
  // it, flipped it back to partial, and put a different number on the document the customer
  // already holds. SILENTLY is the word that mattered, and 0269 is what fixes it: the rate may
  // move on a live bill (a job billed at the wrong county rate is an ordinary correction), and
  // the change goes on the record where the office and the page can both see it.
  const block = await requireLiveInvoice(supabase, invoiceId);
  if (block) return block;
  const rate = Number.isFinite(ratePercent) ? ratePercent / 100 : 0;
  const { data: wrote, error } = await supabase.from("invoices").update({ tax_rate: rate }).eq("id", invoiceId).select("id");
  if (error) return { ok: false, error: dbError(error) };
  // Silent-write law: a zero-row UPDATE is a 204. This one never checked, so an RLS refusal here
  // reported a new tax rate the row never took — and the recalc below then said the old total
  // was correct, which reads as the app arguing with itself.
  if (!wrote?.length) return { ok: false, error: "That didn't save - check your access and try again." };
  await stampInvoiceRevised(supabase, invoiceId, "setInvoiceTaxRate");
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  return { ok: true };
}

/** Edit the invoice's description (the scope shown above the line items). */
export async function setInvoiceDescription(
  invoiceId: string,
  description: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  /**
   * THE SCOPE BLOCK IS ON THE CUSTOMER'S PAPER, SO IT IS A REVISION (cn-v967).
   *
   * 0269 traded the draft lock for a record: `revised_at > sent_at` is how the page says "the
   * customer is holding an older bill than this one". Nine line-level money writes stamp it. These
   * three - scope, title, due date - did not, and they are the three that change what the document
   * SAYS. Rewrite the scope on a delivered INV-071 and the shared /i link serves the new wording
   * the instant it saves while the homeowner's saved PDF still says the old one, with no banner, no
   * "Sent Again", and nothing anywhere recording that it changed. That is the exact sentence 0269
   * exists to prevent, arriving through a door the stamp was never wired to.
   *
   * The `.select("id")` is not decoration: it is what makes the stamp follow a write that actually
   * landed. A zero-row UPDATE is a 204, and an RLS refusal here used to report a saved scope the
   * row never took.
   */
  const { data: wrote, error } = await supabase
    .from("invoices")
    .update({ description: description.trim() || null })
    .eq("id", invoiceId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!wrote?.length) return { ok: false, error: "That didn't save - check your access and try again." };
  await stampInvoiceRevised(supabase, invoiceId, "setInvoiceDescription");
  // The description IS the scope block above the line items on the customer's document
  // (invoice-document.tsx), and the stored PDF only ever drops on an explicit bust — so
  // editing the scope on a SENT invoice left /i showing the new wording while Download PDF
  // kept serving the old one (audit v921; same reason as the title/due-date busts above).
  await bustDocPdf("invoice", invoiceId);
  revalidateMoney(invoiceId);
  return { ok: true };
}

/** Edit the invoice's title (the short label shown in the header / lists). */
export async function setInvoiceTitle(
  invoiceId: string,
  title: string,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  // Same door, same law as setInvoiceDescription above: the title prints on the customer's
  // document, so changing it after delivery is a revision and goes on the record.
  const { data: wrote, error } = await supabase
    .from("invoices")
    .update({ title: title.trim() || null })
    .eq("id", invoiceId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!wrote?.length) return { ok: false, error: "That didn't save - check your access and try again." };
  await stampInvoiceRevised(supabase, invoiceId, "setInvoiceTitle");
  await bustDocPdf("invoice", invoiceId); // the title renders on the PDF (audit 7)
  revalidateMoney(invoiceId);
  revalidateMoney();
  return { ok: true };
}

/** Set (or clear) the invoice due date — the field the Overdue tracker reads.
 *  Stamps a "YYYY-MM-DD" input to noon in the org tz, same as payment dates. */
export async function setInvoiceDueDate(
  invoiceId: string,
  date: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const dueDate = date ? dateToIso(date, await orgTz(supabase)) ?? null : null;
  // Same law again, and this one moves money's DEADLINE: pulling a delivered invoice's due date
  // from the 30th to the 15th starts the Overdue tracker chasing a customer whose copy still says
  // the 30th. A record, not a lock - 0269's whole shape.
  const { data: wrote, error } = await supabase
    .from("invoices")
    .update({ due_date: dueDate })
    .eq("id", invoiceId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!wrote?.length) return { ok: false, error: "That didn't save - check your access and try again." };
  await stampInvoiceRevised(supabase, invoiceId, "setInvoiceDueDate");
  await bustDocPdf("invoice", invoiceId); // the due date renders on the PDF (audit 7)
  revalidateMoney(invoiceId);
  revalidateMoney();
  return { ok: true };
}

/** Correct the customer/job link on a DRAFT invoice. Draft-only: once sent, the
 *  billing relationship is locked (a draw job is also blocked — its draw is itemized
 *  at creation). Any chosen ids must be visible to this org (RLS filters the lookup,
 *  so an id from another tenant resolves to null and is rejected).
 *  PATCH semantics: only the keys the caller sent are written — an omitted link is
 *  left alone (it used to unlink BOTH); an explicit null clears it. */
export async function setInvoiceCustomerJob(
  invoiceId: string,
  link: { customer_id?: string | null; job_id?: string | null },
): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (link.customer_id === undefined && link.job_id === undefined)
    return { ok: false, error: "Nothing to update." };

  // Header edits to the billing relationship are only safe while it's a draft — and unlike the
  // LINES (0269), this one stayed shut. Re-pointing a delivered invoice moves its recorded
  // payments and its job costs onto a different customer or job, which is a different act from
  // correcting what the bill says.
  const draftBlock = await requireDraftInvoice(
    supabase,
    invoiceId,
    "This invoice has already gone out, so it can't be moved to a different customer or job - its payments and job costs are recorded against the ones it has. Its lines and totals can still be edited; to bill someone else, start a new invoice.",
  );
  if (draftBlock) return draftBlock;

  // H4: don't re-point a draft onto a job already on the draw path.
  const drawBlock = await blockStandardCreateOnDrawJob(supabase, link.job_id ?? null);
  if (drawBlock) return drawBlock;

  const clean: Record<string, unknown> = {};

  // Validate any chosen ids are visible to this org (RLS scopes the read).
  let customerId = link.customer_id || null;
  const jobId = link.job_id || null;
  if (jobId) {
    const { data: job } = await supabase
      .from("jobs")
      .select("id, customer_id")
      .eq("id", jobId)
      .maybeSingle();
    if (!job) return { ok: false, error: "That job isn't available." };
    // Keep the invoice attached to the job's customer so revenue/costs roll up.
    if (!customerId) customerId = job.customer_id ?? null;
  }
  if (customerId) {
    const { data: cust } = await supabase
      .from("customers")
      .select("id")
      .eq("id", customerId)
      .maybeSingle();
    if (!cust) return { ok: false, error: "That customer isn't available." };
  }
  if (link.job_id !== undefined) clean.job_id = jobId;
  // The customer also moves when a re-pointed job carries its own customer along.
  if (link.customer_id !== undefined || (jobId && customerId)) clean.customer_id = customerId;

  // Grab the OLD job first so re-pointing the invoice refreshes BOTH job pages — else the
  // old job keeps showing the moved invoice in its billing/financials.
  const { data: prevInv } = await supabase.from("invoices").select("job_id").eq("id", invoiceId).maybeSingle();
  const oldJobId = (prevInv as { job_id: string | null } | null)?.job_id ?? null;

  // THE CLASS, NOT THE INSTANCE (cn-v967): this was the fourth `invoices` update in this file with
  // no `.select("id")`. It is draft-only so there is no revision to stamp, but the silent-write law
  // holds all the same - re-pointing an invoice at a customer RLS won't let this person touch would
  // return ok and the page would redraw the old link, the app arguing with itself.
  const { data: wrote, error } = await supabase
    .from("invoices")
    .update(clean)
    .eq("id", invoiceId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!wrote?.length) return { ok: false, error: "That didn't save - check your access and try again." };
  revalidateMoney(invoiceId);
  for (const jid of new Set([oldJobId, jobId].filter(Boolean) as string[])) revalidatePath(`/jobs/${jid}`);
  return { ok: true };
}

/* recalcInvoice now lives in @/lib/invoice-recalc (imported above) — the Stripe webhook
 * is a route handler and can't import a private helper out of a "use server" module, so
 * it carried a second, credit-blind copy of the amount_paid math. One definition now. */

/**
 * DONE & PAID — the whole critical path in one motion.
 *
 * Erik, the finding this exists for: "Nora & Fermin, i was there for an hour and some change they
 * paid me 150 cash and i was out — and from the lead or calendar i had to go through the ringer of
 * step to even get to anything useful and i gave up... i had to fill out the inspection to then
 * have to fill out the estimate to then find the invoice somewhere to then mark done and then
 * input the payment."
 *
 * Five artifacts demanded for a job that was ALREADY DONE with cash ALREADY IN HAND. Every one of
 * those stages exists for work that hasn't happened yet — an inspection informs an estimate, an
 * estimate seeks a yes — and the yes was in his pocket. Forcing the pipeline backwards through
 * finished work is exactly "the way the rest of the softwares are", the thing this app exists not
 * to be.
 *
 * So: one action, from the record he is already looking at. It composes the EXISTING writers
 * rather than inventing a parallel money path (ONE BILLING PATH):
 *
 *   invoice (the same shape createBlankInvoice writes)
 *   → one line for the work
 *   → recalcInvoice        (totals from the one math)
 *   → status "sent"        (paidStatus REFUSES to advance a draft — deliberate, Erik 7/24; this
 *                           invoice has genuinely left draft: the work is delivered and settled)
 *   → recordPayment        (the exported action — balance cap, org check, cash-in push, recalc
 *                           to "paid" — all inherited, not copied)
 *   → the visit marked completed, the lead stamped WON via the same customer-minting rule the
 *     accepted-estimate path uses. Cash in hand is the hardest possible win.
 *
 * Partial failure is reported honestly: once the invoice exists, later stumbles return its id and
 * say exactly what is left to do — never a bare error that hides the money record it created.
 */
export async function settleUp(input: {
  source: "appointment" | "job";
  id: string;
  amount: number;
  method: string; // a payment-method key or label; recordPayment normalizes
  note?: string;
  /** "record" (default) books the payment here and now — cash in hand. "later" builds and sends
   *  the invoice and completes the visit but leaves the balance open: the Venmo QR or the Stripe
   *  checkout on the customer's phone is about to settle it, and recording it twice would be the
   *  double-payment this action exists to prevent. */
  collect?: "record" | "later";
  /** The person said yes to "Send INV-0xx as the bill first?" (a card on the job's open draft). */
  sendIt?: boolean;
}): Promise<Result & { invoiceId?: string; needsSend?: true; invoiceNumber?: string | null }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const amount = Number(input.amount);
  // "later" with no amount is Pay Now's card door: it lands on a bill that already says what is
  // owed, and only a bill it has to WRITE needs a figure (asked again just before minting).
  const noFigure = input.collect === "later" && (!Number.isFinite(amount) || amount <= 0);
  if (!noFigure && (!Number.isFinite(amount) || amount <= 0)) return { ok: false, error: "Enter what they paid." };
  if (amount > 9_999_999) return { ok: false, error: "That amount is too large." };

  // ── What was the work, and who pays for it ─────────────────────────────────────────────────
  let title = "";
  let jobId: string | null = null;
  let customerId: string | null = null;
  let inquiryId: string | null = null;
  let apptId: string | null = null;

  if (input.source === "appointment") {
    const { data: a } = await supabase
      .from("appointments")
      .select("id, title, status, customer_id, inquiry_id, job_id")
      .eq("id", input.id)
      .maybeSingle();
    if (!a) return { ok: false, error: "That visit isn't available." };
    if (a.status === "cancelled") return { ok: false, error: "This visit was cancelled — un-cancel it first." };
    apptId = a.id;
    title = String(a.title ?? "Work completed");
    jobId = a.job_id ?? null;
    customerId = a.customer_id ?? null;
    inquiryId = a.inquiry_id ?? null;
  } else {
    const { data: j } = await supabase
      .from("jobs")
      .select("id, name, job_number, customer_id, inquiry_id")
      .eq("id", input.id)
      .maybeSingle();
    if (!j) return { ok: false, error: "That job isn't available." };
    jobId = j.id;
    title = String(j.name ?? j.job_number ?? "Work completed");
    customerId = j.customer_id ?? null;
    inquiryId = j.inquiry_id ?? null;
  }

  /* TAPPED TWICE IS SETTLED ONCE — BUT ONLY WHEN IT ACTUALLY SETTLED.
     The audit's worst finding lived here: this guard used to bare-return ok on ANY live anchored
     invoice, and the button toasts "Paid — Done" on ok. So the real sequence — show the Venmo QR
     (collect "later", invoice sent, balance open), customer never pays, hands cash days later, tap
     Pay now → cash — announced success and recorded NOTHING: cash in the pocket, an open invoice
     aging into overdue, and a customer who paid getting dunned. Same shape after any partial
     failure between the insert and the payment.
     The honest rule: an existing invoice short-circuits only when its balance is already zero.
     Otherwise the collection lands ON that invoice — the second tap becomes the payment it is —
     and the visit gets the completed stamp the first, interrupted call never wrote. */
  const settleExisting = async (
    invoiceId: string,
    total: number,
    amountPaid: number,
  ): Promise<Result & { invoiceId?: string }> => {
    const balance = invoiceBalance(total, amountPaid);
    if (balance > 0.005 && input.collect !== "later") {
      const paid = await recordPayment({
        invoice_id: invoiceId,
        // Never overpay the existing bill from a re-tap — its cap would refuse and the money
        // would bounce; the collection is whatever is actually still owed, up to what they gave.
        amount: Math.min(amount, balance),
        method: input.method || "cash",
        note: input.note?.trim() || "",
      });
      if (!paid.ok) return { ok: false, invoiceId, error: paid.error ?? "The payment didn't record — try it from the invoice." };
    }
    if (apptId) {
      await supabase
        .from("appointments")
        .update({ status: "completed", updated_at: new Date().toISOString() })
        .eq("id", apptId)
        .in("status", ["scheduled", "proposed"]);
      revalidatePath("/schedule");
      revalidatePath("/planner");
      revalidatePath(`/appointments/${apptId}`);
    }
    revalidateMoney(invoiceId);
    revalidateMoney();
    return { ok: true, invoiceId };
  };

  /**
   * THE SAME TAP, TWICE, IS ONE PAYMENT (review of Connected North Phase 1).
   *
   * A payment that LANDS on a bill that already existed (the job's open INV-074, a visit's bill)
   * is invisible to the five-minute same-total check below, which only finds a bill this tap
   * minted. And the sheet turns any lost answer into "check your connection and try again": on
   * truck LTE the first tap lands $624.49 on INV-074, the answer never arrives, the tech taps again
   * - and INV-074, now paid, is no longer open, so the retry MINTED a second $624.49 bill and
   * recorded the cash twice (or, for a $300 part payment, put $300 on INV-074 twice).
   * So before any money is written: the same person, the same amount, the same way of paying, on
   * one of these bills in the last five minutes, is this tap already done - answered as done, and
   * nothing is written. A genuine second identical payment inside five minutes is recorded from
   * the invoice itself. A lost read is not "no payment": refuse, nothing written.
   */
  const sameTap = async (invoiceIds: string[]): Promise<{ invoiceId: string } | { error: string } | null> => {
    if (noFigure || input.collect === "later" || !invoiceIds.length) return null;
    const raw = input.method || "cash";
    const { data, error } = await supabase
      .from("payments")
      .select("id, invoice_id")
      .in("invoice_id", invoiceIds)
      .eq("amount", amount)
      .eq("method", raw.trim() ? paymentMethodKey(raw) : "check") // as recordPayment stores it
      .eq("recorded_by", ctx.userId)
      .is("stripe_payment_intent", null)
      .gte("created_at", new Date(Date.now() - 5 * 60_000).toISOString())
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return { error: "Couldn't check this job's payments just now, so nothing was recorded. Try again in a moment." };
    return data ? { invoiceId: String((data as { invoice_id: string }).invoice_id) } : null;
  };
  const alreadyDone = (invoiceId: string): Result & { invoiceId?: string } => {
    revalidateMoney(invoiceId);
    revalidateMoney();
    return { ok: true, invoiceId };
  };

  if (apptId) {
    const { data: existing } = await supabase
      .from("invoices")
      .select("id, total, amount_paid")
      .eq("appointment_id", apptId)
      .neq("status", "void")
      .limit(1)
      .maybeSingle();
    if (existing) {
      const tap = await sameTap([existing.id]);
      if (tap && "error" in tap) return { ok: false, error: tap.error };
      if (tap) return alreadyDone(tap.invoiceId);
      return settleExisting(existing.id, Number(existing.total ?? 0), Number(existing.amount_paid ?? 0));
    }
  } else if (jobId) {
    /**
     * THE JOB'S OPEN BILL IS THE DOOR (Connected North Phase 1; J-052, J-028).
     *
     * This used to look only for a same-total bill minted in the last five minutes (a re-tap), and
     * otherwise wrote a NEW one-line invoice for whatever was typed - beside INV-074, sent and open
     * for $624.49, so the customer would owe the same work twice. Now the job's one open bill takes
     * the payment (jobBillForPayment); two are named and the person picks; a card on a DRAFT, or a
     * payment that pays all of one, asks "Send INV-0xx as the bill first?" and sends it properly
     * only on the yes (a deposit on a draft just lands). With no open bill at
     * all, the settle-up bill is written as before. A lost read is not "no bill": refuse, nothing
     * written.
     */
    // TAPPED TWICE IS SETTLED ONCE: the settle-up bill this same tap wrote a moment ago is already
    // paid (so not "open" below) - find it first, and its zero balance ends the re-tap there.
    if (!noFigure) {
      const { data: recent } = await supabase
        .from("invoices")
        .select("id, created_at, total, amount_paid")
        .eq("job_id", jobId)
        .eq("total", amount)
        .is("appointment_id", null) // never trip on another visit's settle-up bill
        .neq("status", "void")
        .neq("status", "draft") // a coincidental same-total DRAFT from another door is not this tap
        .gte("created_at", new Date(Date.now() - 5 * 60_000).toISOString())
        .limit(1)
        .maybeSingle();
      if (recent) return settleExisting(recent.id, Number(recent.total ?? 0), Number(recent.amount_paid ?? 0));
    }
    const { data: jobBills, error: billsErr } = await supabase
      .from("invoices")
      .select("id, invoice_number, status, total, amount_paid")
      .eq("job_id", jobId)
      .neq("status", "void")
      .order("created_at", { ascending: true });
    if (billsErr) return { ok: false, error: "Couldn't read this job's bills just now, so nothing was recorded. Try again in a moment." };
    // Before the choice, so a retry of a payment that PAID the bill off never falls through to "no
    // open bill" and mints a second one.
    const tap = await sameTap((jobBills ?? []).map((b) => String(b.id)));
    if (tap && "error" in tap) return { ok: false, error: tap.error };
    if (tap) return alreadyDone(tap.invoiceId);
    const choice = jobBillForPayment((jobBills ?? []) as JobBillRow[], {
      card: paymentMethodKey(input.method || "") === "card",
      amount: noFigure ? null : amount,
    });
    if (choice.kind === "ambiguous") {
      return {
        ok: false,
        error: `This job has ${choice.bills.length} open bills: ${choice.bills.map((b) => `${b.number} (${formatCurrency(b.balance)} left)`).join(", ")}. Take the payment from the bill they're paying, on the job's Invoices tab.`,
      };
    }
    if (choice.kind === "needsSend" || choice.kind === "land") {
      const bill = choice.bill;
      const label = bill.invoice_number ?? "The job's open bill";
      // Before the question, never after the yes: a send can't be taken back, so a payment that
      // can't land is refused while nothing has moved.
      if (input.collect !== "later" && amount > choice.balance + 0.005) {
        // Never cap it silently: the difference would vanish from the record.
        return {
          ok: false,
          invoiceId: bill.id,
          error: `${label} has ${formatCurrency(choice.balance)} left, less than the ${formatCurrency(amount)} they paid. Record ${formatCurrency(choice.balance)} on ${label}, then put the rest on a new invoice.`,
        };
      }
      if (choice.kind === "needsSend" && !input.sendIt) {
        return { ...needsSendRefusal(choice.bill.invoice_number), invoiceId: choice.bill.id };
      }
      if (choice.kind === "needsSend") {
        const sent = await sendDraftForPayment(supabase, bill.id);
        if (!sent.ok) return { ok: false, invoiceId: bill.id, error: sent.error };
      }
      return settleExisting(bill.id, Number(bill.total ?? 0), Number(bill.amount_paid ?? 0));
    }
  }
  // Pay Now's card door with no figure lands only on a bill that exists; there is none to land on.
  if (noFigure) {
    return {
      ok: false,
      error: "There's no open bill here to pay by card yet. Record Payment writes one for what they paid, or make the invoice first and take the card from it.",
    };
  }

  // A job on the draw path is billed by draws — same guard as every standard-invoice creator.
  const drawBlock = await blockStandardCreateOnDrawJob(supabase, jobId);
  if (drawBlock) return drawBlock;

  // Getting PAID is the win, so the lead's contact materializes here — through the ONE rule the
  // accepted-estimate path uses (dedup by the CRM's keys, the person's address not the site's,
  // lead stamped won). Best-effort: a contact-less invoice still records the money.
  if (!customerId && inquiryId) {
    customerId = await customerForInquiry(supabase, inquiryId, ctx.userId);
  }

  // ── The invoice, its one line, its real totals ─────────────────────────────────────────────
  const { data: inv, error: invErr } = await supabase
    .from("invoices")
    .insert({
      customer_id: customerId,
      job_id: jobId,
      title,
      description: input.note?.trim() || null,
      tax_rate: 0, // a flat settled amount — what they paid is what the record says
      appointment_id: apptId, // 0233: the anchor — idempotency AND "was this visit billed?"
      due_date: await defaultDueDateIso(supabase),
      status: "draft",
      created_by: ctx.userId,
    })
    .select("id, invoice_number")
    .single();
  if (invErr || !inv) {
    /* THE 0233 INDEX DID ITS JOB. Two taps on flaky truck LTE both pass the existence check
       above; the loser's insert trips invoices_one_per_appointment — and the loser is holding
       the SAME cash. Reroute it onto the winner's bill instead of surfacing "something with
       that value already exists", which points at a user mistake that doesn't exist.
       apptId-only: a 23505 on the job path is a number collision, and dbError's retry
       sentence is already right for that. */
    if ((invErr as { code?: string } | null)?.code === "23505" && apptId) {
      const { data: won } = await supabase
        .from("invoices")
        .select("id, total, amount_paid")
        .eq("appointment_id", apptId)
        .neq("status", "void")
        .limit(1)
        .maybeSingle();
      if (won) return settleExisting(won.id, Number(won.total ?? 0), Number(won.amount_paid ?? 0));
    }
    return { ok: false, error: dbError(invErr) };
  }

  const { error: itemErr } = await supabase.from("invoice_items").insert({
    invoice_id: inv.id,
    description: title,
    quantity: 1,
    unit: "EA",
    unit_price: amount,
    sort_order: 0,
  });
  if (itemErr) {
    return { ok: false, invoiceId: inv.id, error: `The invoice was created but its line didn't save — open it and add one. (${dbError(itemErr)})` };
  }
  await recalcInvoice(supabase, inv.id);

  // Sent, not draft: paidStatus deliberately never advances a DRAFT (a prepayment must not lock
  // an unsent bill's lines) — but this bill has left draft in the real world: delivered, settled,
  // on the doorstep. Without this step the payment below would record and the invoice would sit
  // "draft" forever, never reading as paid anywhere.
  //
  // AND IT STAMPS (0267), which is a judgement call worth writing down. 0267 lists the delivery
  // doors as email, text, share and the manual "I sent it myself"; settle-up is not on that list
  // because it was not in front of anyone when the list was written. It belongs there: a person
  // stood at the customer's door, handed over the bill and took the money. Leaving it unstamped
  // would say this invoice "never left the desk", which is false — and would let the new demotion
  // guard walk a fully-paid settle-up back to Draft and edit its lines under recorded cash, a
  // door that has never been open. It would also make every future settle-up disagree with every
  // past one, since 0267's backfill stamped every invoice that ever reached paid/partial.
  //
  // Not fatal if it misses: the money below is the point, and the office can see the badge. But
  // it is on the record rather than silent.
  const settleSent = await markInvoiceSent(supabase, inv.id);
  if (!settleSent.ok) reportError("settleUp.markSent", new Error(settleSent.error ?? "status write did not land"), { invoiceId: inv.id });

  // The one payment path — balance cap, org check, recalc-to-paid, cash-in push all inherited.
  // "later" leaves the balance open on purpose: Venmo/Stripe settles it in the customer's hands.
  if (input.collect !== "later") {
    const paid = await recordPayment({
      invoice_id: inv.id,
      amount,
      method: input.method || "cash",
      note: input.note?.trim() || "",
    });
    if (!paid.ok) {
      return { ok: false, invoiceId: inv.id, error: `The invoice was created but the payment didn't record — ${paid.error ?? "try it from the invoice."}` };
    }
  }

  // The deed happened; the calendar should say so. Guarded to live statuses so a completed visit
  // isn't re-stamped and a cancelled one can't be resurrected by a money write.
  if (apptId) {
    await supabase
      .from("appointments")
      .update({ status: "completed", updated_at: new Date().toISOString() })
      .eq("id", apptId)
      .in("status", ["scheduled", "proposed"]);
    revalidatePath("/schedule");
    revalidatePath("/planner");
    revalidatePath("/inspections");
    revalidatePath(`/appointments/${apptId}`);
  }
  revalidateMoney(inv.id);
  revalidateMoney();
  return { ok: true, invoiceId: inv.id };
}

/**
 * WHAT TO PUT IN FRONT OF THE CUSTOMER, RIGHT NOW.
 *
 * Erik: "a pay now button is what we are missing and that can trigger the cc processing or if i
 * choose the others like cash then it closes, if i choose venmo then it gives me my venmo qr to
 * show the customer on the spot."
 *
 * This builds the on-the-spot artifacts for one invoice:
 *   CARD  → a QR of the invoice's own /api/pay/<token> door — the customer scans it and lands in
 *           Stripe Checkout ON THEIR PHONE (card, Apple Pay, Google Pay), and the webhook records
 *           the payment itself. Nothing to type, nothing to trust to memory.
 *   VENMO → a QR of the org's Venmo pay link with the amount and invoice number filled in. Venmo
 *           can't tell the app when it lands, so the button beside the QR records it by hand.
 *
 * QRs are data URLs (the same `qrcode` the share door uses) — nothing external, works offline
 * once rendered, which matters in a driveway with one bar of LTE.
 */
/**
 * THE WATCH behind the card control screen. Stripe's webhook writes the payment; the screen only
 * needs to know when. One narrow read the tech's own session can make — no service client,
 * nothing written — so Pay Now can poll it every few seconds while the QR is up and flip to
 * "Paid" the moment the money lands, instead of someone refreshing the page to find out.
 */
export async function invoiceCollectStatus(invoiceId: string): Promise<{
  ok: boolean;
  error?: string;
  total?: number;
  amountPaid?: number;
  status?: string;
}> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { data } = await ctx.supabase
    .from("invoices")
    .select("total, amount_paid, status")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!data) return { ok: false, error: "Invoice not found." };
  return { ok: true, total: Number(data.total ?? 0), amountPaid: Number(data.amount_paid ?? 0), status: String(data.status ?? "") };
}

export async function collectArtifacts(invoiceId: string, collectAmount?: number, opts?: { sendIt?: boolean }): Promise<{
  ok: boolean;
  error?: string;
  /** The invoice is a draft and no one has said to send it: nothing was built or written. The
   *  sheet asks "Send INV-078 as the bill first?" and calls again with `sendIt` on the yes. */
  needsSend?: true;
  balance?: number;
  invoiceNumber?: string | null;
  /** Stripe door — present only when the org can actually accept card payments. */
  payQr?: string;
  payUrl?: string;
  /** The customer's invoice page (/i/<token>/<place>): the receipt link after a tap. */
  invoiceUrl?: string;
  /** Venmo door — present only when Settings carries a handle. */
  venmoQr?: string;
  venmoHandle?: string;
}> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: inv } = await supabase
    .from("invoices")
    .select("id, invoice_number, status, total, amount_paid, public_token, org_id, jobs(address), customers(address)")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv) return { ok: false, error: "Invoice not found." };

  // A PAY DOOR ON A DRAFT IS A DOOR ONTO A WALL (Erik 2026-09-10, INV-064). The appointment/job
  // sources reach here through settleUp, which SENDS the invoice first; the invoice source did
  // not — so Pay Now on a still-draft invoice built a QR to /api/pay, which redirects drafts to
  // the read-only view, and the customer scanned their way to a page with no Pay button. Putting
  // a bill in front of a customer IS sending it: promote here, checked (a zero-row update would
  // mean the door is still shut, and saying so beats a QR that fails on someone else's phone).
  //
  // AND IT IS A REAL DELIVERY, SO IT STAMPS (INV-069, 2026-09-18). This one goes through
  // markInvoiceSent rather than writing the status by hand, for two reasons the review of this
  // wave caught the hard way. First, sent_at: the demotion guard below now refuses a return to
  // Draft only for a bill that actually reached the customer, so a QR promotion that skipped the
  // stamp would have left a card-paid invoice walking back to Draft — a money boundary this wave
  // would have OPENED while closing another. A QR held up to someone's phone is the same deed as
  // texting them the link; it stamps. Second, the recalc and the revalidate underneath: without
  // them this door reproduced INV-069 exactly — a draft carrying a deposit flipped to 'sent'
  // (where paidStatus says 'partial') while the open page kept its draft props and went on
  // offering controls the server had just locked.
  //
  // AND ONLY ON A PERSON'S YES (Connected North Phase 1). Opening the Pay Now sheet on a draft built
  // this QR - and so SENT the bill - on the spot, with no one saying so: on INV-078, Andrew's
  // running draft, that is the whole bill going out by accident. Now a draft answers needsSend and
  // nothing is written; the sheet asks "Send INV-078 as the bill first?" and only its yes
  // (`sendIt`) sends it, through the one send stamp, with the recalc and the refresh.
  let row = inv as { total?: number | null; amount_paid?: number | null };
  if ((inv as { status?: string }).status === "draft") {
    if (!opts?.sendIt) return { ...needsSendRefusal(inv.invoice_number), needsSend: true };
    const sent = await sendDraftForPayment(supabase, invoiceId);
    if (!sent.ok) return { ok: false, error: sent.error };
    const { data: again } = await supabase.from("invoices").select("total, amount_paid").eq("id", invoiceId).maybeSingle();
    if (again) row = again as typeof row;
  }

  const balance = invoiceBalance(row.total, row.amount_paid);
  const out: Awaited<ReturnType<typeof collectArtifacts>> = {
    ok: true,
    balance,
    invoiceNumber: inv.invoice_number ?? null,
  };

  // THE CONTRADICTION (Erik 2026-09-10: Settings said "Accepting Payments", Pay Now said "not
  // switched on"). This select named `stripe_details_submitted`, a column that does not exist.
  // PostgREST refuses the whole read, `org` comes back null, canAcceptPayments() is false, and the
  // caller told the office to go set up card payments they had already set up — for a reason
  // that was never checked. Real columns only, and a failed read is an ERROR, not "no card door".
  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .select("settings, stripe_account_id, stripe_account_status, stripe_charges_enabled")
    .eq("id", inv.org_id)
    .maybeSingle();
  if (orgErr || !org) {
    return { ok: false, error: orgErr ? dbError(orgErr) : "Couldn't read this company's payment setup." };
  }

  // CARD — only when the door actually opens. A QR to a checkout that will 503 is worse than no QR.
  const token = (inv as { public_token?: string | null }).public_token;
  if (token) out.invoiceUrl = orgDocUrl(getOrgSettings((org as { settings?: unknown }).settings), "i", token, rowPlace(inv));
  if (token && org && canAcceptPayments(connectStateFromOrg(org as never))) {
    const base = orgPublicBaseUrl(getOrgSettings((org as { settings?: unknown }).settings));
    const payUrl = `${base}/api/pay/${token}`;
    out.payUrl = payUrl;
    out.payQr = await QRCode.toDataURL(payUrl, { margin: 1, width: 480, color: { dark: "#0f172a" } });
  }

  // VENMO — the handle comes from Settings → Payment methods.
  // THE QR ASKS FOR WHAT WILL BE RECORDED. It used to encode the full balance while the "They
  // paid" button recorded the TYPED amount — a $100 partial against a $250 balance sent the
  // customer a $250 request and wrote $100 in the ledger: chased for money already sent.
  const asking = Math.min(Math.max(Number(collectAmount ?? balance), 0.01), balance);
  const handle = getOrgSettings((org as { settings?: unknown } | null)?.settings).venmo_handle?.trim();
  if (handle) {
    out.venmoHandle = handle;
    out.venmoQr = await venmoQrData(handle, inv.invoice_number ?? null, asking);
  }

  return out;
}

/** The org's Venmo pay link with the amount and invoice number filled in, as a QR data URL.
 *  One builder for both doors (collectArtifacts and venmoQrFor), so the two QRs never disagree. */
async function venmoQrData(handle: string, invoiceNumber: string | null, asking: number): Promise<string> {
  const note = encodeURIComponent(invoiceNumber ? `Invoice ${invoiceNumber}` : "Work completed");
  const venmoUrl = `https://venmo.com/u/${encodeURIComponent(handle)}?txn=pay&amount=${asking.toFixed(2)}&note=${note}`;
  return QRCode.toDataURL(venmoUrl, { margin: 1, width: 480, color: { dark: "#0f172a" } });
}

/**
 * THE VENMO QR, AND NOTHING ELSE (2026-09-24, INV-078).
 *
 * The Record Payment modal used to fetch its Venmo QR through collectArtifacts, which is the CARD
 * door and promotes a draft to sent (a Stripe QR is the bill in the customer's hand). So choosing
 * Venmo in Record Payment on a draft sent the invoice, stamped it and locked every line, for money
 * that was only ever going to be written down by hand.
 *
 * This QR is the company's Venmo link, not the bill, so showing it is not a delivery (0267). It
 * reads and draws and writes nothing: no send stamp, no recalc, no revalidate.
 */
export async function venmoQrFor(invoiceId: string, amount?: number): Promise<{
  ok: boolean;
  error?: string;
  balance?: number;
  invoiceNumber?: string | null;
  venmoQr?: string;
  venmoHandle?: string;
}> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const { data: inv } = await supabase
    .from("invoices")
    .select("id, invoice_number, status, total, amount_paid, org_id")
    .eq("id", invoiceId)
    .maybeSingle();
  if (!inv) return { ok: false, error: "Invoice not found." };
  if ((inv as { status?: string }).status === "void") {
    return { ok: false, error: "This invoice is void, so there's nothing to collect on it." };
  }

  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", inv.org_id)
    .maybeSingle();
  if (orgErr || !org) {
    return { ok: false, error: orgErr ? dbError(orgErr) : "Couldn't read this company's payment setup." };
  }

  const handle = getOrgSettings((org as { settings?: unknown }).settings).venmo_handle?.trim();
  if (!handle) {
    return { ok: false, error: "Add your Venmo username in Settings → Payment methods first." };
  }

  const balance = invoiceBalance(inv.total, inv.amount_paid);
  // NOTHING OWED, NO QR. The clamp below would ask for $0.00 (a stale page, or a visit whose
  // bill is already settled), and "They Paid — Record It" after it is a dead door.
  if (balance < 0.005) {
    return { ok: false, error: `${inv.invoice_number ?? "This invoice"} is paid in full, so there's nothing to collect.` };
  }
  // THE QR ASKS FOR WHAT WILL BE RECORDED: the same clamp collectArtifacts uses.
  const asking = Math.min(Math.max(Number(amount ?? balance), 0.01), balance);
  return {
    ok: true,
    balance,
    invoiceNumber: inv.invoice_number ?? null,
    venmoHandle: handle,
    venmoQr: await venmoQrData(handle, inv.invoice_number ?? null, asking),
  };
}
