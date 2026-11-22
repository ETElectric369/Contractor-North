"use server";

/**
 * THE OFFICE'S PAYMENT-REQUEST DOORS (cn-v1177): read what a job could ask for, and ask for it.
 *
 * The rule and the writes are lib/payment-request (codes, no words); this file is the staff door and
 * says each refusal in the signed-in person's language (the su_req_ keys, lib/words/settle-up).
 * A "use server" file exports only async functions (types are fine).
 */
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";
import { revalidateMoney } from "@/lib/revalidate-money";
import { callerLang } from "@/lib/lang-of";
import { translator } from "@/lib/i18n";
import { canAcceptPayments, connectStateFromOrg } from "@/lib/stripe-connect";
import { customerUnbilled, unbilledWorkForJob } from "@/lib/unbilled-work";
import { prepaymentsLeft } from "@/lib/prepayments";
import { reportError } from "@/lib/observe";
import { PAY_DOOR_ORG_COLUMNS, createPaymentRequest, liveRequestForQuote, payDoorFacts, readPrepaymentStates, readPrepaymentStatesForOutgoing, requestRefOf, type PayDoorFacts, type RequestRef, type RequestRefusal } from "@/lib/payment-request";
import type { PrepaymentPurpose } from "@/lib/prepayments";
import { openBillViews, type JobBillRow, type OpenBillView } from "@/lib/job-bill-for-payment";
import { finishBillingStep, readPriceLeftToBill } from "@/lib/finish-bills-first";

export type PrepaymentView = RequestRef & {
  paid: number;
  refunded: number;
  /** The bills that already took some of it off. */
  taken: { invoiceId: string; number: string | null; amount: number }[];
  /** Still to come off a later bill. */
  left: number;
  /** Money in hand that no bill has used. */
  moneyLeft: number;
};

export type PaymentRequestSeed =
  | { ok: false; error: string }
  | {
      ok: true;
      job: { id: string; number: string | null; over: boolean; hasCustomer: boolean };
      deposit: {
        /** The deposit the job's accepted estimate states; 0 when none. */
        due: number;
        quote: { id: string; number: string | null } | null;
        /** The live deposit request that estimate already has, if any. */
        request: RequestRef | null;
      };
      materials: {
        /** Marked-up materials recorded on the job that no bill carries yet. */
        unbilled: number;
        /** That figure less what the job's requests still have to come off a bill. Never below 0. */
        suggested: number;
      };
      /** Every live request on the job, oldest first. */
      requests: PrepaymentView[];
      /** All of them together: what the next bill takes off. */
      leftToNet: number;
      canTakeCard: boolean;
      /** The company's payment-method facts the Get Paid sheet needs (lib/payment-request payDoorFacts,
       *  the job page's `payDoor` prop's shape). Absent only when they could not be read. */
      payDoor?: PayDoorFacts;
    };

const cents = (n: number): number => Math.round(n * 100) / 100;

/** A request's row as the seed reads it. */
type RequestRow = {
  id: string;
  invoice_number: string | null;
  public_token: string | null;
  title: string | null;
  total: unknown;
  amount_paid: unknown;
  status: string | null;
  quote_id?: string | null;
};

/** The refusal code, in the person's words. */
const REFUSAL_KEY: Record<RequestRefusal, string> = {
  no_job: "su_req_noJob",
  job_over: "su_req_jobOver",
  no_customer: "su_req_noCustomer",
  bad_amount: "su_req_badAmount",
  bad_quote: "su_req_badQuote",
  failed: "su_req_failed",
};

