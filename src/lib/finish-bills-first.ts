/**
 * A JOB IS NEVER ENDED WITH ITS WORK OFF EVERY BILL — AT WHICHEVER DOOR ENDS IT (M3, the money seam).
 *
 * lib/job-status says it in one line: "a status that ENDS the job may only be written by finishing it
 * (which bills first)". cn-v1039 shipped TWO doors that end a job and only one of them billed:
 *
 *   · Finish Job (jobs/actions finishJob) — a PERSON presses it. It reads this step, builds the Final
 *     as a draft through the card's own door, and only then writes the finish.
 *   · a bill PAID IN FULL (lib/complete-job-when-paid), reached from EVERY payment door through
 *     lib/after-payment-landed — Stripe, Tap to Pay, Record Payment, a deposit matched out of the bank
 *     file. It read the invoice, the job's status and the job's other bills, and wrote the finish. It
 *     never asked what the job had WORKED.
 *
 * So Erik bills part of a time-and-materials job, the customer taps Pay on the emailed link, and the
 * job goes complete with hours and receipts no bill claims — never drafted, never named, nowhere. That
 * is the Tess J-002 failure (19.5 h off every bill) reached from the customer's own Pay button, and
 * there was no net under it either: migration 0371's Done, Not Billed pile EXCLUDES a job that has a
 * live bill, so a job with a paid one never lands in it.
 *
 * ONE PLACE DECIDES. This module is the billing step, and both doors call `finishBillingStep`. Nothing
 * here is copied from the other door: the plan, the door, the figures and the words are one read.
 *
 * WHY THE TWO DOORS THEN DO DIFFERENT THINGS WITH THE SAME ANSWER, on purpose:
 *
 *   Finish Job is a PERSON saying "this job is done". It holds a staff session, so it can build the
 *   Final (createInvoiceForJob / createProgressReportInvoice both require one), and the person has
 *   already read what the press will build (finishJobPreview). It bills, then finishes.
 *
 *   A paid bill is an INFERENCE from money landing — nobody said the job is done. It runs in a Stripe
 *   Route Handler on a service client with no staff session, so it CANNOT build a draft: the invoice
 *   builders are "use server" actions behind requireStaff, and a second copy of them that skipped that
 *   guard would be a bill minted by a webhook with no person behind it. And it must not: the gate's own
 *   third rule already says a job with an open bill is still open (a draft still being built means the
 *   job is not done), so building a draft and then completing the job would contradict the rule in the
 *   same breath. Hours and receipts with no document yet are the same thing one step earlier — so rule
 *   3 is widened from "is there an open BILL?" to "is there open WORK?", and the inference does not
 *   hold. The job stays as it is, and the person is TOLD, in words that name the hours, the receipts
 *   and the job (lib/after-payment-landed rings it).
 *
 * A FIXED-PRICE JOB IS UNTOUCHED. The price is the price: hours there are not billed separately, so
 * `jobBillsItsActuals` answers no, the step is "skip", and both doors behave exactly as they did. The
 * two complete fixed jobs that carry unclaimed hours today (6.7 h and 3.5 h) must not start appearing
 * anywhere, and they do not.
 *
 * A READ THAT FAILED IS NEVER "NOTHING TO BILL" — that is the whole class of bug this closes. It is an
 * `error`, and at both doors an error leaves the job exactly as it was and says why: a tile that reads
 * "in progress" for one more press is recoverable, 19.5 unbilled hours are not.
 *
 * AND THE STEP IS TOLD WHOSE CLIENT IT HOLDS (`access`, required — review of this lane, high). The two
 * doors do not hold the same client, and the pricing reads behind this step answer DIFFERENTLY to each:
 *
 *   · Finish Job holds an RLS staff client. The bill rates come from the profile_pay view (0215/0216),
 *     because hourly_rate and bill_rate are REVOKED from the authenticated role; the org's settings and
 *     its non-billable job codes are narrowed by RLS.
 *   · the paid-in-full gate can be the Stripe webhook's SERVICE client. RLS is off and auth_org_id() is
 *     null, so profile_pay answers ZERO rows (every bill rate gone, the owner's included — only that
 *     view supplies his, 0286), `organizations ... limit(1)` is an arbitrary one of the companies
 *     sharing this database, and `job_codes` is every company's non-billable codes at once.
 *
 * Called with no scope on that door, none of those three errored: ET's 19.5 h came out priced at
 * another company's $60 default, a $2,000 deposit then "covered" the understated figure, the job went
 * COMPLETE, and the office was pushed to settle $830 back to a customer who owed $925 — this lane's own
 * defect, through the one door it was written for. So the caller's identity is a REQUIRED argument
 * rather than an optional scope a door can forget: a service client pins its org by hand, a staff client
 * keeps the view. (Handing a staff client an org scope is the other half of the same bug: fetchJobLaborRows
 * would then read profiles.bill_rate directly and the revoke would refuse it, turning every Finish Job
 * press into this step's "couldn't read this job's hours and bills".) finish-bills-first.test.ts is the
 * tripwire: no door reaches the work without saying which client it is holding.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { unbilledCardDoor, openDraftOnJob, type CardDoor, type OpenDraft } from "@/lib/actuals-draw";
import { DRAW_KINDS } from "@/lib/invoice-math";
import { jobBillsItsActuals } from "@/lib/invoice-import-rule";
import { fixedBillingsNotYetNetted, unbilledWorkForJob } from "@/lib/unbilled-work";
import { depositCoversWords, paidLeftWorkOffBill, type NotBilled } from "@/lib/finish-job-words";
import { reportError } from "@/lib/observe";
import { formatCurrency } from "@/lib/utils";

/**
 * WHAT FINISHING THIS JOB HAS TO BILL, decided once — for the press, for the modal before it, and for
 * the paid-in-full gate. The door is the Overview card's own (unbilledCardDoor), so a finish bills
 * exactly the "Open: $X" the card shows, through the door the card's button uses.
 *
 *   "skip"   not this rule's business (not T&M, a payment schedule, or nothing unbilled): the job
 *            finishes as it always has.
 *   "error"  a read failed, or billing is mid-upgrade. NEVER "nothing to bill".
 *   "plan"   there is work no bill claims: `door` is how it would be billed, `notBilled` is what it
 *            is (the hours, the receipts, the takes) so every sentence counts it the same way.
 */
