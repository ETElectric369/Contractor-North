/**
 * PAYMENT REQUESTS, THE SERVER HALF (cn-v1177). The rule is lib/prepayments (pure); this file holds the
 * reads and the writes, for a signed-in office client and for the service client alike. Never a
 * catalog: a failure comes back as a code, and the door that called says it in the person's language.
 *
 * WHAT IT WRITES, AND WHERE THE RULE IS HELD:
 *   - a request: a bill of kind "prepayment", ONE line (import_source "prepayment"), tax 0, no due
 *     date (due_date_by_hand true, so the first-send restamp leaves it empty), born SENT through the
 *     house's one send stamp (markInvoiceSent): it is a bill the customer can pay from the moment it
 *     exists, and no message goes out by itself;
 *   - the lines that take requests off a later bill ("prepaid_credit", syncPrepaidCredit), re-resolved
 *     on every recalc of a DRAFT bill on the job (lib/invoice-recalc runs the sync first), and never
 *     touched once that bill is sent.
 * The arithmetic is prepaymentStates and allocatePrepaidCredit, never re-derived here. The database
 * holds the boundary under it (0414): two bills can never take the same dollar of one request.
 *
 * THE SERVICE CLIENT HAS NO BOUNDARY BUT THE ONE TYPED HERE: every read and write below is pinned to
 * the company of the row it started from (the job's, the estimate's, the bill's), by hand.
 */
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  PREPAID_CREDIT,
  PREPAYMENT_KIND,
  PREPAYMENT_LINE,
  allocatePrepaidCredit,
  isPrepaymentKind,
  prepaidCreditDescription,
  prepaymentLabel,
  prepaymentStates,
  type PrepaidCreditRow,
  type PrepaymentBillRow,
  type PrepaymentPurpose,
  type PrepaymentState,
} from "./prepayments";
import { invoiceBalance } from "./invoice-math";
import { recalcInvoice } from "./invoice-recalc";
import { markInvoiceSent } from "./invoice-sent-stamp";
import { reportError } from "./observe";
import { canAcceptPayments, connectStateFromOrg } from "./stripe-connect";
import { getOrgSettings } from "./org-settings";
import { smsReadiness } from "./sms";

/** One payment request, as a door needs it. */
export type RequestRef = {
  id: string;
  number: string | null;
  /** The bill's public token: its pay link is /i/<token>, its card door /api/pay/<token>. */
  token: string | null;
  label: string;
  amount: number;
  /** What is still owed on the request itself. */
  balance: number;
  status: string;
};

export type RequestRefusal =
  | "no_job" // the job is not this company's, or does not exist
  | "job_over" // the job is complete or cancelled: there is no next bill for it to come off
  | "no_customer" // the job has no customer to bill
  | "bad_amount" // not a number above zero
  | "bad_quote" // the estimate named is not this job's accepted estimate
  | "failed"; // a read or a write failed (reported)

export type CreateRequestResult =
  | { ok: true; request: RequestRef; /** A live deposit request for that estimate already existed: nothing new was made. */ existing: boolean }
  | { ok: false; why: RequestRefusal };

/** The largest request a door may make: the house's line ceiling (createProgressInvoice's). */
const MOST = 9_999_999;
const cents = (n: number): number => Math.round(n * 100) / 100;
const num = (x: unknown): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

/** The columns a RequestRef is read from. */
const REF_COLUMNS = "id, invoice_number, public_token, title, total, amount_paid, status";
type RefRow = { id: string; invoice_number: string | null; public_token: string | null; title: string | null; total: unknown; amount_paid: unknown; status: string | null };

export function requestRefOf(row: RefRow): RequestRef {
  return {
    id: String(row.id),
    number: row.invoice_number ?? null,
    token: row.public_token ?? null,
    label: (row.title ?? "").trim() || "Payment",
    amount: cents(num(row.total)),
    balance: invoiceBalance(num(row.total), num(row.amount_paid)),
    status: String(row.status ?? ""),
  };
}

