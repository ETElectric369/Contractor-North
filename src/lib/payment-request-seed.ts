/**
 * WHAT THE REQUEST A PAYMENT FORM SHOWS BEFORE ANYTHING IS TYPED (cn-v1177), READ FOR A CALLER WHO
 * IS ALREADY KNOWN (cn-v1190, P1).
 *
 * The office's door (billing/request-actions readPaymentRequestSeed) checks its caller and then reads
 * through here. The job's page reads through here directly, with the facts it already holds: the
 * signed-in client, the company, the viewer's language, and its own reading of the work no bill holds
 * yet. So a job page no longer asks Supabase Auth who is signed in a second time, reads the profile
 * twice more, or works out the unbilled work twice.
 *
 * NOT A "use server" FILE, ON PURPOSE: nothing here is a public endpoint. The caller vouches for who
 * is asking (requireStaff in the door; the page's own staff check and RLS on the page).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Lang } from "@/lib/locale";
import { translator } from "@/lib/i18n";
import { canAcceptPayments, connectStateFromOrg } from "@/lib/stripe-connect";
import { customerUnbilled, unbilledWorkForJob, type UnbilledWork } from "@/lib/unbilled-work";
import { prepaymentsLeft } from "@/lib/prepayments";
import { reportError } from "@/lib/observe";
import { PAY_DOOR_ORG_COLUMNS, liveRequestForQuote, payDoorFacts, readPrepaymentStates, requestRefOf } from "@/lib/payment-request";
import type { PaymentRequestSeed, PrepaymentView } from "@/app/(app)/billing/request-actions";

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

/**
 * The seed, for a caller already known. `work` is the caller's own reading of the job's unbilled work
 * (unbilledWorkForJob over the same client and job), or a promise of it; when it is absent, or came
 * back empty because that read failed, the seed reads it itself, exactly as it always did.
 */
export async function readPaymentRequestSeedAs(
  supabase: SupabaseClient,
  who: { orgId: string | null; lang: Lang },
  jobId: string,
  work?: Promise<UnbilledWork | null> | UnbilledWork | null,
): Promise<PaymentRequestSeed> {
  const { orgId } = who;
  const t = translator(who.lang);
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
    const [{ data: quotes, error: qErr }, { data: org, error: orgErr }, states, unbilledWork] = await Promise.all([
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
      // and the same figure the customer's portal and the Unbilled card show (customerUnbilled). The
      // caller's own reading when it has one; a failed or absent one is read here, as before.
      Promise.resolve(work ?? null)
        .catch(() => null)
        .then((w) => w ?? unbilledWorkForJob(supabase, jobId)),
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
    const unbilled = cents(customerUnbilled(unbilledWork).materials);
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