export type FinishBillingStep =
  | { kind: "skip" }
  | {
      kind: "error";
      /** For the PERSON WHO PRESSED Finish Job: an imperative is fair, they can press it again. */
      error: string;
      /**
       * THE SAME FACT FOR SOMEBODY WHO PRESSED NOTHING (paidDoorVerdict). The paid door sends this as a
       * push off a customer's own payment, so it has a subject of its own and no "try again": telling a
       * person in the van to retry something they never did is a dead end.
       */
      said: string;
    }
  | {
      kind: "plan";
      door: NonNullable<CardDoor>;
      draft: OpenDraft | null;
      drawBilled: boolean;
      work: number;
      lump: number;
      /** The hours, receipts and takes behind `work`, for the words (finish-job-words notBilledWords). */
      notBilled: NotBilled;
    };

/**
 * WHOSE CLIENT IS ASKING. `staff`: a signed-in office client, which RLS narrows and which reads the
 * rates through the profile_pay view (the columns themselves are revoked, 0216). `service`: the service
 * role, which RLS does not narrow at all — every org-wide read below is pinned to `orgId` by hand, the
 * way the customer portal already pins the same fetcher (lib/portal/job-view). Same shape as
 * InvoiceDocAccess, and for the same reason.
 */
export type BillingAccess = { kind: "staff" } | { kind: "service"; orgId: string };

/** A read that failed, said twice: once to the person who pressed, once to the person who did not. */
const stepError = (error: string, said: string): FinishBillingStep => ({ kind: "error", error, said });

const GATE_UNREAD = stepError(
  "Couldn't read this job's bills just now, so it wasn't finished. Try again in a moment.",
  "the app couldn't check what this job still has to bill, so it wasn't finished.",
);

/**
 * THE JOB IS NOT IN THE COMPANY THE PAYMENT WAS TAKEN FOR — the one thing the gate can see that this
 * step cannot (lib/complete-job-when-paid reads it). Spelled here so every refusal at this door reads
 * alike. [[tenant-isolation-root-cause]]: a rule applied at one read path is a convention.
 */