/** Staff only. What the Request a Payment form shows before anything is typed. */
export async function readPaymentRequestSeed(jobId: string): Promise<PaymentRequestSeed> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: String(ctx.error) };
  const { supabase, orgId, userId } = ctx;
  const t = translator(await callerLang(supabase, userId));
  if (!orgId) return { ok: false, error: t("su_req_noJob") };
  try {
    const { data: job, error: jobErr } = await supabase
      .from("jobs")
      .select("id, job_number, status, customer_id")
      .eq("id", jobId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (jobErr) throw jobErr;
    if (!job) return { ok: false, error: t("su_req_noJob") };
    const j = job as { id: string; job_number: string | null; status: string | null; customer_id: string | null };
    const over = j.status === "complete" || j.status === "cancelled";

    // THE ESTIMATE'S DEPOSIT: the figure the accepted estimate STORED (an estimate saved before 0414
    // stored none, and says none). The newest accepted estimate when a revision was accepted too.
    const [{ data: quotes, error: qErr }, { data: org, error: orgErr }, states, work] = await Promise.all([
      supabase
        .from("quotes")
        .select("id, quote_number, deposit_amount, created_at")
        .eq("job_id", jobId)
        .eq("org_id", orgId)
        .eq("status", "accepted")
        .order("created_at", { ascending: false })
        .limit(1),
      supabase.from("organizations").select(PAY_DOOR_ORG_COLUMNS).eq("id", orgId).maybeSingle(),
      readPrepaymentStates(supabase, jobId),
      // THE IMPORTER'S OWN READING of the materials no bill carries yet, marked up: the same fetcher
      // and the same figure the customer's portal and the Unbilled card show (customerUnbilled).
      unbilledWorkForJob(supabase, jobId),
    ]);
    if (qErr) throw qErr;
    if (orgErr) throw orgErr;
    const quote = ((quotes ?? []) as { id: string; quote_number: string | null; deposit_amount: unknown }[])[0] ?? null;
    const due = quote ? cents(Math.max(0, Number(quote.deposit_amount) || 0)) : 0;

    // Each live request with its link and balance, and the number of every bill that took it off.
    const ids = states.map((s) => s.id);
    const takerIds = [...new Set(states.flatMap((s) => s.taken.map((x) => x.invoiceId)))];
    const [refs, takers] = await Promise.all([
      ids.length
        ? supabase.from("invoices").select("id, invoice_number, public_token, title, total, amount_paid, status, quote_id").in("id", ids).eq("org_id", orgId)
        : Promise.resolve({ data: [], error: null }),
      takerIds.length ? supabase.from("invoices").select("id, invoice_number").in("id", takerIds).eq("org_id", orgId) : Promise.resolve({ data: [], error: null }),
    ]);
    if (refs.error) throw refs.error;
    if (takers.error) throw takers.error;
    const refRows = (refs.data ?? []) as RequestRow[];
    const refOf = new Map(refRows.map((r) => [String(r.id), r]));
    const numberOf = new Map(((takers.data ?? []) as { id: string; invoice_number: string | null }[]).map((r) => [String(r.id), r.invoice_number ?? null]));
    const requests: PrepaymentView[] = states.flatMap((s) => {
      const row = refOf.get(s.id);
      if (!row) return [];
      return [
        {
          ...requestRefOf(row),
          paid: s.paid,
          refunded: s.refunded,
          taken: s.taken.map((x) => ({ invoiceId: x.invoiceId, number: numberOf.get(x.invoiceId) ?? null, amount: x.amount })),
          left: s.left,
          moneyLeft: s.moneyLeft,
        },
      ];
    });
    // THE SALE'S DEPOSIT (cn-v1178, audit B1): the live deposit request of this estimate or of any
    // estimate in its revision family. A revision of an estimate whose deposit was requested or paid
    // HAS that request: the form draws its doors and never offers a second.
    const quoteRequest = quote ? await liveRequestForQuote(supabase, orgId, quote.id) : null;

    const leftToNet = prepaymentsLeft(states);
    const unbilled = cents(customerUnbilled(work).materials);
    return {
      ok: true,
      job: { id: j.id, number: j.job_number ?? null, over, hasCustomer: !!j.customer_id },
      deposit: { due, quote: quote ? { id: quote.id, number: quote.quote_number ?? null } : null, request: quoteRequest },
      materials: { unbilled, suggested: cents(Math.max(0, unbilled - leftToNet)) },
      requests,
      leftToNet,
      canTakeCard: !!org && canAcceptPayments(connectStateFromOrg(org as never)),
      ...(org ? { payDoor: payDoorFacts(org as Parameters<typeof payDoorFacts>[0]) } : {}),
    };
  } catch (e) {
    // A FAILED READ IS NEVER "NOTHING ASKED FOR": said, and the form shows no figure.
    reportError("readPaymentRequestSeed", e, { jobId });
    return { ok: false, error: t("su_req_readFailed") };
  }
}

export type RequestPaymentResult =
  | { ok: true; request: RequestRef; existing: boolean }
  | { ok: false; error: string; /** The live request that stands in the way, when one does. */ request?: RequestRef };

/** Staff only. Make the request; the form then sends its link or takes the money now. */
export async function requestPayment(input: {
  jobId: string;
  purpose: PrepaymentPurpose;
  amount: number;
  label?: string | null;
  quoteId?: string | null;
}): Promise<RequestPaymentResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: String(ctx.error) };
  const { supabase, orgId, userId } = ctx;
  const t = translator(await callerLang(supabase, userId));
  if (!orgId) return { ok: false, error: t("su_req_noJob") };
  const made = await createPaymentRequest(supabase, {
    orgId,
    jobId: String(input?.jobId ?? ""),
    purpose: input?.purpose,
    amount: Number(input?.amount),
    label: input?.label ?? null,
    quoteId: input?.quoteId ?? null,
    createdBy: userId,
  });
  if (!made.ok) return { ok: false, error: t(REFUSAL_KEY[made.why] ?? "su_req_failed") };
  revalidatePath(`/jobs/${input.jobId}`);
  revalidateMoney(made.request.id);
  revalidateMoney();
  return { ok: true, request: made.request, existing: made.existing };
}

