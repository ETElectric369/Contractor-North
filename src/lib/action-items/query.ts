import { cache } from "react";
import { viewerSortsBank } from "@/lib/bank-viewer";
import { createClient } from "@/lib/supabase/server";
import type { ActionItem, NeedsYou, PileName, WaitingItem } from "./types";
import { AFFORDANCES, KIND_STREAM, appointmentAffordances, sortActionItems, waitingForViewer, waitingRow } from "./types";
import { bucketInspections } from "@/lib/inspections";
import { ESTIMATE_VISIT_TYPES } from "@/lib/statuses";
import { invoiceBalance } from "@/lib/invoice-math";
import { invoiceAmount } from "@/lib/invoice-amount";
import { lienStatus } from "@/lib/lien-math";
import { formatCurrency, formatDateShort, formatTime } from "@/lib/utils";
import { tzDayStartUtc } from "@/lib/tz";
import { clockDoorWords } from "@/lib/long-shift";
import { SHORT_FIX } from "@/lib/stock-take";
import { shortDay } from "@/lib/come-back-days";
import { reportError } from "@/lib/observe";
import { loadSupplierDesk, readBooksStart, type SupplierDesk, type SupplierPaperFeed } from "@/app/(app)/bills/supplier-papers";
import type { SupplierPayDue } from "@/app/(app)/bills/supplier-pay-due";
import { supplierDeskFailedItem, supplierPaperActionItem } from "./supplier-paper-item";
import { supplierPayActionItems } from "./supplier-pay-item";
import { readNoJobHoursReach } from "@/lib/already-billed-read";
import { noJobStrayDoors } from "@/lib/already-billed";
import { noJobHoursActionItem } from "./no-job-hours-item";
import { readNoJobHours, type NoJobHours } from "@/lib/no-job-hours";
import { isOpenToBuy, newestListPerJob } from "@/lib/materials-checklist";
import { feederOn, inquiryActionItem } from "./switches";
import { heldJobState, inquiryDueFilter, quoteFollowUpState } from "./due-filters";
import { isMissingColumn } from "@/lib/job-tasks";
import { featureOn, featuresFromOffKey } from "@/lib/features";
import { COSTED_INVOICE_COLUMNS, NEEDS_RETURN_DAYS, costedJobIds, daysAgoStr, detectStrayTime, detectUnbilledWork, rollupWorkedJobs } from "./leak-detectors";
import { NEEDS_A_DAY_STATUSES, companyDay, jobsNeedingADay, type NeedDayJob } from "./jobs-needing-a-day";
import {
  RECEIPT_CATEGORIES,
  RECEIPT_TIE_COLUMNS,
  RECEIPTS_READ_CAP,
  receiptRowJob,
  receiptRowTitle,
  receiptsNotOnABill,
  tieReadFilters,
  type ReceiptDoc,
} from "./receipts-not-on-a-bill";
import { foldWaitingRows, readNeedsYouWaits, waitKey, type NeedsYouWaits } from "./needs-you-waits";
import { codeCount, isTrayPaper, rollUpPiles, sqlCount, type PileCount } from "./piles";
import { firstNameOf, jobWords } from "./words";
import type { PaperTie } from "@/lib/job-photos";

/**
 * Count for the dock Home badge: the length of NOW, from the SAME build as the list, so the badge
 * can never disagree with the list it summarizes (a parallel set of count-only queries inevitably
 * drifts from the list's per-row filters and leaves a "phantom badge" that never clears). A pile
 * counts one; the Waiting fold never counts.
 */
export async function getActionItemsCount(ctx: {
  todayStr: string;
  isStaff: boolean;
  userId: string;
  /** ORG timezone — see getActionItems. Optional so a caller that hasn't got it yet still works. */
  tz?: string;
  /** The switched-off features — see getActionItems. */
  off?: string;
}): Promise<number> {
  return (await getActionItems(ctx)).now.length;
}

const ORGANIZE_LABEL: Record<string, string> = {
  receipt: "Receipt to file",
  note: "Note to review",
  job_document: "Document to file",
};

// An unpaid invoice this many days old (by created_at) reaches the inbox even when
// it has no due_date set yet — net-30 is the common term, so 30 days unpaid is the
// point it's worth chasing regardless of whether a due_date was ever entered.
const INVOICE_STALE_DAYS = 30;

// A sent quote/estimate with no reply for this many days has gone quiet — time to
// nudge the customer before the lead cools off entirely.
const QUOTE_QUIET_DAYS = 7;
// ...and one whose valid-until window closes within this many days (or already
// passed) is urgent regardless of age — the offer is about to die on the vine.
const QUOTE_EXPIRY_SOON_DAYS = 5;

/** How many jobs the Jobs Needing A Day read looks at (newest first); more says "N+". */
const JOBS_DAY_READ_CAP = 200;
/** Ids per request when a read names many records: no request's address grows too long. */
const ID_CHUNK = 80;

/**
 * THE single union behind Needs You — DECISIONS ONLY: money (overdue/quiet/draft), leads, the rest
 * (contracts/liens/captures), the leak detectors, visits, and jobs needing a day. Projects rows from
 * the existing tables onto one ActionItem[] (Now) and one WaitingItem[] (the fold). RLS scopes to the
 * org; a tech's view is scoped to his own visits.
 *
 * TASKS ARE DELIBERATELY NOT FED HERE. To-dos live in exactly three places —
 * Today's 6 on My Day, /tasks (grouped by due), and the schedule's per-day due
 * lines. The old task feeder counted every undated task as "due now" forever,
 * which is exactly what the badge invariant (types.ts) forbids: no count may be
 * the length of an unbounded or undated set. Do not re-add a task feeder.
 */
/**
 * ONE FAN-OUT PER REQUEST (2026-09-08 — Erik: "taking a super long time to load anything on the
 * phone app"). /planner asks for the LIST and the app shell asks for its COUNT, so opening My Day
 * would run this union TWICE. React's cache() memoises on the primitive arguments for the life of a
 * single request, so the second caller awaits the first one's promise. Keyed on primitives
 * deliberately: cache() compares arguments with Object.is, and an object literal is a fresh
 * reference every call — it would never hit. Both lists come from this one call.
 */
const actionItemsForRequest = cache(
  (todayStr: string, isStaff: boolean, userId: string, tz: string, off: string): Promise<NeedsYou> =>
    buildActionItems({ todayStr, isStaff, userId, tz: tz || undefined, off }),
);

export function getActionItems(ctx: {
  todayStr: string;
  isStaff: boolean;
  userId: string;
  /** ORG timezone — see the day-cut note below. Optional: without it the cuts fall back to the
   *  old session-zone (UTC) literals, which drift by up to a day. */
  tz?: string;
  /** THE SWITCH BOARD (0352), as ONE plain string: lib/features offFeatureKey(settings.features).
   *  A string, not the map, so the cache() key above still hits (it compares with Object.is).
   *  Left out = everything on. */
  off?: string;
}): Promise<NeedsYou> {
  return actionItemsForRequest(ctx.todayStr, ctx.isStaff, ctx.userId, ctx.tz ?? "", ctx.off ?? "");
}

type Read = { data: any[] | null; error?: unknown; count?: number | null };

/** An embed PostgREST may hand back as one row or a one-row array. */
const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

/** A read naming many ids, in chunks side by side: the rows together, the first error if any. */
async function inChunks(ids: readonly string[], read: (chunk: string[]) => PromiseLike<Read>): Promise<Read> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return { data: [], error: null };
  const parts: string[][] = [];
  for (let i = 0; i < uniq.length; i += ID_CHUNK) parts.push(uniq.slice(i, i + ID_CHUNK));
  const res = await Promise.all(parts.map((p) => Promise.resolve(read(p))));
  return { data: res.flatMap((r) => r?.data ?? []), error: res.find((r) => r?.error)?.error ?? null };
}