export const BILLING_STEP_WRONG_COMPANY = stepError(
  "This job isn't in the company this payment was taken for, so nothing was billed and it wasn't finished.",
  "the app found this job in a different company from the payment, so nothing was priced and it wasn't finished.",
);

export async function finishBillingStep(
  supabase: SupabaseClient,
  jobId: string,
  /**
   * REQUIRED, so no door can reach the pricing reads by omission — which is exactly how this lane
   * shipped the webhook pricing ET's hours with another company's rates. See the module note.
   */
  access: BillingAccess,
): Promise<FinishBillingStep> {
  // A SERVICE CLIENT WITH NO COMPANY IS A REFUSAL, NEVER A FALLBACK: the unscoped read is the defect.
  if (access.kind === "service" && !access.orgId) {
    reportError("finishBillingStep.company", new Error("the billing step was handed a service client with no company to price the job's work in"), { jobId });
    return stepError(
      "Couldn't tell which company's rates to price this job's work at, so it wasn't finished and nothing was billed.",
      "the app couldn't tell which company's rates to price this job's work at, so it wasn't finished.",
    );
  }
  // The scope FOLLOWS THE CALLER. A staff client must not get one (fetchJobLaborRows would then read the
  // pay columns 0216 revokes and refuse the whole press); the service role must.
  const scope = access.kind === "service" ? { orgId: access.orgId } : undefined;

  // THE BILLING TYPE IS READ FIRST, AND ALONE (review of this lane, medium). jobBillsItsActuals is
  // `tm && no milestones`, so for anything but T&M the answer is already no whatever the schedule says —
  // and a fixed-price job must never be blocked, or announced, by a read that cannot change its answer.
  // It used to share one Promise.all with the schedule and the draws, and any one of the three blipping
  // returned `error`: a fixed job then failed to finish on its own paid bill and rang the whole office
  // under "Still to bill", on a job where the extension IS the price. The monotonicity this leans on is
  // pinned in finish-bills-first.test.ts. (A failed billing_type read still refuses: the type is unknown.)
  const jobRead = await supabase.from("jobs").select("billing_type").eq("id", jobId).maybeSingle();
  if (jobRead.error) {
    reportError("finishBillingStep.type", jobRead.error, { jobId });
    return GATE_UNREAD;
  }
  const billingType = (jobRead.data as { billing_type?: string | null } | null)?.billing_type ?? null;
  if (!jobBillsItsActuals(billingType, 0)) return { kind: "skip" };

  const [schedRead, drawsRead] = await Promise.all([
    supabase.from("payment_milestones").select("id").eq("job_id", jobId).limit(1),
    supabase.from("invoices").select("id").eq("job_id", jobId).neq("status", "void").in("invoice_kind", [...DRAW_KINDS]).limit(1),
  ]);
  if (schedRead.error || drawsRead.error) {
    // The ops sink hears every arm of this step (the daily ritual reads error_events), so a door that
    // refuses on a blip is a row somebody can find, not a sentence that went to one phone.
    reportError("finishBillingStep.gate", schedRead.error ?? drawsRead.error, { jobId });
    return GATE_UNREAD;
  }
  if (!jobBillsItsActuals(billingType, (schedRead.data ?? []).length)) return { kind: "skip" };
  const drawBilled = (drawsRead.data ?? []).length > 0;
  let unbilled: Awaited<ReturnType<typeof unbilledWorkForJob>>;
  let draft: OpenDraft | null;
  let lump: number;
  try {
    [unbilled, draft, lump] = await Promise.all([
      // THE ONE ARGUMENT THIS WHOLE PARAGRAPH IS ABOUT: it switches fetchJobLaborRows onto the explicit
      // profiles read for the service role, pins the org's settings by id instead of limit(1), and
      // org-filters the non-billable job codes. The other two reads below are narrowed by the JOB, which
      // belongs to one company, so they carry no org-wide question for a scope to answer.
      unbilledWorkForJob(supabase, jobId, scope),
      openDraftOnJob(supabase, jobId),
      drawBilled ? fixedBillingsNotYetNetted(supabase, jobId) : Promise.resolve(0),
    ]);
  } catch (e) {
    reportError("finishBillingStep.read", e, { jobId });
    return stepError(
      "Couldn't read this job's hours and bills just now, so it wasn't finished and nothing was billed. Try again in a moment.",
      "the app couldn't read this job's hours and receipts, so it wasn't finished and nothing was billed.",
    );
  }
  if (!unbilled.schemaReady) {
    return stepError(
      "Billing is mid-upgrade for a few minutes, so the hours not yet billed can't be told apart. The job wasn't finished; try again shortly.",
      "billing is mid-upgrade for a few minutes, so the hours not yet billed can't be told apart and the job wasn't finished.",
    );
  }
  const stock = unbilled.stockCount ?? 0;
  const workPending = unbilled.hours > 0 || unbilled.billsCount > 0 || stock > 0;
  const newWork = Math.round((unbilled.laborAmount + unbilled.billsBilled + (unbilled.stockBilled ?? 0)) * 100) / 100;
  const door = unbilledCardDoor({
    openDraft: draft,
    workPending,
    // A pending return alone is not work to bill: Finish never builds a bill for a credit.
    returns: 0,
    total: unbilled.total,
    newWork,
    lumpToNet: lump,
    drawBilled,
    money: formatCurrency,
  });
  if (!workPending || !door) return { kind: "skip" };
  return {
    kind: "plan",
    door,
    draft,
    drawBilled,
    work: unbilled.total > 0.005 ? unbilled.total : newWork,
    lump,
    notBilled: {
      hours: unbilled.hours,
      laborAmount: unbilled.laborAmount,
      billsCount: unbilled.billsCount,
      billsBilled: unbilled.billsBilled,
      stockCount: unbilled.stockCount ?? 0,
      stockBilled: unbilled.stockBilled ?? 0,
    },
  };
}