/** The live (not void) deposit request of one estimate, in one company. Throws on a failed read. */
async function liveRequestForQuote(db: SupabaseClient, orgId: string, quoteId: string): Promise<RequestRef | null> {
  const { data, error } = await db
    .from("invoices")
    .select(REF_COLUMNS)
    .eq("org_id", orgId)
    .eq("quote_id", quoteId)
    .eq("invoice_kind", PREPAYMENT_KIND)
    .neq("status", "void")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? requestRefOf(data as RefRow) : null;
}

/**
 * A DEPOSIT REQUEST FOUND AS A DRAFT (skeptic #80, F10): a second tap that raced the first, or a birth
 * that stopped between its insert and its sent stamp. A draft is never handed to a card door, and one
 * left as a draft would block its estimate for good (the one-live index holds it), so its birth is
 * finished here: its own line must be there, then the recalc, then the one sent stamp, as at birth.
 * A draft with no line is taken back, so the next tap makes it whole. null when it could not be done.
 */
async function finishBirth(db: SupabaseClient, orgId: string, jobId: string, live: RequestRef): Promise<RequestRef | null> {
  if (live.status !== "draft") return live;
  const { data: own, error: ownErr } = await db.from("invoice_items").select("id").eq("invoice_id", live.id).eq("org_id", orgId).eq("import_source", PREPAYMENT_LINE);
  if (ownErr) throw ownErr;
  if (!(own ?? []).length) {
    await dropUnborn(db, orgId, live.id);
    return null;
  }
  if (!(await recalcInvoice(db, live.id))) return null;
  const sent = await markInvoiceSent(db, live.id);
  if (!sent.ok) return null;
  if (!(await recalcInvoice(db, live.id))) reportError("createPaymentRequest.finishBirth.recalc", new Error("recalc did not land"), { invoiceId: live.id });
  await resyncJobDrafts(db, jobId);
  const { data: back, error: backErr } = await db.from("invoices").select(REF_COLUMNS).eq("id", live.id).eq("org_id", orgId).maybeSingle();
  if (backErr || !back) return null;
  const ref = requestRefOf(back as RefRow);
  return ref.status === "draft" ? null : ref;
}

/** Take back a request that never finished being born (a draft: it asks for nothing). Best effort. */
async function dropUnborn(db: SupabaseClient, orgId: string, id: string): Promise<void> {
  const { error } = await db.from("invoices").delete().eq("id", id).eq("org_id", orgId).eq("status", "draft").select("id");
  if (error) reportError("createPaymentRequest.dropUnborn", error, { invoiceId: id });
}