async function buildActionItems(ctx: {
  todayStr: string;
  isStaff: boolean;
  userId: string;
  tz?: string;
  off?: string;
}): Promise<NeedsYou> {
  const { todayStr, isStaff, userId, tz } = ctx;
  // A switched-off feature's nudges leave the inbox and their reads are skipped; the live
  // obligations (a request, a sent or accepted estimate, a sent contract, a lien clock) keep
  // coming whatever the switches say (action-items/switches).
  const features = featuresFromOffKey(ctx.off);
  const leadsOn = featureOn(features, "leads");
  const supabase = await createClient();
  /* ONE LAW TWO CLOCKS ONE MAP (audit v921). starts_at is timestamptz and a bare `T00:00:00`
     literal is parsed in the SESSION zone — UTC on Supabase — so "before today" actually meant
     before 5 PM YESTERDAY Pacific: a 5:30 PM visit nobody closed out was in neither today's
     agenda (which cuts on org-tz bounds) nor this inbox until the day AFTER. Same mirror on the
     write-up ceiling, which trimmed the day at 4:59 PM. The cut belongs on the ORG's midnight. */
  const dayStartIso = (ymd: string) => (tz ? tzDayStartUtc(ymd, tz).toISOString() : `${ymd}T00:00:00`);
  // The last instant of the org's today = tomorrow's org-midnight, one second back. The day is
  // added on the CALENDAR (daysAgoStr walks date strings), never by adding 86_400_000 ms.
  const endOfToday = tz
    ? new Date(tzDayStartUtc(daysAgoStr(todayStr, -1), tz).getTime() - 1000).toISOString()
    : `${todayStr}T23:59:59`;
  // Forward day cuts for the materials-needed window (yyyy-mm-dd; daysAgoStr with a
  // negative offset walks forward). Same ≤1-day tz fuzz as the other feeders.
  const tomorrowStr = daysAgoStr(todayStr, -1);
  const dayAfterTomorrowStr = daysAgoStr(todayStr, -2);
  const dayOf = (v: string | null | undefined) => companyDay(v, tz ?? null);

  const empty: Promise<Read> = Promise.resolve({ data: [], error: null, count: 0 });

  // THE COMPANY, READ ONCE: the org filter the hand-filtered reads carry, the books start, the
  // waits table. Staff only (a tech's build reads his own visits and nothing else).
  const orgIdP: Promise<string | null> = isStaff && userId
    ? Promise.resolve(supabase.from("profiles").select("org_id").eq("id", userId).maybeSingle()).then(
        (r: any) => (r?.data?.org_id ? String(r.data.org_id) : null),
        () => null,
      )
    : Promise.resolve(null);

  /* THE BOOKS START REPLACES THE AGE LIMITS (NY-feeders). A visit nobody closed out, a walk-through
     nobody wrote up, a visit or a job done and never billed: these aged OUT after 14, 60 or 30 days,
     so work went quiet by the calendar, never by being done. Now they reach back to the day the
     company's books begin (readBooksStart: the day it named, else its first bill, else the day it
     was made), and only work from before that day is left out. Chained onto those four reads
     only, beside the fan-out, never a serial wave of its own. A failed read falls back to the old
     windows and is reported (never a crash of the inbox, never the line drawn in the wrong place). */
  const booksStartP: Promise<string | null> = orgIdP.then(async (orgId) => {
    if (!orgId) return null;
    try {
      return await readBooksStart(supabase, orgId);
    } catch (e) {
      reportError("action-items.booksStart", e);
      return null;
    }
  });
  const floor = (fallbackDays: number): Promise<string> =>
    booksStartP.then((start) => (start && /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : daysAgoStr(todayStr, fallbackDays)));

  // The Recount feeder's read (Shop Stock, Phase 3; used at the end), started beside the big wave
  // below rather than after it: this union is on the app shell's path. Promise.resolve STARTS it (a
  // query builder does nothing until something calls its then).
  const shortsP: Promise<Read> = isStaff
    ? Promise.resolve(supabase
        .from("stock_moves")
        .select("id, qty, created_at, created_by, job_id, item_id, inventory_items(name, unit), jobs(job_number, name)", { count: "exact" })
        .eq("kind", "short")
        .is("settled_by", null)
        .is("undone_at", null)
        .order("created_at", { ascending: true })
        .limit(50))
    : Promise.resolve({ data: [], error: null });

  // "HEY YOU, HERE'S A BILL, WHAT'S IT FOR?" (Bills plan, Wave A). Staff only: the cards carry
  // prices, and a tech never sees one. Started now so its reads ride alongside the fan-out below
  // instead of adding a serial wave; awaited at the end. A failure is never a crash of the inbox,
  // and never silent: a thrown read comes back as `failed`, which My Day says in one line.
  // The same read brings the Pay By line ("Pay CED $X By Oct 10") and the papers waiting on a credit.
  const supplierDeskP: Promise<SupplierDesk | null> = isStaff
    ? loadSupplierDesk(supabase, userId, todayStr).catch((): SupplierDesk => ({ papers: null, payDue: [], failed: { papers: true, pay: true } }))
    : Promise.resolve(null);
  const supplierPapersP: Promise<SupplierPaperFeed | null> = supplierDeskP.then((d) => d?.papers ?? null);

  // HOURS ON NO JOB (the duplicate punches, 2026-09-26): every past-day shift nobody put on a job,
  // with no age limit, as ONE rolled-up line. Its own read, beside the fan-out; `failed` when the
  // read broke, which the line says rather than showing nothing.
  const noJobP: Promise<{ summary: NoJobHours | null; failed: boolean }> = isStaff && tz
    ? readNoJobHours(supabase, { tz, todayStr })
        .then((summary) => ({ summary, failed: summary === null }))
        .catch(() => ({ summary: null, failed: true }))
    : Promise.resolve({ summary: null, failed: false });
  // The rollup's Already Billed door (1b below) asks whether a sent invoice with no job could hold
  // hours: chained off the rollup's own read, only when it found shifts, so its two reads ride beside
  // the fan-out instead of adding a serial wave to every staff build. A lost read offers the door.
  const noJobReachP: Promise<boolean> = noJobP.then(async (n) => {
    if (!isStaff || !n.summary?.shifts.length) return false;
    try {
      const orgId = (await orgIdP) ?? "";
      return orgId ? (await readNoJobHoursReach(supabase, orgId, [])).canHold : true;
    } catch {
      return true;
    }
  });

  // ── The four aged reads, floored by the books start (chained, started now) ──
  // Visits from PAST days nobody closed out. absorbed=false (0237): a booking that became a job is
  // the job's business now. The ceiling is the org's midnight: today's visits are the agenda's rows.
  // A tech's own visits keep the two-week window: they only open for him (closing one out is the
  // office's), and his build reads nothing else.
  const apptP: Promise<Read> = (isStaff ? floor(14) : Promise.resolve(daysAgoStr(todayStr, 14))).then((from) => {
    let q = supabase
      .from("appointments")
      .select("id, type, title, starts_at, status, job_id, inquiry_id, assigned_to, customers(name)", { count: "exact" })
      .eq("status", "scheduled")
      .eq("absorbed", false)
      .gte("starts_at", dayStartIso(from))
      .lt("starts_at", dayStartIso(todayStr));
    if (!isStaff) q = q.eq("assigned_to", userId);
    return q.order("starts_at", { ascending: true }).limit(50);
  });
  // ── Walk-throughs that HAPPENED and have no estimate — staff only ───────────
  // The visit is the expensive part and it is already spent; until it becomes an estimate it earns
  // nothing.
  const inspP: Promise<Read> = isStaff && feederOn("inspection_writeup", features)
    ? floor(60).then((from) =>
        supabase
          .from("appointments")
          .select("id, type, title, status, starts_at, capture, inquiry_id, job_id, outcome, customers(name), inquiries(name)", { count: "exact" })
          .eq("absorbed", false) // a booking absorbed into its job stopped being a visit (0237)
          .in("type", [...ESTIMATE_VISIT_TYPES])
          .gte("starts_at", dayStartIso(from))
          .lte("starts_at", endOfToday)
          .order("starts_at", { ascending: false })
          .limit(100),
      )
    : empty;
  // ── Service calls / job-days that HAPPENED and have no bill — THE NORA HOLE ──
  const doneWorkP: Promise<Read> = isStaff
    ? floor(60).then((from) =>
        supabase
          .from("appointments")
          .select("id, type, title, status, starts_at, job_id, customers(name), inquiries(name)", { count: "exact" })
          .eq("absorbed", false)
          .in("type", ["service_call", "job"])
          .eq("status", "completed")
          .gte("starts_at", dayStartIso(from))
          .order("starts_at", { ascending: false })
          .limit(100),
      )
    : empty;
  // THE JOB-SHAPED NORA HOLE: a job flipped to complete through the status dropdown earned money
  // the appointment feeder can never see (below).
  const doneJobsP: Promise<Read> = isStaff
    ? floor(30).then((from) =>
        supabase
          .from("jobs")
          .select("id, job_number, name, status, updated_at, customers(name)", { count: "exact" })
          .eq("status", "complete")
          .gte("updated_at", dayStartIso(from))
          .order("updated_at", { ascending: false })
          .limit(50),
      )
    : empty;

  // THE HELD JOBS (NY-hold, 0366): every job on hold, with its reason, its day and who held it (the
  // profile through jobs_hold_by_fkey). A day today or earlier, or no day at all, is a Reminder on
  // Now; a later day waits in the fold. Before 0366 (no columns) the old rule runs alone: a hold
  // untouched for a week, with no Snooze.
  const heldP: Promise<Read & { withDay: boolean }> = isStaff
    ? orgIdP.then(async (orgId) => {
        const base = "id, job_number, name, updated_at, hold_reason, customers(name)";
        const read = (cols: string) => {
          let q = supabase.from("jobs").select(cols, { count: "exact" }).eq("status", "on_hold");
          if (orgId) q = q.eq("org_id", orgId);
          return q.order("updated_at", { ascending: true }).limit(100);
        };
        const withDay = await read(`${base}, hold_until, hold_by, holder:profiles!jobs_hold_by_fkey(full_name)`);
        if (!withDay.error) return { ...(withDay as Read), withDay: true };
        if (!isMissingColumn(withDay.error)) {
          // A failed read is no holds on the list (never a crash of the inbox), and it is reported.
          reportError("action-items.holds", withDay.error);
          return { data: [], error: withDay.error, withDay: false };
        }
        const cutoff = new Date(Date.now() - 7 * 864e5).toISOString();
        let old = supabase.from("jobs").select(base, { count: "exact" }).eq("status", "on_hold").lt("updated_at", cutoff);
        if (orgId) old = old.eq("org_id", orgId);
        const res = await old.order("updated_at", { ascending: true }).limit(100);
        return { ...(res as Read), withDay: false };
      })
    : Promise.resolve({ data: [], error: null, withDay: false });

  // RECEIPTS NOT ON A BILL: the receipt and bill papers on jobs since the books start (the ties
  // read and the names ride the second wave).
  const receiptsP: Promise<Read | null> = isStaff
    ? Promise.all([orgIdP, floor(60)]).then(([orgId, from]) => {
        if (!orgId) return null;
        return supabase
          .from("documents")
          .select("id, name, category, file_url, job_id, uploaded_by, created_at, jobs(job_number, name)", { count: "exact" })
          .eq("org_id", orgId)
          .in("category", [...RECEIPT_CATEGORIES])
          .not("job_id", "is", null)
          .gte("created_at", dayStartIso(from))
          .order("created_at", { ascending: false })
          .limit(RECEIPTS_READ_CAP) as PromiseLike<Read>;
      })
    : Promise.resolve(null);

  // ENDLESS ROWS GET A SNOOZE (0367): this company's waits whose day hasn't come. Not ready (the
  // table isn't there yet, or the read failed): no Snooze door, and nothing folds.
  const waitsP: Promise<NeedsYouWaits> = isStaff
    ? orgIdP.then((orgId) => readNeedsYouWaits(supabase, orgId, todayStr))
    : Promise.resolve({ ready: false, waits: new Map() });

  const [
    jobsR,
    inqR,
    inqLaterR,
    apptR,
    orgR,
    invR,
    quoteR,
    acceptedR,
    draftR,
    conR,
    lienR,
    openTimeR,
    recentTimeR,
    nonBillableR,
    matJobsR,
    matSegR,
    inspR,
    inspQuoteR,
    billedJobR,
    doneWorkR,
    draftQuoteR,
    doneJobsR,
    heldR,
    receiptsR,
    waitsR,
  ] = (await Promise.all([
    // JOBS NEEDING A DAY — staff only. ONE read of every job still being done (never on hold), with
    // its schedule segments and its latest time entry; jobsNeedingADay decides which have nothing
    // ahead of them. It replaced "no scheduled_start" and the three-day "nothing scheduled next".
    // The entries' foreign key is named: time_entries also points at itself (split_from), and the
    // embed must never have two paths to choose between.
    isStaff
      ? supabase
          .from("jobs")
          .select(
            "id, job_number, name, status, scheduled_start, scheduled_end, created_at, customers(name), job_schedule_segments(start_date, end_date), time_entries!time_entries_job_id_fkey(clock_in)",
            { count: "exact" },
          )
          .in("status", [...NEEDS_A_DAY_STATUSES])
          .order("created_at", { ascending: false })
          .order("clock_in", { referencedTable: "time_entries", ascending: false })
          .limit(1, { referencedTable: "time_entries" })
          .limit(JOBS_DAY_READ_CAP)
      : empty,
    // New/contacted leads due for follow-up — staff only. A snoozed lead (new or contacted) is off
    // Now until its day (inquiryDueFilter) and waits in the fold (the next read). A LIVE OBLIGATION:
    // it runs with Leads off too (Call Back).
    isStaff
      ? supabase
          .from("inquiries")
          .select("id, name, phone, status, next_follow_up_at, converted_at, created_at", { count: "exact" })
          .in("status", ["new", "contacted"])
          .is("converted_at", null)
          .or(inquiryDueFilter(todayStr))
          .order("created_at", { ascending: true })
          .limit(50)
      : empty,
    // ...and the ones whose day is later: the fold, with the day each comes back.
    isStaff
      ? supabase
          .from("inquiries")
          .select("id, name, status, next_follow_up_at")
          .in("status", ["new", "contacted"])
          .is("converted_at", null)
          .gt("next_follow_up_at", todayStr)
          .order("next_follow_up_at", { ascending: true })
          .limit(50)
      : empty,
    apptP,
    // Captures awaiting a filing decision — staff only. What each one is decides where it sorts
    // (the /bills tray or Organize: isTrayPaper).
    isStaff
      ? supabase
          .from("organized_items")
          .select("id, kind, status, title, job_id, category, source, doc_type, file_url, summary, amount, created_at", { count: "exact" })
          .eq("status", "needs_review")
          .order("created_at", { ascending: false })
          .limit(50)
      : empty,
    // Money/legal — staff only. Unpaid invoices (A/R) that need chasing: past their due date, OR
    // simply old; the age cut is applied per-row below; the query just pulls the open A/R.
    isStaff
      ? supabase
          .from("invoices")
          .select("id, invoice_number, total, amount_paid, due_date, status, created_at, customers(name)", { count: "exact" })
          .in("status", ["sent", "partial", "overdue"])
          .order("created_at", { ascending: true })
          .limit(50)
      : empty,
    // Quotes/estimates sent but not answered. follow_up_at (0366, Still Waiting and Nort's
    // quote.followUp) is read when the column exists; before 0366 the same read runs without it,
    // the old rule alone decides, and no Still Waiting is drawn.
    isStaff
      ? (async () => {
          const read = (cols: string) =>
            supabase.from("quotes").select(cols, { count: "exact" }).eq("status", "sent").order("created_at", { ascending: true }).limit(50);
          const base = "id, quote_number, doc_type, status, total, valid_until, created_at, customers(name)";
          const withDay = await read(`${base}, follow_up_at`);
          return withDay.error && isMissingColumn(withDay.error) ? { ...(await read(base)), noFollowUp: true } : withDay;
        })()
      : empty,
    // Accepted estimates — THE WIN. The job's scheduled_start and status (joined) say whether it has
    // been handled; a held job waits with its own day.
    isStaff
      ? supabase
          .from("quotes")
          .select("id, quote_number, doc_type, accepted_at, job_id, customers(name), jobs:job_id(job_number, name, scheduled_start, status)", { count: "exact" })
          .eq("status", "accepted")
          .order("accepted_at", { ascending: false })
          .limit(50)
      : empty,
    // Draft invoices — billed-up work that never went out the door. Every draft, set aside or not:
    // a set-aside one waits in the fold with its day, and comes back at once when its job is done.
    isStaff
      ? supabase
          .from("invoices")
          // amount_paid: a draft can carry a deposit, and the item says what is due against it.
          .select("id, invoice_number, total, amount_paid, status, created_at, hold_until, hold_reason, job_id, customers(name), jobs:job_id(job_number, name, status)", { count: "exact" })
          .eq("status", "draft")
          .order("created_at", { ascending: true })
          .limit(50)
      : empty,
    // Contracts sent to the customer but not yet signed (chase the signature).
    isStaff
      ? supabase
          .from("contracts")
          .select("id, contract_number, status, job_id, jobs(job_number, name)", { count: "exact" })
          .eq("status", "sent")
          .order("created_at", { ascending: true })
          .limit(50)
      : empty,
    // Lien records with a still-open deadline; urgency computed per-row below.
    isStaff
      ? supabase
          .from("lien_records")
          .select("id, job_id, first_furnished_date, completion_date, prelim_sent_at, lien_recorded_at, noc_recorded, gc_name, lender_name, jobs(job_number, name)", { count: "exact" })
          .or("prelim_sent_at.is.null,lien_recorded_at.is.null")
          .limit(100)
      : empty,
    // (North's own bug reports are not read here: they are Bug Watch's, with its own count on the
    // avatar row. Wave 1, NY-list: a company's Needs You never carries them.)
    // ── The end-of-day money-leak sweep feeders (staff only) ──
    // Every open clock, whatever its age; also who is ON a job right now (Jobs Needing A Day).
    // profile_id: the row's door reads "Clock Out" on the viewer's own clock, his name on anyone else's.
    isStaff
      ? supabase
          .from("time_entries")
          .select("id, status, job_id, clock_in, clock_out, job_code, profile_id, profiles(full_name)")
          .eq("status", "open")
          .order("clock_in", { ascending: true })
          .limit(50)
      : empty,
    // Recent entries (bounded window): the closed-with-no-job stray rule and the worked-jobs rollup
    // behind No Costs Yet.
    isStaff
      ? supabase
          .from("time_entries")
          .select("id, status, job_id, clock_in, clock_out, job_code, profiles(full_name)")
          .gte("clock_in", daysAgoStr(todayStr, NEEDS_RETURN_DAYS))
          .order("clock_in", { ascending: false })
          .limit(200)
      : empty,
    // The time codes the org marked non-billable (Shop, PTO): a job-less entry on one of them was
    // filed that way on purpose. Labor billing's own predicate, so the two never disagree.
    isStaff ? supabase.from("job_codes").select("code").eq("billable", false) : empty,
    // ── Materials-routing candidates (staff only) — jobs the crew is about to stand on: scheduled
    // today/tomorrow, plus multi-day segments covering the same window.
    isStaff
      ? supabase
          .from("jobs")
          .select("id, job_number, name, status, scheduled_start")
          .gte("scheduled_start", todayStr)
          .lt("scheduled_start", dayAfterTomorrowStr)
          .limit(50)
      : empty,
    isStaff
      ? supabase
          .from("job_schedule_segments")
          .select("start_date, jobs(id, job_number, name, status)")
          .lte("start_date", tomorrowStr)
          .gte("end_date", todayStr)
          .limit(50)
      : empty,
    inspP,
    // The "written up" signal — an estimate linked to the lead, the job, or (for a lead-less
    // Inspect-now) the capture's own quote id.
    isStaff && feederOn("inspection_writeup", features) ? supabase.from("quotes").select("id, inquiry_id, job_id").limit(2000) : empty,
    // MONEY IS AN OUTCOME (0205): a job carrying real billing is finished. Draft invoices don't
    // count — a draft is work in progress, not a decision. (Also: an estimate draft whose job has
    // real billing is no longer an estimate to send.)
    isStaff
      ? supabase.from("invoices").select("job_id").not("job_id", "is", null).not("status", "in", "(draft,void)").limit(5000)
      : empty,
    doneWorkP,
    // ── Estimates started and never sent ───────────────────────────────────────
    // The first autosave stamps the lead converted, so an abandoned draft takes the LEAD off every
    // list with it. Older than 2 days: a draft he's actively building today isn't nagging material.
    // Its job's status and its line count ride along: the Send sheet names how many lines go out.
    isStaff && feederOn("quote_draft", features)
      ? supabase
          .from("quotes")
          .select("id, quote_number, title, total, created_at, job_id, jobs:job_id(status), quote_line_items(count), customer_name_snapshot:customers(name), inquiries(name)", { count: "exact" })
          .eq("status", "draft")
          .lt("created_at", new Date(Date.now() - 2 * 86_400_000).toISOString())
          .order("created_at", { ascending: true })
          .limit(50)
      : empty,
    doneJobsP,
    heldP,
    receiptsP,
    waitsP,
  ])) as [
    Read, Read, Read, Read, Read, Read, Read & { noFollowUp?: boolean }, Read, Read, Read, Read, Read, Read, Read, Read, Read, Read, Read, Read, Read, Read, Read,
    Read & { withDay: boolean }, Read | null, NeedsYouWaits,
  ];

  // Built without `stream`, stamped once at the end from KIND_STREAM — one assignment site means a
  // new kind can't ship with a forgotten/mismatched stream.
  const items: Omit<ActionItem, "stream">[] = [];
  const waiting: WaitingItem[] = [];
  const counts: Partial<Record<PileName, PileCount>> = {};
  const todayMs = Date.parse(todayStr);
  const billedJobs = new Set(((billedJobR.data ?? []) as { job_id: string }[]).map((r) => r.job_id).filter(Boolean));
  const clockedInJobIds = new Set(((openTimeR.data ?? []) as any[]).map((e) => e.job_id).filter(Boolean) as string[]);

  // ── THE WIN: an accepted estimate whose job still has no date. Urgency 2, money stream → the top,
  // so a "yes" can never again slip by unseen. Its Pick A Day puts the day on the JOB.
  const wonJobIds = new Set<string>();
  {
    for (const a of (acceptedR.data ?? []) as any[]) {
      const job = one(a.jobs) as any;
      if (job?.scheduled_start) continue; // scheduled → win captured, item self-clears
      // A JOB THAT'S OVER DOESN'T NEED A DATE (work ending is an outcome, 0205), and a held one
      // waits with its own day and reason (NY-feeders: holds quiet the nudges).
      if (job?.status === "complete" || job?.status === "cancelled" || job?.status === "on_hold") continue;
      if (a.job_id) wonJobIds.add(String(a.job_id));
      const who = one(a.customers as any)?.name ?? null;
      items.push({
        id: a.id,
        kind: "quote_accepted",
        title: `${who ? `${who} said yes` : "Accepted"} · ${a.quote_number || "Estimate"}`,
        subtitle: job ? jobWords(job) : null,
        who: null,
        when: a.accepted_at ?? null,
        urgency: 2,
        done: false,
        href: a.job_id ? `/jobs/${a.job_id}` : `/quotes/${a.id}`,
        affordances: a.job_id ? ["schedule", "open"] : AFFORDANCES.quote_accepted,
        targetId: a.job_id ?? null,
      });
    }
    counts.won_needs_a_day = codeCount(acceptedR);
  }

  // ── LEADS. One projection (action-items/switches): with Leads off the same request reads "New
  // Request From …" and carries the number its Call Back dials.
  for (const q of (inqR.data ?? []) as any[]) items.push({ ...inquiryActionItem(q, todayStr, leadsOn), since: q.created_at ?? null });
  counts.leads_to_call = sqlCount(inqR);
  for (const q of (inqLaterR.data ?? []) as any[]) {
    const name = String(q.name ?? "").trim() || "Someone";
    const row = waitingRow({
      id: q.id,
      kind: "inquiry",
      title: leadsOn ? name : `Request From ${name}`,
      why: q.status === "new" ? "Snoozed" : "Follow Up",
      backOn: q.next_follow_up_at,
      href: `/leads?focus=${q.id}`,
    });
    if (row) waiting.push(row);
  }
  // A visit with a lead rides the lead's row (one fact, one row).
  const leadIds = new Set<string>([...((inqR.data ?? []) as any[]), ...((inqLaterR.data ?? []) as any[])].map((q) => String(q.id)));

  // ── A finished walk-through, waiting to become money. bucketInspections is the SAME function
  // /inspections uses, so the inbox and the list can never disagree about what is outstanding.
  const writeUpApptIds = new Set<string>();
  {
    const qs = (inspQuoteR.data ?? []) as any[];
    const { toWriteUp } = bucketInspections(
      (inspR.data ?? []) as any[],
      new Set(qs.map((q) => q.inquiry_id).filter(Boolean)),
      new Set(qs.map((q) => q.job_id).filter(Boolean)),
      new Date(),
      new Set(qs.map((q) => q.id).filter(Boolean)),
      billedJobs, // jobs with real (non-draft, non-void) billing — the visit already turned into money
    );
    for (const a of toWriteUp) {
      const who = (a as any).customers?.name ?? (a as any).inquiries?.name ?? null;
      items.push({
        id: a.id,
        kind: "inspection_writeup",
        title: a.title || "Site inspection",
        subtitle: who,
        who: null,
        // The DAY IT HAPPENED, not a due date — how long this has been sitting is the pressure.
        when: a.starts_at ?? null,
        urgency: 1,
        done: false,
        href: `/quotes/new?capture=${a.id}${a.inquiry_id ? `&inquiry=${a.inquiry_id}` : ""}`,
        affordances: AFFORDANCES.inspection_writeup,
      });
      writeUpApptIds.add(a.id);
    }
    counts.walkthroughs_to_write_up = codeCount(inspR);
  }

  // ── VISITS NOBODY CLOSED OUT.
  for (const a of (apptR.data ?? []) as any[]) {
    if (!isStaff && a.assigned_to !== userId) continue;
    if (writeUpApptIds.has(a.id)) continue; // already surfaced as a write-up
    if (a.inquiry_id && leadIds.has(String(a.inquiry_id))) continue; // rides its lead's row
    const type = a.type ? `${a.type[0].toUpperCase()}${a.type.slice(1)}`.replace(/_/g, " ") : null;
    items.push({
      id: a.id,
      kind: "appointment",
      title: a.title || type || "Appointment",
      subtitle: [one(a.customers as any)?.name ?? null, type].filter(Boolean).join(" · ") || null,
      who: null,
      when: a.starts_at,
      urgency: 0,
      done: false,
      // "When I click on something I wanted to open that thing not the calendar."
      href: `/appointments/${a.id}`,
      affordances: appointmentAffordances(isStaff),
    });
  }
  counts.visits_to_close_out = codeCount(apptR);

  // ── PAPERS AND NOTES. A paper the /bills tray sorts (isTrayPaper) is Sort It on /bills; a note, or
  // a paper Organize files (a plan read as not a cost, a picture asking "What is this?"), is File It
  // in Organize. A BANK DOWNLOAD is the owner's money: only a viewer who sorts them sees one, on its
  // own card, never in a pile.
  {
    const bankOk = ((orgR.data ?? []) as any[]).some((o) => o.category === "Bank Download") ? await viewerSortsBank(supabase, userId) : false;
    for (const o of (orgR.data ?? []) as any[]) {
      const bank = o.category === "Bank Download";
      if (bank && !bankOk) continue;
      const tray = !bank && isTrayPaper(o);
      const note = !bank && !tray && o.kind === "note";
      items.push({
        id: o.id,
        kind: "organize",
        paper: bank ? "bank" : tray ? "tray" : "organize",
        chip: bank ? "Bank Download" : tray ? "Paper To Sort" : note ? "Note To Review" : "To File",
        title: bank ? "Bank Download To Sort" : String(o.title ?? "").trim() || (ORGANIZE_LABEL[o.kind] ?? "To file"),
        subtitle: null,
        who: null,
        when: null,
        since: o.created_at ?? null,
        urgency: 0,
        done: false,
        href: bank || tray ? "/bills#sort-these" : "/organize",
        // A bank download only opens: Set Aside archived it, and Back in Archive is its whole Undo,
        // so a tap here could take every line it counted back without a question.
        affordances: bank ? ["open"] : AFFORDANCES.organize,
      });
    }
    counts.papers_to_sort = codeCount(orgR);
    counts.notes_to_review = codeCount(orgR);
  }

  // ── Unpaid invoices (A/R) — the money the business is owed. Surfaced when past their due date OR
  // simply old (created INVOICE_STALE_DAYS+ ago), so an unpaid invoice reaches the inbox by AGE even
  // before a due_date is entered. A hold on the job never quiets this: money is never hidden.
  const overdueEmitted = new Set<string>(); // one balance, ONE money row — the visit block checks this
  for (const inv of (invR.data ?? []) as any[]) {
    const balance = invoiceBalance(inv.total, inv.amount_paid);
    if (balance < 0.005) continue; // effectively paid; status just lagging
    const daysOverDue = inv.due_date ? Math.floor((todayMs - Date.parse(inv.due_date)) / 86_400_000) : null;
    const daysOld = inv.created_at ? Math.floor((todayMs - Date.parse(inv.created_at)) / 86_400_000) : 0;
    const pastDue = daysOverDue != null && daysOverDue > 0;
    // AGE ONLY SPEAKS WHEN THE DUE DATE DOESN'T: a set, future due date is the answer.
    const stale = daysOld >= INVOICE_STALE_DAYS && !(daysOverDue != null && daysOverDue <= 0);
    if (!pastDue && !stale) continue; // not yet worth chasing
    const overWindow = Math.max(daysOverDue ?? 0, stale ? daysOld - INVOICE_STALE_DAYS : 0);
    const a = invoiceAmount(inv.total, inv.amount_paid);
    items.push({
      id: inv.id,
      kind: "invoice_overdue",
      title: `${inv.invoice_number} · ${a.due} due`,
      subtitle: [one(inv.customers as any)?.name, a.detail].filter(Boolean).join(" · ") || null,
      who: null,
      when: inv.due_date ?? inv.created_at ?? null,
      urgency: overWindow > 14 ? 2 : 1,
      done: false,
      href: `/billing/${inv.id}`,
      affordances: AFFORDANCES.invoice_overdue,
      amount: balance,
    });
    overdueEmitted.add(String(inv.id));
  }
  counts.late_invoices = codeCount(invR);

  // ── Sent estimates gone quiet — once the customer has had it QUOTE_QUIET_DAYS+ with no answer, or
  // the valid-until window is closing/past. THE FOLLOW-UP DAY (0366 quotes.follow_up_at, Still
  // Waiting or Nort's quote.followUp; never valid_until, the customer's offer) wins: a day after
  // today waits in the fold with that day, and on its day it is back even if it isn't 7 days quiet.
  {
    const followUpReady = !quoteR.noFollowUp;
    for (const q of (quoteR.data ?? []) as any[]) {
      const daysOut = q.created_at ? Math.floor((todayMs - Date.parse(q.created_at)) / 86_400_000) : 0;
      const daysToExpiry = q.valid_until ? Math.floor((Date.parse(q.valid_until) - todayMs) / 86_400_000) : null;
      const quiet = daysOut >= QUOTE_QUIET_DAYS;
      const expiring = daysToExpiry != null && daysToExpiry <= QUOTE_EXPIRY_SOON_DAYS;
      const followUp = quoteFollowUpState(q.follow_up_at, todayStr);
      const who = one(q.customers as any)?.name ?? null;
      const doc = (q.doc_type ?? "quote") === "estimate" ? "Estimate" : "Quote";
      if (followUp === "later") {
        const row = waitingRow({
          id: q.id,
          kind: "quote_awaiting",
          title: [who, q.quote_number || doc].filter(Boolean).join(" · "),
          why: "No Answer Yet",
          backOn: q.follow_up_at,
          href: `/quotes/${q.id}`,
        });
        if (row) waiting.push(row);
        continue;
      }
      if (followUp === "none" && !quiet && !expiring) continue; // still fresh — give the customer room
      items.push({
        id: q.id,
        kind: "quote_awaiting",
        title: `${doc} ${q.quote_number} awaiting reply`,
        subtitle: who ?? formatCurrency(Number(q.total ?? 0)),
        who: null,
        // The follow-up day he picked, when that's why it's here; else the expiry (that's the clock
        // that matters); fall back to created so undated offers still sort by age.
        when: (followUp === "due" ? q.follow_up_at : null) ?? q.valid_until ?? q.created_at ?? null,
        since: q.created_at ?? null,
        // Past its valid-until the offer is dying — bump it above the routine chase.
        urgency: daysToExpiry != null && daysToExpiry < 0 ? 2 : 1,
        done: false,
        href: `/quotes/${q.id}`,
        // Still Waiting needs the follow-up day's column (0366); without it, only Lost.
        affordances: followUpReady ? AFFORDANCES.quote_awaiting : AFFORDANCES.quote_awaiting.filter((v) => v !== "snooze"),
        amount: Number(q.total ?? 0),
      });
    }
    counts.no_answer_yet = codeCount(quoteR);
  }

  // ── Draft invoices — money one tap from "sent" sitting in limbo. Every draft surfaces (no age
  // cut): it goes out, gets set aside UNTIL A DAY (it waits in the fold with that day and its
  // reason), or is voided. A set-aside draft whose job is finished comes back at once: the day it
  // was waiting for has come.
  for (const d of (draftR.data ?? []) as any[]) {
    const a = invoiceAmount(d.total, d.amount_paid);
    const due = invoiceBalance(d.total, d.amount_paid);
    const job = one(d.jobs as any) as { job_number?: string | null; name?: string | null; status?: string | null } | null;
    const who = one(d.customers as any)?.name ?? null;
    const until = d.hold_until ? String(d.hold_until).slice(0, 10) : null;
    const setAside = !!until && until > todayStr;
    const jobDone = job?.status === "complete" || job?.status === "cancelled";
    if (setAside && !jobDone) {
      const why = String(d.hold_reason ?? "").trim() || (Number(d.amount_paid ?? 0) > 0 ? "Running Draft" : "Set Aside");
      const row = waitingRow({ id: d.id, kind: "invoice_draft", title: [who, d.invoice_number, a.due].filter(Boolean).join(" · "), why, backOn: until, href: `/billing/${d.id}` });
      if (row) {
        waiting.push(row);
        continue;
      }
    }
    items.push({
      id: d.id,
      kind: "invoice_draft",
      title:
        setAside && jobDone && job
          ? `${jobWords(job)} ${job.status === "complete" ? "Finished" : "Cancelled"} · Send ${d.invoice_number}`
          : `Draft invoice ${d.invoice_number} · ${a.due}`,
      subtitle: [who, setAside && jobDone ? a.due : null, a.detail].filter(Boolean).join(" · ") || null,
      who: null,
      when: d.created_at ?? null,
      // The day it was set aside for came early: it is back on top.
      urgency: setAside && jobDone ? 1 : 0,
      done: false,
      href: `/billing/${d.id}`,
      affordances: AFFORDANCES.invoice_draft,
      amount: due,
    });
  }
  counts.invoices_not_sent = codeCount(draftR);

  // ── WORK DONE, NO BILL (the Nora hole). A completed service call or job-day with no invoice
  //    anchored to it and no billing on its job is money already earned and not yet asked for.
  //    A hold never quiets it (money is never hidden).
  const doneVisitIds = ((doneWorkR.data ?? []) as { id: string }[]).map((a) => String(a.id));

  // ── THE SECOND WAVE: every read that needs a first-wave answer, side by side. ──
  const worked = rollupWorkedJobs((recentTimeR.data ?? []) as any[], todayStr);
  const workedIds = isStaff ? [...worked.keys()].slice(0, 30) : [];
  // Jobs Needing A Day, before the visits read: the ones nothing else puts a day ahead of.
  const needDayPre = jobsNeedingADay({
    jobs: (jobsR.data ?? []) as NeedDayJob[],
    todayStr,
    tz,
    clockedInJobIds,
    wonJobIds,
  });
  const needDayIds = needDayPre.map((f) => f.job.id);
  // Materials-routing candidates: jobs the crew is about to stand on (today/tomorrow, segments), and
  // (below) jobs worked in the last two days. Never a held job: it waits with its own day.
  const matCandidates = new Map<string, { job: { id: string; job_number?: string | null; name?: string | null }; when: string | null }>();
  const matStatusOk = (s: string | null | undefined) => s !== "cancelled" && s !== "complete" && s !== "invoiced" && s !== "on_hold";
  for (const j of (matJobsR.data ?? []) as any[]) {
    if (matStatusOk(j.status)) matCandidates.set(j.id, { job: j, when: j.scheduled_start ?? null });
  }
  for (const s of (matSegR.data ?? []) as any[]) {
    const j = one(s.jobs as any) as any;
    if (!j || !matStatusOk(j.status) || matCandidates.has(j.id)) continue;
    // The day the crew is next on it: the segment's start if still ahead, else today.
    matCandidates.set(j.id, { job: j, when: s.start_date && s.start_date > todayStr ? s.start_date : todayStr });
  }
  const heldRows = (heldR.data ?? []) as any[];
  const receiptDocs = (receiptsR?.data ?? []) as ReceiptDoc[];
  const shortsR = await shortsP;
  const shortRows = shortsR.error ? [] : ((shortsR.data ?? []) as any[]);

  const [settledR, futureApptR, listsR, wBillsR, wPosR, wInvR, wJobsR, tiesR, peopleR] = await Promise.all([
    // The settled signal for done visits: an invoice anchored to the visit (0233). amount_paid rides
    // along because ANCHORED IS NOT PAID ("collect later" anchors a bill with zero collected).
    doneVisitIds.length && isStaff
      ? inChunks(doneVisitIds, (ids) =>
          supabase.from("invoices").select("id, appointment_id, amount_paid").in("appointment_id", ids).neq("status", "void").limit(400),
        )
      : empty,
    // A visit booked for a job needing a day, today or later: something IS ahead of it.
    needDayIds.length
      ? inChunks(needDayIds, (ids) =>
          supabase
            .from("appointments")
            .select("job_id")
            .in("job_id", ids)
            .eq("absorbed", false)
            .eq("status", "scheduled")
            .gte("starts_at", dayStartIso(todayStr))
            .limit(400),
        )
      : empty,
    // THE JOBS' MATERIALS LISTS, one read for every job a row may name ("· 6 to buy", Buy Materials,
    // a hold's "6 to buy", No Costs Yet's costed rule): newest first, so newestListPerJob keeps the
    // job's own list (the one its Materials tab shows).
    isStaff
      ? inChunks([...matCandidates.keys(), ...workedIds, ...needDayIds, ...heldRows.map((j) => String(j.id))], (ids) =>
          supabase
            .from("material_lists")
            .select("id, job_id, created_at, material_list_items(description, quantity, purchased, is_tool)")
            .in("job_id", ids)
            .order("created_at", { ascending: false })
            .order("id", { ascending: false })
            .limit(400),
        )
      : empty,
    // No Costs Yet's other three reads, for the jobs worked in the last two days.
    workedIds.length ? supabase.from("bills").select("job_id").in("job_id", workedIds).limit(200) : empty,
    workedIds.length ? supabase.from("purchase_orders").select("job_id").in("job_id", workedIds).limit(200) : empty,
    // Each line's kind rides along: a materials line on a live invoice is costs on the record
    // (costedJobIds, the one rule the 6 PM push uses too).
    workedIds.length ? supabase.from("invoices").select(COSTED_INVOICE_COLUMNS).in("job_id", workedIds).limit(200) : empty,
    workedIds.length ? supabase.from("jobs").select("id, job_number, name, status, scheduled_start").in("id", workedIds) : empty,
    // Receipts Not On A Bill: the ties that account for those papers (a bill, a supplier's
    // document, petty cash), by document or by file, in chunks side by side.
    receiptDocs.length
      ? Promise.all(
          tieReadFilters(receiptDocs).map((f) =>
            Promise.resolve(supabase.from("organized_items").select(RECEIPT_TIE_COLUMNS).or(f).limit(1000)) as Promise<Read>,
          ),
        ).then((parts): Read => ({ data: parts.flatMap((p) => p?.data ?? []), error: parts.find((p) => p?.error)?.error ?? null }))
      : empty,
    // Whose names the rows say: who snapped a receipt, who took pieces past stock.
    (() => {
      const ids = [...new Set([...receiptDocs.map((d) => d.uploaded_by), ...shortRows.map((r) => r.created_by)].filter(Boolean) as string[])];
      return ids.length ? inChunks(ids, (chunk) => supabase.from("profiles").select("id, full_name").in("id", chunk)) : empty;
    })(),
  ]);
  const nameOf = new Map(((peopleR.data ?? []) as any[]).map((p) => [String(p.id), String(p.full_name ?? "").trim()]));

  // Open lines to buy per job, on the job's ONE list (the newest): the Materials badge, the Buy
  // Materials row and every "to buy" here count exactly these lines. Tools are brought, not bought.
  const lists = (listsR.data ?? []) as any[];
  const toBuyByJob = new Map<string, { description: string; quantity: number }[]>();
  for (const ml of newestListPerJob(lists).values()) {
    const open = ((ml.material_list_items ?? []) as any[]).filter(isOpenToBuy);
    if (open.length) toBuyByJob.set(ml.job_id, open.map((it) => ({ description: it.description, quantity: Number(it.quantity ?? 1) })));
  }
  const toBuyCount = new Map([...toBuyByJob].map(([id, lines]) => [id, lines.length]));

  // ── Done visits and done jobs, no bill (visit_unbilled). ──
  {
    const settled = new Set<string>();
    const billedUnpaid = new Map<string, string>(); // appointment id → invoice id
    for (const r of (settledR.data ?? []) as { id: string; appointment_id: string | null; amount_paid: number | null }[]) {
      if (!r.appointment_id) continue;
      if (Number(r.amount_paid ?? 0) > 0) settled.add(String(r.appointment_id));
      else billedUnpaid.set(String(r.appointment_id), r.id);
    }
    for (const a of (doneWorkR.data ?? []) as any[]) {
      if (settled.has(String(a.id))) continue;
      if (a.job_id && billedJobs.has(a.job_id)) continue;
      const who = one(a.customers as any)?.name ?? one(a.inquiries as any)?.name ?? null;
      const openInvoice = billedUnpaid.get(String(a.id));
      // ONE balance, ONE row: once the anchored invoice ages into invoice_overdue, it isn't twice.
      if (openInvoice && overdueEmitted.has(openInvoice)) continue;
      items.push({
        id: `unbilled-${a.id}`,
        kind: "visit_unbilled",
        // Its chip says the state it is in: billed and waiting on the money, or not billed at all.
        ...(openInvoice ? { chip: "Billed, Not Paid" } : {}),
        title: a.title || "Work done",
        subtitle: who,
        who: null,
        when: a.starts_at ?? null,
        urgency: 1, // earned and unasked-for ages worse than a draft
        done: false,
        // Billed → the open invoice (Get Paid); not billed → the job's Invoices tab, or the visit
        // (which carries Pay now) when it has no job (Bill It).
        href: openInvoice ? `/billing/${openInvoice}` : a.job_id ? `/jobs/${a.job_id}?tab=invoices` : `/appointments/${a.id}`,
        affordances: AFFORDANCES.visit_unbilled,
      });
    }
    /* THE JOB-SHAPED NORA HOLE. A job flipped to complete through the status dropdown (finishJob
       bills atomically; the dropdown doesn't) earned money the appointment feeder above can never
       see. Same kind, same question, same Bill It on the other end — the job page's. */
    for (const j of (doneJobsR.data ?? []) as any[]) {
      if (billedJobs.has(j.id)) continue; // any real (non-draft, non-void) invoice settles it
      items.push({
        id: `jdone-${j.id}`,
        kind: "visit_unbilled",
        title: jobWords(j),
        subtitle: one(j.customers as any)?.name ?? null,
        who: null,
        when: j.updated_at ?? null,
        urgency: 1,
        done: false,
        href: `/jobs/${j.id}?tab=invoices`,
        affordances: AFFORDANCES.visit_unbilled,
      });
    }
    // Both reads drop rows in code (settled, billed): "N+" when either didn't bring every candidate.
    counts.done_not_billed = codeCount(doneWorkR).capped || codeCount(doneJobsR).capped ? { capped: true } : {};
  }

  // ── ESTIMATES STARTED, NEVER SENT. An abandoned draft is a lead that will never resurface anywhere:
  //    it reads as handled and is in fact abandoned. Its Send It sends it after one confirm naming
  //    the customer, the total and the number of lines (lane 4's Send sheet). Dropped only when its
  //    job is finished, cancelled or billed: then there is nothing left to estimate.
  for (const q of (draftQuoteR.data ?? []) as any[]) {
    const job = one(q.jobs as any) as { status?: string | null } | null;
    if (job?.status === "complete" || job?.status === "invoiced" || job?.status === "cancelled") continue;
    if (q.job_id && billedJobs.has(q.job_id)) continue;
    const who = one((q as any).customer_name_snapshot)?.name ?? one((q as any).inquiries)?.name ?? null;
    const lines = one(q.quote_line_items as any) as { count?: number } | null;
    items.push({
      id: `qdraft-${q.id}`,
      kind: "quote_draft",
      title: `Estimate ${q.quote_number || ""} started, never sent`.replace(/\s+/g, " ").trim(),
      subtitle: who ?? (q.title || null),
      who: null,
      when: q.created_at ?? null,
      urgency: 0,
      done: false,
      href: `/quotes/${q.id}`,
      affordances: AFFORDANCES.quote_draft,
      amount: Number(q.total ?? 0),
      send: {
        kind: "quote",
        id: String(q.id),
        number: q.quote_number ?? null,
        customerName: who,
        amount: Number(q.total ?? 0),
        lineCount: typeof lines?.count === "number" ? lines.count : null,
        openHref: `/quotes/${q.id}`,
      },
    });
  }
  counts.estimates_not_sent = codeCount(draftQuoteR);

  // ── Contracts sent but not yet signed — chase the signature to lock the deal. A hold never quiets
  // it (a legal clock).
  for (const cont of (conR.data ?? []) as any[]) {
    const job = one(cont.jobs as any);
    items.push({
      id: cont.id,
      kind: "contract_unsigned",
      title: cont.contract_number ? `Contract ${cont.contract_number}` : "A contract",
      subtitle: job ? jobWords(job) : "Awaiting signature",
      who: null,
      when: null,
      urgency: 1,
      done: false,
      href: `/jobs/${cont.job_id}?tab=invoices`,
      affordances: AFFORDANCES.contract_unsigned,
    });
  }
  counts.contracts_not_signed = sqlCount(conR);

  // ── Lien deadlines coming due or past — only the pressing one per job. Never quieted by a hold.
  for (const l of (lienR.data ?? []) as any[]) {
    const st = lienStatus({
      firstFurnishedDate: l.first_furnished_date,
      completionDate: l.completion_date,
      prelimSentAt: l.prelim_sent_at,
      lienRecordedAt: l.lien_recorded_at,
      nocRecorded: l.noc_recorded,
      isSubcontractor: !!l.gc_name,
      today: todayStr,
    });
    const prelimRequired = !!l.gc_name || !!l.lender_name; // §8200(e): direct contractor owes prelim only to a lender
    const candidates: { label: string; when: string | null; daysLeft: number | null; urgent: boolean }[] = [];
    if (prelimRequired && !st.prelimDone && st.prelimDeadline)
      candidates.push({ label: "Preliminary notice", when: st.prelimDeadline, daysLeft: st.prelimDaysLeft, urgent: st.prelimUrgent });
    if (!st.lienDone && st.lienDeadline)
      candidates.push({ label: "Record lien", when: st.lienDeadline, daysLeft: st.lienDaysLeft, urgent: st.lienUrgent });
    const due = candidates.filter((c) => c.urgent || (c.daysLeft != null && c.daysLeft < 0));
    if (!due.length) continue;
    due.sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
    const top = due[0];
    const job = one(l.jobs as any);
    const pastDue = top.daysLeft != null && top.daysLeft < 0;
    items.push({
      id: l.id,
      kind: "lien_deadline",
      title: `${top.label} ${pastDue ? "past due" : "due soon"}`,
      subtitle: job ? jobWords(job) : null,
      who: null,
      when: top.when,
      urgency: 2,
      done: false,
      href: `/jobs/${l.job_id}?tab=invoices`,
      affordances: AFFORDANCES.lien_deadline,
    });
  }
  counts.lien_deadlines = codeCount(lienR);

  // ── The end-of-day money-leak sweep (staff only) — the "Apache Ct" detectors. ──
  // Detection only, per the hard boundary: each item names the gap and deep-links to the surface
  // that fixes it; nothing infers hours, dollars, or clock-out times.

  // 1) STRAY TIME — an open clock from a past day, one row per clock. A past-day close with no job
  // is NOT a row here: it rides in the Hours On No Job rollup below, which never drops it.
  const strayFindings = detectStrayTime(
    [...((openTimeR.data ?? []) as any[]), ...((recentTimeR.data ?? []) as any[])],
    todayStr,
    Date.now(),
    new Set(((nonBillableR.data ?? []) as { code?: string | null }[]).map((c) => String(c.code ?? "").trim()).filter(Boolean)),
    tz,
  ).filter((f) => f.openStill || !tz);
  // Whose clock each open finding is, for the words on its door ("Clock Out Brian").
  const openOwner = new Map<string, { profile_id?: string | null; full_name?: string | null }>(
    ((openTimeR.data ?? []) as any[]).map((e) => [String(e.id), { profile_id: e.profile_id, full_name: e.profiles?.full_name }]),
  );
  // A CLOSED SHIFT ON NO JOB MAY HAVE BEEN BILLED BY HAND on an invoice with no job (0357, TTUSD on
  // INV-055): one that a live invoice already holds is billed, so it is no stray; the rest get
  // Already Billed when a sent invoice with no job could hold them. Read only when there are some
  // (one breath, rare). A lost read keeps every row and offers the door (the sheet says what it finds).
  const closedNoJob = strayFindings.filter((f) => !f.openStill).map((f) => f.entryId);
  let noJobReach: { canHold: boolean; claimed: Set<string> } | null = null;
  if (isStaff && closedNoJob.length) {
    try {
      const orgId = (await orgIdP) ?? "";
      if (orgId) noJobReach = await readNoJobHoursReach(supabase, orgId, closedNoJob);
    } catch {
      noJobReach = null;
    }
  }
  const noJob = noJobStrayDoors(closedNoJob, isStaff ? noJobReach : { canHold: false, claimed: new Set() });
  for (const f of strayFindings) {
    if (!f.openStill && noJob.billed.has(f.entryId)) continue;
    const owner = openOwner.get(f.entryId);
    const door = clockDoorWords(owner?.full_name, { self: !!owner?.profile_id && owner.profile_id === userId }).clockOut;
    items.push({
      id: `stray-${f.entryId}`, // synthetic (kind-prefixed) — open-only, no per-row dispatch
      kind: "time_stray",
      // A clock still running says so; a closed shift on no job says where its hours are.
      chip: f.openStill ? "Clock Left Running" : "On No Job",
      title: f.openStill
        ? `${f.name}'s ${formatDateShort(f.when)} entry is still open`
        : `${f.name}'s ${formatDateShort(f.when)} entry has no job`,
      // An open shift counts ZERO hours until somebody stops it; the door words LEAD (the second line
      // truncates at phone width, and the ellipsis used to eat them).
      subtitle: f.openStill ? `${door} · on since ${formatTime(f.when, tz || undefined)}` : "Closed hours nobody can bill",
      who: f.name,
      when: f.when,
      urgency: f.openStill ? 2 : 1, // a forgotten clock is a wrong week until somebody stops it
      done: false,
      href: `/timecards?entry=${f.entryId}`,
      affordances: AFFORDANCES.time_stray,
      ...(!f.openStill && noJob.door.has(f.entryId) ? { noJobHours: { entryIds: [f.entryId] } } : {}),
    });
  }
  // 1b) HOURS ON NO JOB — one line for every past-day shift nobody put on a job, however old.
  {
    const noJob = await noJobP;
    const item = noJobHoursActionItem(noJob.summary, { failed: noJob.failed });
    // THE ROLLUP KEEPS 0357's ALREADY BILLED DOOR (TTUSD on INV-055): offered only when a sent invoice
    // with no job could hold hours; a lost read offers the door. The reach was started with the
    // rollup's read (noJobReachP), never here after the fan-out.
    if (item && isStaff && noJob.summary?.shifts.length && (await noJobReachP)) item.noJobHours = { entryIds: [] };
    if (item) items.push(item);
  }

  // Jobs worked in the last UNBILLED_WORK_DAYS (2) join the materials candidates — the crew was JUST
  // there, so leftover unpurchased items are live.
  const workedJobs = (wJobsR.data ?? []) as any[];
  for (const j of workedJobs) {
    if (worked.get(j.id)?.workedInUnbilledWindow && matStatusOk(j.status) && !matCandidates.has(j.id)) {
      matCandidates.set(j.id, { job: j, when: null });
    }
  }

  // 2) NO COSTS YET — time on the job, zero costs/POs/materials. The Romex leak. A job with no
  // costs to record (labor only) gets a Snooze that picks a day (0367), never a dismiss.
  if (isStaff && workedJobs.length) {
    const costed = costedJobIds({
      bills: (wBillsR.data ?? []) as any[],
      purchaseOrders: (wPosR.data ?? []) as any[],
      materialLists: lists.filter((l) => workedIds.includes(String(l.job_id))),
      invoices: (wInvR.data ?? []) as any[],
    });
    const invoicedJobIds = new Set<string>(
      ((wInvR.data ?? []) as any[]).filter((i) => i.status !== "void" && i.job_id).map((i) => i.job_id as string),
    );
    for (const f of detectUnbilledWork({ jobs: workedJobs, worked, costedJobIds: costed, invoicedJobIds })) {
      items.push({
        id: `nocosts-${f.job.id}`,
        kind: "job_unbilled_work",
        title: jobWords(f.job),
        subtitle: `Worked ${formatDateShort(f.lastWorked, tz || undefined)}, no costs on it yet`,
        who: null,
        when: f.lastWorked,
        urgency: 1,
        done: false,
        href: `/jobs/${f.job.id}?tab=costs`,
        affordances: waitsR.ready ? ["snooze", "open"] : AFFORDANCES.job_unbilled_work,
        ...(waitsR.ready ? { waitKey: waitKey("job_unbilled_work", f.job.id) } : {}),
      });
    }
  }

  // 3) JOBS NEEDING A DAY — nothing ahead of it (jobsNeedingADay), minus a job with a visit booked
  // today or later; its open lines to buy ride its row.
  {
    const futureAppt = new Set(((futureApptR.data ?? []) as any[]).map((a) => String(a.job_id)));
    const findings = jobsNeedingADay({
      jobs: needDayPre.map((f) => f.job),
      todayStr,
      tz,
      futureApptJobIds: futureAppt,
      clockedInJobIds,
      wonJobIds,
      toBuy: toBuyCount,
    });
    for (const f of findings) {
      const j = f.job;
      items.push({
        id: j.id,
        kind: "job_to_schedule",
        title: jobWords(j),
        subtitle: [f.why, one(j.customers as any)?.name ?? null].filter(Boolean).join(" · "),
        who: null,
        // Not a deadline: the why line says the day, and the row never reads "overdue".
        when: null,
        since: f.since,
        urgency: 1,
        done: false,
        href: `/jobs/${j.id}`,
        affordances: AFFORDANCES.job_to_schedule,
      });
      matCandidates.delete(j.id); // its lines to buy ride this row: one job, one row
    }
    counts.jobs_needing_a_day = codeCount(jobsR, JOBS_DAY_READ_CAP);
  }

  // 4) MATERIALS NEEDED — ONE item per job the crew is about to stand on with lines still to buy:
  // Buy Materials · N Open, the first few named. A part on back-order gets a Snooze that picks a day.
  for (const [jobId, cand] of matCandidates) {
    const need = toBuyByJob.get(jobId);
    if (!need?.length) continue;
    const preview = need.slice(0, 3).map((it) => `${it.quantity}× ${it.description}`).join(", ");
    const more = need.length - 3;
    items.push({
      id: `materials-${jobId}`, // synthetic (kind-prefixed): its Snooze strips the prefix
      kind: "materials_needed",
      title: jobWords(cand.job),
      subtitle: preview + (more > 0 ? ` +${more} more` : ""),
      who: null,
      when: cand.when,
      urgency: 1,
      done: false,
      href: `/jobs/${jobId}?tab=materials`,
      affordances: waitsR.ready ? ["snooze", "open"] : AFFORDANCES.materials_needed,
      openToBuy: need.length,
      ...(waitsR.ready ? { waitKey: waitKey("materials_needed", jobId) } : {}),
    });
  }
  counts.materials_to_buy = codeCount(matJobsR, 50).capped || codeCount(matSegR, 50).capped ? { capped: true } : {};

  // 5) HOLDS (NY-hold, 0366). A hold whose day has come (or that has no day) is a Reminder on Now,
  // with its reason and its Snooze and Take Off Hold; a later day waits in the fold. "Put on hold by
  // Erik" only when the hold says who. Money and legal clocks on a held job are never quieted.
  {
    const withDay = heldR.withDay;
    // A lost read says so: a hold whose day came would otherwise go quiet, the one thing a hold with a
    // day exists to prevent.
    if (isStaff && heldR.error) {
      items.push({
        id: "holds-unread",
        kind: "job_on_hold",
        title: "Holds · Couldn't Check",
        subtitle: "Couldn't read the jobs on hold just now, so one whose day has come may be missing here. Open Jobs to see them.",
        who: null,
        when: null,
        urgency: 1,
        done: false,
        href: "/jobs?status=on_hold",
        affordances: ["open"],
      });
    }
    for (const j of heldRows) {
      const until = j.hold_until ? String(j.hold_until).slice(0, 10) : null;
      const state = heldJobState(until, todayStr);
      const reason = String(j.hold_reason ?? "").trim();
      if (withDay && state === "later") {
        const row = waitingRow({ id: `onhold-${j.id}`, kind: "job_on_hold", title: jobWords(j), why: reason || "No reason saved", backOn: until, href: `/jobs/${j.id}` });
        if (row) {
          waiting.push(row);
          continue;
        }
      }
      const by = withDay ? firstNameOf(one(j.holder as any)?.full_name) : null;
      const back = !withDay ? null : state === "no_day" ? "No Day Set" : until! < todayStr ? `Back since ${shortDay(until!)}` : "Back Today";
      const toBuy = toBuyCount.get(String(j.id)) ?? 0;
      items.push({
        id: `onhold-${j.id}`,
        kind: "job_on_hold",
        title: `${jobWords(j)} · ${reason || "No reason saved"}`,
        subtitle: [by ? `Put on hold by ${by}` : null, back, toBuy > 0 ? `${toBuy} to buy` : null].filter(Boolean).join(" · ") || null,
        who: null,
        when: null,
        since: until,
        urgency: 1,
        done: false,
        href: `/jobs/${j.id}`,
        // Snooze needs the day's column (0366); Take Off Hold works either way.
        affordances: withDay ? AFFORDANCES.job_on_hold : ["do", "open"],
        holdReason: reason || null,
      });
    }
    counts.holds_back = codeCount(heldR);
  }

  // 6) RECEIPTS NOT ON A BILL — a receipt or bill on a job that nothing accounts for (a crew photo
  // from Snap Or Note, a snap whose read failed), by lib/job-photos' own rule. A failed read claims
  // nothing: one "Couldn't Check" line instead of a row per paper.
  if (isStaff && receiptsR) {
    const loose = receiptsR.error || tiesR.error ? null : receiptsNotOnABill(receiptDocs, (tiesR.data ?? []) as PaperTie[]);
    if (!loose) {
      items.push({
        id: "receipts-unread",
        kind: "receipt_unbilled",
        title: "Receipts · Couldn't Check",
        subtitle: "Couldn't tell which receipts on your jobs are on a bill just now. Open Bills to see them.",
        who: null,
        when: null,
        urgency: 1,
        done: false,
        href: "/bills",
        affordances: ["open"],
      });
    } else {
      for (const d of loose) {
        items.push({
          id: `receipt-${d.id}`,
          kind: "receipt_unbilled",
          title: receiptRowTitle(d, nameOf.get(String(d.uploaded_by ?? "")) || null, tz),
          subtitle: receiptRowJob(d),
          who: null,
          when: null,
          since: dayOf(d.created_at),
          urgency: 1,
          done: false,
          // The job's Costs tab, where Record As Cost is.
          href: `/jobs/${d.job_id}?tab=costs`,
          affordances: AFFORDANCES.receipt_unbilled,
        });
      }
      counts.receipts_not_on_a_bill = codeCount(receiptsR, RECEIPTS_READ_CAP);
    }
  }

  // SETTLE — pieces taken from stock past what stock showed (Shop Stock, Phase 3). $0 on the job and
  // nothing an invoice can bill until the office files the roll and settles it (or undoes the take).
  // ONE item per short; it stays until settled. Named for the fix that works (audit v1018). Undated:
  // the take's date is in the words, never a "3d overdue" nobody set. Staff only (0303).
  if (isStaff && shortRows.length) {
    for (const r of shortRows) {
      const it = one(r.inventory_items as any) as any;
      const jb = one(r.jobs as any) as any;
      const q = Math.round(Number(r.qty ?? 0) * 1000) / 1000;
      const who = nameOf.get(String(r.created_by ?? "")) || "Someone";
      items.push({
        id: `stockshort-${r.id}`, // synthetic (kind-prefixed): open-only, settled on Shop Stock
        kind: "stock_short",
        title: `${q} ${it?.unit ?? ""} Of ${it?.name ?? "An Item"} Taken Past Stock`.replace(/\s+/g, " "),
        // Counting can't settle a short (a count has no roll; settle_short walks rolls): name the two
        // ways that work (SHORT_FIX, the bell's own words).
        subtitle: `${who} took them for ${jb ? jobWords(jb) : "a job"} on ${formatDateShort(r.created_at, tz || undefined)}. ${SHORT_FIX}`,
        who: null,
        when: null,
        since: dayOf(r.created_at),
        urgency: 1,
        done: false,
        // Straight to the item, opened (Shop Stock opens ?item=).
        href: r.item_id ? `/inventory?item=${encodeURIComponent(String(r.item_id))}` : "/inventory",
        affordances: AFFORDANCES.stock_short,
      });
    }
    counts.stock_to_settle = sqlCount(shortsR);
  }

  // THE SUPPLIER BILLS, AS ONE ROLLED-UP LINE (badge +1, however many papers). FIRST, because the
  // point of the card is that the paper comes to him, not the reverse.
  const desk = await supplierDeskP;
  const paperItem = supplierPaperActionItem(await supplierPapersP);
  // PAY CED BY THE TENTH (supplier-pay-due.ts): one dated line per account whose discount runs out
  // within two weeks, right under the papers. Staff only (the same read); gone once the deadline is.
  items.unshift(...withPayees(supplierPayActionItems((await supplierDeskP)?.payDue), desk?.payDue));
  if (paperItem) items.unshift(paperItem);
  // A read the desk needed failed: said in one undated line, never a quiet "nothing waiting".
  const deskUnread = supplierDeskFailedItem(await supplierDeskP);
  if (deskUnread) items.unshift(deskUnread);
  // A paper set aside WAITING ON A CREDIT waits in the fold with the day it comes back as a card by
  // itself (creditWait: 30 days), never a card and never gone. The same read, no new one.
  for (const c of desk?.papers?.waiting ?? []) {
    if (!c.waitingCredit) continue;
    const row = waitingRow({
      id: `credit-${c.invoiceId}`,
      kind: "supplier_paper",
      title: `${c.supplier} ${c.invoiceNumber} · ${formatCurrency(c.total)}`,
      why: "Waiting On A Credit",
      backOn: c.waitingCredit.back,
      href: "/bills#needs-you",
    });
    if (row) waiting.push(row);
  }

  // THE ENDLESS ROWS SOMEONE SNOOZED wait in the fold with their day (0367); on the day, back.
  const folded = foldWaitingRows(items, waitsR.waits);

  // SORTED ONCE, HERE (Wave 1, NY-list): money, leads, today, other; then urgency; then oldest first,
  // an undated row counting as today; ties keep the order built above (types.ts sortActionItems).
  // Then the same-kind piles roll up (piles.ts): a pile sits where its most pressing child sat, and
  // counts one on the badge.
  const sorted = sortActionItems(
    folded.now.map((it) => ({ ...it, stream: KIND_STREAM[it.kind] })),
    todayStr,
  );
  const now = rollUpPiles(sorted, { todayStr, isStaff, leadsOn, counts });
  // The fold, soonest back first. A tech's holds no money kind and no dollar figure, ever.
  const fold = waitingForViewer([...waiting, ...folded.waiting], isStaff).sort((a, b) => a.backOn.localeCompare(b.backOn) || a.title.localeCompare(b.title));
  return { now, waiting: fold };
}

/** "Pay <Supplier>" needs the supplier's name on its line: the same deadlines, in the same order. */
function withPayees(items: ActionItem[], dues: SupplierPayDue[] | null | undefined): ActionItem[] {
  return items.map((it, i) => ({ ...it, payee: dues?.[i]?.supplier ?? null }));
}
