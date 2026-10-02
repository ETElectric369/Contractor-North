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
 * is the Tao J-002 failure (19.5 h off every bill) reached from the customer's own Pay button, and
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
  | { kind: "error"; error: string }
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

export async function finishBillingStep(supabase: SupabaseClient, jobId: string): Promise<FinishBillingStep> {
  const [jobRead, schedRead, drawsRead] = await Promise.all([
    supabase.from("jobs").select("billing_type").eq("id", jobId).maybeSingle(),
    supabase.from("payment_milestones").select("id").eq("job_id", jobId).limit(1),
    supabase.from("invoices").select("id").eq("job_id", jobId).neq("status", "void").in("invoice_kind", [...DRAW_KINDS]).limit(1),
  ]);
  if (jobRead.error || schedRead.error || drawsRead.error) {
    return { kind: "error", error: "Couldn't read this job's bills just now, so it wasn't finished. Try again in a moment." };
  }
  const billingType = (jobRead.data as { billing_type?: string | null } | null)?.billing_type ?? null;
  if (!jobBillsItsActuals(billingType, (schedRead.data ?? []).length)) return { kind: "skip" };
  const drawBilled = (drawsRead.data ?? []).length > 0;
  let unbilled: Awaited<ReturnType<typeof unbilledWorkForJob>>;
  let draft: OpenDraft | null;
  let lump: number;
  try {
    [unbilled, draft, lump] = await Promise.all([
      unbilledWorkForJob(supabase, jobId),
      openDraftOnJob(supabase, jobId),
      drawBilled ? fixedBillingsNotYetNetted(supabase, jobId) : Promise.resolve(0),
    ]);
  } catch (e) {
    reportError("finishBillingStep.read", e, { jobId });
    return { kind: "error", error: "Couldn't read this job's hours and bills just now, so it wasn't finished and nothing was billed. Try again in a moment." };
  }
  if (!unbilled.schemaReady) {
    return { kind: "error", error: "Billing is mid-upgrade for a few minutes, so the hours not yet billed can't be told apart. The job wasn't finished; try again shortly." };
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
export type PaidDoorVerdict = { finish: boolean; say: string | null; why: string };

export function paidDoorVerdict(step: FinishBillingStep, jobSaid: string): PaidDoorVerdict {
  if (step.kind === "skip") return { finish: true, say: null, why: "" };
  if (step.kind === "error") {
    return {
      finish: false,
      say: `${jobSaid} was paid off, but ${lowerFirst(step.error)}`,
      why: "the job's hours and bills couldn't be checked, so it wasn't finished",
    };
  }
  if (step.door.kind === "covered") {
    return { finish: true, say: `${jobSaid} is finished. ${depositCoversWords(step.work, step.lump)}`, why: "" };
  }
  const said = paidLeftWorkOffBill(jobSaid, step.notBilled);
  return {
    finish: false,
    // Never null in practice (a plan exists only when something is pending), but the fallback keeps
    // the refusal from going out wordless if the figures ever round to nothing.
    say: said ?? `${jobSaid} has work no bill claims yet, so it is not finished.`,
    why: "the job has work no bill claims yet, so it isn't finished",
  };
}

const lowerFirst = (s: string): string => (s ? s[0].toLowerCase() + s.slice(1) : s);