/** Make one payment request on a job (or hand back the live deposit request its estimate already has). */
export async function createPaymentRequest(
  db: SupabaseClient,
  input: {
    orgId: string;
    jobId: string;
    purpose: PrepaymentPurpose;
    amount: number;
    /** Purpose "other": the typed name. */
    label?: string | null;
    /** Purpose "deposit": the accepted estimate it is the deposit of. One live request per estimate. */
    quoteId?: string | null;
    createdBy: string | null;
  },
): Promise<CreateRequestResult> {
  const orgId = String(input?.orgId ?? "");
  const jobId = String(input?.jobId ?? "");
  if (!orgId || !jobId) return { ok: false, why: "no_job" };
  const raw = Number(input.amount);
  const amount = cents(raw);
  if (!Number.isFinite(raw) || amount < 0.01 || amount > MOST) return { ok: false, why: "bad_amount" };
  const purpose: PrepaymentPurpose = input.purpose === "deposit" || input.purpose === "materials" ? input.purpose : "other";

  try {
    const { data: job, error: jobErr } = await db
      .from("jobs")
      .select("id, org_id, customer_id, status")
      .eq("id", jobId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (jobErr) throw jobErr;
    if (!job) return { ok: false, why: "no_job" };
    const j = job as { customer_id?: string | null; status?: string | null };
    const st = String(j.status ?? "");
    if (st === "complete" || st === "cancelled") return { ok: false, why: "job_over" };
    if (!j.customer_id) return { ok: false, why: "no_customer" };

    // THE ESTIMATE'S DEPOSIT: only this job's ACCEPTED estimate, and only ever one live request for it.
    const quoteId = purpose === "deposit" && input.quoteId ? String(input.quoteId) : null;
    if (input.quoteId && purpose !== "deposit") return { ok: false, why: "bad_quote" };
    if (quoteId) {
      const { data: q, error: qErr } = await db
        .from("quotes")
        .select("id, job_id, status")
        .eq("id", quoteId)
        .eq("org_id", orgId)
        .maybeSingle();
      if (qErr) throw qErr;
      const qq = q as { job_id?: string | null; status?: string | null } | null;
      if (!qq || qq.job_id !== jobId || qq.status !== "accepted") return { ok: false, why: "bad_quote" };
      const live = await liveRequestForQuote(db, orgId, quoteId);
      if (live) {
        const whole = await finishBirth(db, orgId, jobId, live);
        return whole ? { ok: true, request: whole, existing: true } : { ok: false, why: "failed" };
      }
    }

    const label = prepaymentLabel(purpose, input.label);
    // BORN A DRAFT FOR A MOMENT, THEN SENT through the one send stamp below. A draft request asks for
    // nothing (prepaymentStates), so no bill takes it off before it is real.
    const { data: made, error: madeErr } = await db
      .from("invoices")
      .insert({
        org_id: orgId,
        customer_id: j.customer_id,
        job_id: jobId,
        quote_id: quoteId,
        status: "draft",
        title: label,
        invoice_kind: PREPAYMENT_KIND,
        tax_rate: 0,
        subtotal: amount,
        tax: 0,
        total: amount,
        // NO DUE DATE: a request is paid when the customer pays it; no clock runs on it. Marked as
        // chosen so the first send's restamp (markInvoiceSent) leaves it empty.
        due_date: null,
        due_date_by_hand: true,
        created_by: input.createdBy ?? null,
      })
      .select("id")
      .single();
    if (madeErr || !made) {
      // ONE LIVE DEPOSIT REQUEST PER ESTIMATE (0414's unique index): a second tap that lost the race
      // is handed the one that won, never an error.
      if (quoteId && String((madeErr as { code?: string } | null)?.code ?? "") === "23505") {
        const live = await liveRequestForQuote(db, orgId, quoteId);
        if (live) {
          const whole = await finishBirth(db, orgId, jobId, live);
          return whole ? { ok: true, request: whole, existing: true } : { ok: false, why: "failed" };
        }
      }
      throw madeErr ?? new Error("the request was not made");
    }
    const id = String((made as { id: string }).id);

    const { data: line, error: lineErr } = await db
      .from("invoice_items")
      .insert({
        org_id: orgId,
        invoice_id: id,
        description: label,
        quantity: 1,
        unit: "ea",
        unit_price: amount,
        sort_order: 0,
        import_source: PREPAYMENT_LINE,
      })
      .select("id");
    if (lineErr || !line?.length) {
      await dropUnborn(db, orgId, id);
      throw lineErr ?? new Error("the request's line did not land");
    }
    if (!(await recalcInvoice(db, id))) {
      await dropUnborn(db, orgId, id);
      throw new Error("the request's totals did not land");
    }
    // Before the flip, as every send does (the sync skips a request; its own totals are fresh above).
    const sent = await markInvoiceSent(db, id);
    if (!sent.ok) {
      await dropUnborn(db, orgId, id);
      throw new Error(sent.error ?? "the request was not marked sent");
    }
    if (!(await recalcInvoice(db, id))) reportError("createPaymentRequest.recalcAfterSend", new Error("recalc did not land"), { invoiceId: id });

    // Every open draft on the job takes it off now, oldest first.
    await resyncJobDrafts(db, jobId);

    const { data: back, error: backErr } = await db.from("invoices").select(REF_COLUMNS).eq("id", id).eq("org_id", orgId).maybeSingle();
    if (backErr || !back) throw backErr ?? new Error("the request could not be read back");
    return { ok: true, request: requestRefOf(back as RefRow), existing: false };
  } catch (e) {
    reportError("createPaymentRequest", e, { jobId, purpose });
    return { ok: false, why: "failed" };
  }
}

export type DepositDoor =
  | { ok: true; invoiceToken: string; paid: boolean }
  | { ok: false; why: "not_found" | "not_accepted" | "no_deposit" | "no_job" | "no_customer" | "failed" };

/**
 * THE CUSTOMER'S "PAY THE DEPOSIT" TAP, from the estimate's own link. Service client: every read is
 * pinned to the estimate's company by hand. Finds the estimate by its public token, and finds or makes
 * the one deposit request of that estimate on its job.
 */
export async function ensureDepositRequestForQuoteToken(admin: SupabaseClient, quoteToken: string): Promise<DepositDoor> {
  const token = String(quoteToken ?? "").trim();
  if (!token) return { ok: false, why: "not_found" };
  try {
    const { data: q, error: qErr } = await admin
      .from("quotes")
      .select("id, org_id, status, job_id, deposit_amount")
      .eq("public_token", token)
      .maybeSingle();
    if (qErr) throw qErr;
    if (!q) return { ok: false, why: "not_found" };
    const quote = q as { id: string; org_id: string | null; status: string | null; job_id: string | null; deposit_amount: unknown };
    const orgId = String(quote.org_id ?? "");
    if (!orgId) return { ok: false, why: "not_found" };
    if (quote.status !== "accepted") return { ok: false, why: "not_accepted" };
    if (!quote.job_id) return { ok: false, why: "no_job" };

    // THE SAME DECISION public_quote MAKES (0414, deposit_state), so the page never draws a button whose
    // tap can only be refused: a live request is handed back (it is owed, on a finished job too; a
    // draft one has its birth finished by createPaymentRequest, never handed to a card door); with none
    // live, nothing is made when no deposit is stated, when the office voided the estimate's request (a
    // new one is made only by the office's own form), or when the job is complete or cancelled.
    const live = await liveRequestForQuote(admin, orgId, quote.id);
    let ref: RequestRef | RequestRefusal;
    if (live && live.status !== "draft") {
      ref = live;
    } else {
      const deposit = cents(num(live ? live.amount : quote.deposit_amount));
      if (!live) {
        if (quote.deposit_amount == null || deposit < 0.01) return { ok: false, why: "no_deposit" };
        const { data: voided, error: voidErr } = await admin
          .from("invoices")
          .select("id")
          .eq("org_id", orgId)
          .eq("quote_id", quote.id)
          .eq("invoice_kind", PREPAYMENT_KIND)
          .eq("status", "void")
          .limit(1);
        if (voidErr) throw voidErr;
        if ((voided ?? []).length) return { ok: false, why: "no_deposit" };
      }
      const { data: job, error: jobErr } = await admin
        .from("jobs")
        .select("id, customer_id, status")
        .eq("id", quote.job_id)
        .eq("org_id", orgId)
        .maybeSingle();
      if (jobErr) throw jobErr;
      if (!job) return { ok: false, why: "no_job" };
      const jst = String((job as { status?: string | null }).status ?? "");
      if (!live && (jst === "complete" || jst === "cancelled")) return { ok: false, why: "no_deposit" };
      if (!(job as { customer_id?: string | null }).customer_id) return { ok: false, why: "no_customer" };
      const made = await createPaymentRequest(admin, {
        orgId,
        jobId: quote.job_id as string,
        purpose: "deposit",
        // A draft found live is handed back (its birth finished) and this figure is not used.
        amount: live ? Math.max(deposit, 0.01) : deposit,
        quoteId: quote.id,
        createdBy: null,
      });
      ref = made.ok ? made.request : made.why;
    }
    if (typeof ref === "string") {
      const why: Extract<DepositDoor, { ok: false }>["why"] =
        ref === "job_over" || ref === "no_job" ? "no_job" : ref === "no_customer" ? "no_customer" : ref === "bad_quote" ? "not_accepted" : ref === "bad_amount" ? "no_deposit" : "failed";
      return { ok: false, why };
    }
    // Never a draft to a card door.
    if (!ref.token || ref.status === "draft") return { ok: false, why: "failed" };
    return { ok: true, invoiceToken: ref.token, paid: ref.status === "paid" };
  } catch (e) {
    reportError("ensureDepositRequestForQuoteToken", e, {});
    return { ok: false, why: "failed" };
  }
}

/**
 * Where every request on one job stands, read in ONE company when `orgId` is given (the service
 * client), or as RLS lets the caller see (a staff client). THROWS on a failed read.
 */
async function readStates(
  db: SupabaseClient,
  jobId: string,
  orgId: string | null,
  exceptInvoiceId?: string | null,
  /** Count no credit line that sits on a DRAFT bill: the states as a bill going out sees them, once
   *  the other drafts' derived lines are cleared (outgoingDraftFirst). */
  ignoreDrafts = false,
): Promise<PrepaymentState[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a PostgREST builder, pinned or not
  const pin = (q: any): any => (orgId ? q.eq("org_id", orgId) : q);
  const { data: reqs, error: reqErr } = await pin(
    db.from("invoices").select("id, invoice_number, status, title, created_at, amount_paid").eq("job_id", jobId).eq("invoice_kind", PREPAYMENT_KIND),
  );
  if (reqErr) throw reqErr;
  const rows = (reqs ?? []) as { id: string; invoice_number: string | null; status: string | null; title: string | null; created_at: string | null; amount_paid: unknown }[];
  if (!rows.length) return [];
  const ids = rows.map((r) => String(r.id));

  const [ownLines, refunds, creditLines] = await Promise.all([
    pin(db.from("invoice_items").select("invoice_id, line_total").in("invoice_id", ids)),
    pin(db.from("customer_credits").select("invoice_id, amount").in("invoice_id", ids).eq("disposition", "refund")),
    pin(db.from("invoice_items").select("invoice_id, line_total, prepaid_invoice_id").eq("import_source", PREPAID_CREDIT).in("prepaid_invoice_id", ids)),
  ]);
  for (const r of [ownLines, refunds, creditLines]) if (r.error) throw r.error;

  const credits = (creditLines.data ?? []) as { invoice_id: string; line_total: unknown; prepaid_invoice_id: string | null }[];
  const carrierIds = [...new Set(credits.map((c) => String(c.invoice_id)))];
  const statusOf = new Map<string, string | null>();
  if (carrierIds.length) {
    const { data: carriers, error: carrierErr } = await pin(db.from("invoices").select("id, status").in("id", carrierIds));
    if (carrierErr) throw carrierErr;
    for (const c of (carriers ?? []) as { id: string; status: string | null }[]) statusOf.set(String(c.id), c.status ?? null);
  }

  const asked = new Map<string, number>();
  for (const l of (ownLines.data ?? []) as { invoice_id: string; line_total: unknown }[]) {
    asked.set(String(l.invoice_id), (asked.get(String(l.invoice_id)) ?? 0) + num(l.line_total));
  }
  const refunded = new Map<string, number>();
  for (const r of (refunds.data ?? []) as { invoice_id: string; amount: unknown }[]) {
    refunded.set(String(r.invoice_id), (refunded.get(String(r.invoice_id)) ?? 0) + Math.abs(num(r.amount)));
  }
  const bills: PrepaymentBillRow[] = rows.map((r) => ({
    id: String(r.id),
    invoice_number: r.invoice_number ?? null,
    status: r.status ?? null,
    title: r.title ?? null,
    created_at: r.created_at ?? null,
    amount: cents(asked.get(String(r.id)) ?? 0),
    amount_paid: num(r.amount_paid),
    refunded: cents(refunded.get(String(r.id)) ?? 0),
  }));
  // A carrier this caller cannot see (it would have to be another company's) is read as void: it is
  // not counted, and the database's own boundary still holds the dollar.
  const creditRows: PrepaidCreditRow[] = credits
    .map((c) => ({
      invoice_id: String(c.invoice_id),
      invoice_status: statusOf.has(String(c.invoice_id)) ? statusOf.get(String(c.invoice_id)) ?? null : "void",
      prepaid_invoice_id: c.prepaid_invoice_id ?? null,
      amount: num(c.line_total),
    }))
    .filter((c) => !(ignoreDrafts && c.invoice_status === "draft"));
  return prepaymentStates(bills, creditRows, exceptInvoiceId ?? null);
}

/** Where every request on one job stands. THROWS on a failed read: an empty list must mean none. */
export async function readPrepaymentStates(db: SupabaseClient, jobId: string, exceptInvoiceId?: string | null): Promise<PrepaymentState[]> {
  return readStates(db, jobId, null, exceptInvoiceId);
}

/**
 * Where every request on one job stands AS A BILL GOING OUT SEES IT: credit lines on draft bills are not
 * counted, because outgoingDraftFirst clears them before the outgoing bill is resolved. THROWS on a
 * failed read.
 */
export async function readPrepaymentStatesForOutgoing(db: SupabaseClient, jobId: string): Promise<PrepaymentState[]> {
  return readStates(db, jobId, null, null, true);
}

/** One "prepaid_credit" line as the sync reads it. */
type CreditLine = { id: string; line_total: unknown; import_source: string | null; prepaid_invoice_id: string | null; description: string | null; sort_order: unknown };

/**
 * WHAT THE SYNC WOULD WRITE, decided without a database: which credit lines go, which change, which are
 * added. Pure, so the tests read it line by line. An unchanged set is three empty lists.
 */
export function planPrepaidCredit(
  lines: readonly CreditLine[],
  states: readonly PrepaymentState[],
): {
  remove: string[];
  change: { id: string; description: string; unit_price: number; sort_order: number }[];
  add: { prepaid_invoice_id: string; description: string; unit_price: number; sort_order: number }[];
} {
  const others = (lines ?? []).filter((l) => l.import_source !== PREPAID_CREDIT);
  const mine = (lines ?? []).filter((l) => l.import_source === PREPAID_CREDIT);
  const base = cents(others.reduce((s, l) => s + num(l.line_total), 0));
  const last = others.reduce((m, l) => Math.max(m, Math.trunc(num(l.sort_order))), -1);
  const want = allocatePrepaidCredit(states, base);

  const remove: string[] = [];
  const change: { id: string; description: string; unit_price: number; sort_order: number }[] = [];
  const add: { prepaid_invoice_id: string; description: string; unit_price: number; sort_order: number }[] = [];
  const held = new Map<string, CreditLine>();
  for (const l of mine) {
    const r = l.prepaid_invoice_id ? String(l.prepaid_invoice_id) : "";
    if (!r || held.has(r) || !want.some((w) => w.prepaidInvoiceId === r)) remove.push(String(l.id));
    else held.set(r, l);
  }
  want.forEach((w, i) => {
    const description = prepaidCreditDescription(w.label, w.number);
    const unit_price = -cents(w.amount);
    const sort_order = last + 1 + i;
    const l = held.get(w.prepaidInvoiceId);
    if (!l) {
      add.push({ prepaid_invoice_id: w.prepaidInvoiceId, description, unit_price, sort_order });
      return;
    }
    const same =
      Math.abs(num(l.line_total) - unit_price) < 0.005 && (l.description ?? "") === description && Math.trunc(num(l.sort_order)) === sort_order;
    if (!same) change.push({ id: String(l.id), description, unit_price, sort_order });
  });
  return { remove, change, add };
}

/**
 * Re-resolve the "prepaid_credit" lines of ONE draft bill. A bill that is not a draft, has no job, or
 * is itself a payment request is left exactly as it is. False when it could not be done.
 */
export async function syncPrepaidCredit(db: SupabaseClient, invoiceId: string): Promise<boolean> {
  try {
    const { data: inv, error: invErr } = await db.from("invoices").select("id, org_id, job_id, status, invoice_kind").eq("id", invoiceId).maybeSingle();
    if (invErr) throw invErr;
    if (!inv) return false;
    const bill = inv as { org_id: string | null; job_id: string | null; status: string | null; invoice_kind: string | null };
    if (String(bill.status ?? "") !== "draft" || !bill.job_id || isPrepaymentKind(bill.invoice_kind)) return true;
    const orgId = String(bill.org_id ?? "");
    if (!orgId) return false;

    const { data: lines, error: linesErr } = await db
      .from("invoice_items")
      .select("id, line_total, import_source, prepaid_invoice_id, description, sort_order")
      .eq("invoice_id", invoiceId)
      .eq("org_id", orgId);
    if (linesErr) throw linesErr;
    const states = await readStates(db, bill.job_id, orgId, invoiceId);
    const plan = planPrepaidCredit((lines ?? []) as CreditLine[], states);

    // Stale ones first, then the changes, then the new: each write checked (a zero-row write is not
    // success), and the database refuses any that would take a dollar another bill holds.
    if (plan.remove.length) {
      const { data: gone, error } = await db.from("invoice_items").delete().in("id", plan.remove).eq("invoice_id", invoiceId).eq("org_id", orgId).select("id");
      if (error) throw error;
      if ((gone ?? []).length !== plan.remove.length) throw new Error("a stale credit line did not come off");
    }
    for (const c of plan.change) {
      const { data: wrote, error } = await db
        .from("invoice_items")
        .update({ description: c.description, quantity: 1, unit_price: c.unit_price, sort_order: c.sort_order, line_kind: "credit" })
        .eq("id", c.id)
        .eq("invoice_id", invoiceId)
        .eq("org_id", orgId)
        .select("id");
      if (error) throw error;
      if (!wrote?.length) throw new Error("a credit line did not change");
    }
    if (plan.add.length) {
      const rows = plan.add.map((a) => ({
        org_id: orgId,
        invoice_id: invoiceId,
        description: a.description,
        quantity: 1,
        unit: "lot",
        unit_price: a.unit_price,
        sort_order: a.sort_order,
        import_source: PREPAID_CREDIT,
        prepaid_invoice_id: a.prepaid_invoice_id,
        line_kind: "credit",
      }));
      const { data: added, error } = await db.from("invoice_items").insert(rows).select("id");
      if (error) throw error;
      if ((added ?? []).length !== rows.length) throw new Error("a credit line did not land");
    }
    return true;
  } catch (e) {
    reportError("syncPrepaidCredit", e, { invoiceId });
    return false;
  }
}

/** After a request is made or voided: every open draft bill on the job is resolved again and recalculated.
 *  `exceptInvoiceId`: a draft left as it is (the bill going out, already resolved first). */
export async function resyncJobDrafts(db: SupabaseClient, jobId: string, exceptInvoiceId?: string | null): Promise<void> {
  try {
    const { data, error } = await db
      .from("invoices")
      .select("id")
      .eq("job_id", jobId)
      .eq("status", "draft")
      .neq("invoice_kind", PREPAYMENT_KIND)
      .order("created_at", { ascending: true });
    if (error) throw error;
    // Oldest first, one at a time: each later draft sees what the earlier ones took.
    for (const d of (data ?? []) as { id: string }[]) {
      if (exceptInvoiceId && String(d.id) === exceptInvoiceId) continue;
      if (!(await recalcInvoice(db, String(d.id)))) reportError("resyncJobDrafts.recalc", new Error("recalc did not land"), { jobId, invoiceId: d.id });
    }
  } catch (e) {
    reportError("resyncJobDrafts", e, { jobId });
  }
}

/**
 * THE BILL GOING OUT COMES FIRST (cn-v1177, skeptic #80). A draft's credit lines count while it is a
 * draft (two drafts must never both take one dollar), so a draft left open and forgotten would hold a
 * request's credit and the bill that actually goes out would take nothing off. So at every draft → sent
 * flip, BEFORE the flip:
 *   1. the "prepaid_credit" lines of the job's OTHER draft bills are removed (they are derived, never
 *      typed), first, so the database's own hold (0414) sees room before the outgoing bill writes;
 *   2. the outgoing bill is recalculated (its sync takes the requests off it);
 *   3. the other drafts are resolved again, oldest first, and take what is left.
 * Done before the flip, so a send that then fails leaves every bill consistent. A bill that is not a
 * draft is left as it is (true). A bill with no job, or a request, is only recalculated. False when it
 * could not be brought up to date: the caller sends nothing and says so.
 */
export async function outgoingDraftFirst(db: { from: (t: string) => any }, invoiceId: string): Promise<boolean> {
  const sb = db as SupabaseClient;
  try {
    const { data: inv, error: invErr } = await sb.from("invoices").select("id, org_id, job_id, status, invoice_kind").eq("id", invoiceId).maybeSingle();
    if (invErr) throw invErr;
    if (!inv) return false;
    const bill = inv as { org_id: string | null; job_id: string | null; status: string | null; invoice_kind: string | null };
    if (String(bill.status ?? "") !== "draft") return true;
    if (!bill.job_id || isPrepaymentKind(bill.invoice_kind)) return await recalcInvoice(sb, invoiceId);
    const orgId = String(bill.org_id ?? "");
    if (!orgId) return false;
    const jobId = bill.job_id;

    const { data: others, error: othersErr } = await sb
      .from("invoices")
      .select("id")
      .eq("job_id", jobId)
      .eq("org_id", orgId)
      .eq("status", "draft")
      .neq("invoice_kind", PREPAYMENT_KIND)
      .neq("id", invoiceId);
    if (othersErr) throw othersErr;
    const otherIds = ((others ?? []) as { id: string }[]).map((o) => String(o.id));
    if (otherIds.length) {
      const { error: clearErr } = await sb
        .from("invoice_items")
        .delete()
        .in("invoice_id", otherIds)
        .eq("import_source", PREPAID_CREDIT)
        .eq("org_id", orgId)
        .select("id");
      if (clearErr) throw clearErr;
    }
    const fresh = await recalcInvoice(sb, invoiceId);
    // Whatever the outgoing bill's answer, the other drafts are resolved again: their lines were cleared.
    if (otherIds.length) await resyncJobDrafts(sb, jobId, invoiceId);
    return fresh;
  } catch (e) {
    reportError("outgoingDraftFirst", e, { invoiceId });
    return false;
  }
}

/**
 * THE PAY-DOOR FACTS (cn-v1177): what a Get Paid sheet opened from a payment request needs, from the
 * company row. Structurally the same as PayDoorFacts in components/request-payment.tsx (a client file,
 * so the server cannot import its type) and the same four expressions the job page computes for its
 * `payDoor` prop. One formula: the job page can call this instead of its inline copy.
 */
export type PayDoorFacts = { cardEnabled?: boolean; methods?: string[]; venmoConfigured?: boolean; textReady?: boolean };

/** The company row columns payDoorFacts reads (the job page's own organizations read carries them). */
export const PAY_DOOR_ORG_COLUMNS = "settings, stripe_account_id, stripe_account_status, stripe_charges_enabled";

export function payDoorFacts(org: { settings?: unknown; stripe_account_id?: string | null; stripe_account_status?: string | null; stripe_charges_enabled?: boolean | null } | null | undefined): PayDoorFacts {
  const settings = getOrgSettings((org as { settings?: unknown } | null)?.settings);
  return {
    cardEnabled: canAcceptPayments(connectStateFromOrg((org ?? {}) as never)),
    methods: settings.payment_methods,
    venmoConfigured: Boolean(settings.venmo_handle?.trim()),
    textReady: smsReadiness(org as { settings?: unknown } | null).ready,
  };
}