/**
 * WHAT THE JOB'S GET PAID SAYS WHEN IT OPENS (cn-v1179, decision E: "it names the job's open bill and
 * prefills its balance; it says when recorded work is not on a bill yet"). Staff only, one read when the
 * sheet opens, every read of its own naming the company. It decides nothing settleUp does not: the open
 * bills are lib/job-bill-for-payment's one rule (the rule settleUp lands a payment by), the work no bill
 * claims is the billing step's own answer (lib/finish-bills-first, the one a paid bill asks), and a fixed
 * price not all billed is the paid gate's own rule (readPriceLeftToBill). Codes and figures, no words:
 * the sheet says them in the reader's language.
 *
 *   bills    one or more open bills (`open`): the sheet names one and prefills its balance, or lists two
 *            or more, each a link, in place of a box the server would refuse. A payment request is an
 *            open bill (settleUp lands on it when it is the only one) and is NAMED as a payment request.
 *   work     Time & Material, no open bill, recorded work on no bill (the billing step's plan): its figure.
 *   price    fixed price, no open bill, the accepted price not all billed: the two figures and what is left.
 *   nothing  no open bill and nothing left to bill: a payment recorded here makes a new invoice.
 *   unread   a read behind work/price failed: said, never "nothing".
 *
 * `paidAhead` is money the customer actually PAID ahead that no bill used yet, and only where it comes
 * off the bill this payment lands on AND is not already off the figure the sheet shows: a bill settleUp
 * writes now (work, nothing, unread). Not the price state (its "left" already counts the paid request
 * as billed) and not an open bill (a sent one takes nothing off, the scout's row 18; a draft's balance
 * is already net of its credit): 0 there (skeptic #82, S1). Money only asked is not money paid. Read
 * as settleUp reads it (readPrepaymentStatesForOutgoing).
 */
export type GetPaidOwed =
  | { kind: "bills" }
  | { kind: "work"; amount: number }
  | { kind: "price"; contract: number; billed: number; left: number }
  | { kind: "nothing" }
  | { kind: "unread" };

export type GetPaidFacts = { ok: false; error: string } | { ok: true; open: OpenBillView[]; owed: GetPaidOwed; paidAhead: number };

export async function readGetPaidFacts(jobId: string): Promise<GetPaidFacts> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: String(ctx.error) };
  const { supabase, orgId, userId } = ctx;
  const t = translator(await callerLang(supabase, userId));
  if (!orgId) return { ok: false, error: t("su_req_noJob") };
  try {
    const [{ data: job, error: jobErr }, { data: bills, error: billsErr }, states] = await Promise.all([
      supabase.from("jobs").select("id, billing_type").eq("id", jobId).eq("org_id", orgId).maybeSingle(),
      supabase
        .from("invoices")
        .select("id, invoice_number, status, total, amount_paid, invoice_kind")
        .eq("job_id", jobId)
        .eq("org_id", orgId)
        .neq("status", "void")
        .order("created_at", { ascending: true }),
      readPrepaymentStatesForOutgoing(supabase, jobId),
    ]);
    if (jobErr) throw jobErr;
    if (billsErr) throw billsErr;
    if (!job) return { ok: false, error: t("su_req_noJob") };
    const billingType = (job as { billing_type?: string | null }).billing_type ?? null;
    const open = openBillViews((bills ?? []) as JobBillRow[]);
    const moneyLeft = cents(states.reduce((sum, s) => sum + Math.max(0, s.moneyLeft), 0));
    let owed: GetPaidOwed;
    if (open.length) owed = { kind: "bills" };
    else if (billingType === "tm") {
      const step = await finishBillingStep(supabase, jobId, { kind: "staff" });
      owed =
        step.kind === "error"
          ? { kind: "unread" }
          : step.kind === "plan" && step.door.kind !== "covered"
            ? { kind: "work", amount: cents(step.work) }
            : { kind: "nothing" };
    } else {
      const price = await readPriceLeftToBill(supabase, jobId, orgId, billingType);
      owed = !price.ok
        ? { kind: "unread" }
        : price.price && price.price.left > 0.005
          ? { kind: "price", contract: price.price.contract, billed: price.price.billed, left: price.price.left }
          : { kind: "nothing" };
    }
    // SAID ONLY WHERE IT IS NOT ALREADY OFF THE FIGURE (skeptic #82, S1): with no open bill settleUp
    // writes the typed figure PLUS this money and the request comes off, so the line is true for work,
    // nothing and unread. The price state's "left" already counts the paid request as billed, and one
    // open draft's balance is already net of its re-resolved credit: saying it there would take it off
    // twice and the customer would leave paying short. 0 there, and 0 on any open bill.
    const paidAhead = open.length === 0 && owed.kind !== "price" ? moneyLeft : 0;
    return { ok: true, open, owed, paidAhead };
  } catch (e) {
    // A FAILED READ IS NEVER "NOTHING OWED": said, and the sheet prefills nothing.
    reportError("readGetPaidFacts", e, { jobId });
    return { ok: false, error: t("su_gp_readFailed") };
  }
}