/**
 * WHAT A PAID BILL MAY DO WITH THAT ANSWER (lib/complete-job-when-paid reads this and nothing else).
 *
 * `finish` is the whole decision, and `say` is the sentence a person gets either way — never a log
 * line only: the money already landed, so a refusal nobody hears is the silence this closes.
 *
 *   skip                  → finish. Nothing was worked that no bill claims.
 *   plan, door "covered"  → finish, and SAY IT. A deposit not yet taken off a bill covers the work, so
 *                           no bill is ever built for it; the job is ending, so the figures are said
 *                           here or nowhere (depositCoversWords, exactly as Finish Job says them).
 *   plan, any other door  → DO NOT finish, and say what is waiting and which door bills it.
 *   error                 → DO NOT finish, and say so. A read that failed is not "nothing to bill".
 */
/**
 * `say` AND `title` ARE ONE THING, in the type: the sentence a person gets and what that sentence IS.
 * The title used to be guessed at the ringing end from whether the job completed, so a read that FAILED
 * went out as "Still to bill" — a claim about the job's money that nobody had checked, and the one alarm a
 * fixed-price job must never raise. Pairing them here means no reader can ring one without the other, and
 * none can be dropped on the way. `why` is the log's own short reason and is not a sentence for anybody.
 */
export type PaidDoorVerdict = { finish: boolean; why: string } & ({ say: string; title: string } | { say: null; title: null });

export function paidDoorVerdict(step: FinishBillingStep, jobSaid: string): PaidDoorVerdict {
  if (step.kind === "skip") return { finish: true, say: null, title: null, why: "" };
  if (step.kind === "error") {
    return {
      finish: false,
      say: `${jobSaid} was paid off, but ${step.said}`,
      title: "Couldn't check this job's bills",
      why: "the job's hours and bills couldn't be checked, so it wasn't finished",
    };
  }
  if (step.door.kind === "covered") {
    return { finish: true, say: `${jobSaid} is finished. ${depositCoversWords(step.work, step.lump)}`, title: "Job finished", why: "" };
  }
  const said = paidLeftWorkOffBill(jobSaid, step.notBilled);
  return {
    finish: false,
    // Never null in practice (a plan exists only when something is pending), but the fallback keeps
    // the refusal from going out wordless if the figures ever round to nothing.
    say: said ?? `${jobSaid} has work no bill claims yet, so it is not finished.`,
    title: "Still to bill",
    why: "the job has work no bill claims yet, so it isn't finished",
  };
}
