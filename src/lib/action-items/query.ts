import { createClient } from "@/lib/supabase/server";
import type { ActionItem, ActionKind } from "./types";
import { AFFORDANCES, KIND_STREAM } from "./types";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { lienStatus } from "@/lib/lien-math";
import { formatCurrency, formatDateShort, DEFAULT_TIMEZONE } from "@/lib/utils";
import { todayStrInTz } from "@/lib/tz";
import {
  NEEDS_RETURN_DAYS,
  daysAgoStr,
  detectNeedsReturn,
  detectStrayTime,
  detectUnbilledWork,
  jobLabel,
  rollupWorkedJobs,
} from "./leak-detectors";

/**
 * Count for the dock Home badge. Derived from the SAME projection as the inbox so
 * the badge can never disagree with the list it summarizes — a parallel set of
 * count-only queries inevitably drifts from the list's per-row filters (a paid-but-
 * status-lagging invoice, the §8200(e) prelim-required gate, the NOC-shortened lien
 * window), producing a "phantom badge" that never clears. The fetches are capped and
 * RLS-scoped; correctness of the badge is worth the bounded row payload.
 */
export async function getActionItemsCount(ctx: {
  todayStr: string;
  isStaff: boolean;
  userId: string;
}): Promise<number> {
  return (await getActionItems(ctx)).length;
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

/**
 * THE single union behind the "Needs action" inbox. Projects rows from the
 * existing tables onto one ActionItem[] — no new tables. RLS already scopes to
 * the org; we additionally scope tech (non-staff) views to their own items.
 */
export async function getActionItems(ctx: {
  todayStr: string;
  isStaff: boolean;
  userId: string;
}): Promise<ActionItem[]> {
  const { todayStr, isStaff, userId } = ctx;
  const supabase = await createClient();
  const endOfToday = `${todayStr}T23:59:59`;
  const clamp = (p: number): 0 | 1 | 2 => (p >= 2 ? 2 : p >= 1 ? 1 : 0);
  // Forward day cuts for the materials-needed window (yyyy-mm-dd; daysAgoStr with a
  // negative offset walks forward). Same ≤1-day tz fuzz as the other feeders.
  const tomorrowStr = daysAgoStr(todayStr, -1);
  const dayAfterTomorrowStr = daysAgoStr(todayStr, -2);

  // Open to-dos due today/overdue — PLUS undated ones, treated as due-now. Every
  // fast capture path (voice, quick-add) creates tasks without a due_date; a plain
  // lte() filter silently dropped them, so captured work never reached the inbox.
  // Undated items sort last (when: null) via the universal ordering rule.
  let taskQ = supabase
    .from("tasks")
    .select("id, title, category, status, priority, due_date, job_id, assignee:assigned_to(full_name), jobs(job_number, name)")
    .eq("status", "open")
    .or(`due_date.is.null,due_date.lte.${todayStr}`)
    .order("priority", { ascending: false });
  if (!isStaff) taskQ = taskQ.eq("assigned_to", userId);

  const empty = Promise.resolve({ data: [] as any[] });

  const [tasksR, jobsR, inqR, apptR, orgR, invR, quoteR, draftR, conR, lienR, bugR, openTimeR, recentTimeR, matJobsR, matSegR] = await Promise.all([
    taskQ,
    // Unscheduled jobs — staff only (the "resting place" for things needing a date).
    // EVERY still-in-flight dateless job, not just estimate/scheduled: an in_progress
    // or on_hold job whose date was cleared must not vanish from every scheduling
    // surface (this feeder is also the calendar tray's source of truth).
    isStaff
      ? supabase
          .from("jobs")
          .select("id, job_number, name, status, scheduled_start, customers(name)")
          .is("scheduled_start", null)
          .in("status", ACTIVE_JOB_STATUSES)
          .order("created_at", { ascending: false })
          .limit(50)
      : empty,
    // New/uncontacted inquiries due for follow-up — staff only. A snoozed lead
    // (the snooze verb writes status='contacted' + a future next_follow_up_at via
    // inquiry.contact) stays OUT until its date — pulling it straight back made
    // snooze a no-op. 'new' leads always show; contacted ones show when their
    // follow-up is unset or due.
    isStaff
      ? supabase
          .from("inquiries")
          .select("id, name, status, next_follow_up_at, converted_at")
          .in("status", ["new", "contacted"])
          .is("converted_at", null)
          .or(`status.eq.new,next_follow_up_at.is.null,next_follow_up_at.lte.${todayStr}`)
          .order("created_at", { ascending: true })
          .limit(50)
      : empty,
    // Appointments that have started but aren't completed yet.
    supabase
      .from("appointments")
      .select("id, type, title, starts_at, status, job_id, assigned_to")
      .eq("status", "scheduled")
      .lte("starts_at", endOfToday)
      .order("starts_at", { ascending: true })
      .limit(50),
    // Captures awaiting a filing decision — staff only.
    isStaff
      ? supabase
          .from("organized_items")
          .select("id, kind, status, job_id")
          .eq("status", "needs_review")
          .order("created_at", { ascending: false })
          .limit(50)
      : empty,
    // Money/legal — staff only. Unpaid invoices (A/R) that need chasing: either
    // past their due date, OR simply old — sent/created AGE_DAYS+ ago — so an unpaid
    // invoice still reaches the inbox even before due_date logic fully populates
    // (no due_date UI yet → the Overdue-by-due-date gate alone never fires). The
    // age cut is applied per-row below; the query just pulls the open A/R.
    isStaff
      ? supabase
          .from("invoices")
          .select("id, invoice_number, total, amount_paid, due_date, status, created_at, customers(name)")
          .in("status", ["sent", "partial", "overdue"])
          .order("created_at", { ascending: true })
          .limit(50)
      : empty,
    // Quotes/estimates sent but not answered — the middle of the funnel. The
    // gone-quiet / expiring-soon cut is applied per-row below; the query just
    // pulls the open sent docs.
    isStaff
      ? supabase
          .from("quotes")
          .select("id, quote_number, doc_type, status, total, valid_until, created_at, customers(name)")
          .eq("status", "sent")
          .order("created_at", { ascending: true })
          .limit(50)
      : empty,
    // Draft invoices — billed-up work that never went out the door.
    isStaff
      ? supabase
          .from("invoices")
          .select("id, invoice_number, total, status, created_at, customers(name)")
          .eq("status", "draft")
          .order("created_at", { ascending: true })
          .limit(50)
      : empty,
    // Contracts sent to the customer but not yet signed (chase the signature).
    isStaff
      ? supabase
          .from("contracts")
          .select("id, contract_number, status, job_id, jobs(job_number, name)")
          .eq("status", "sent")
          .order("created_at", { ascending: true })
          .limit(50)
      : empty,
    // Lien records with a still-open deadline; urgency computed per-row below.
    isStaff
      ? supabase
          .from("lien_records")
          .select("id, job_id, first_furnished_date, completion_date, prelim_sent_at, lien_recorded_at, noc_recorded, gc_name, lender_name, jobs(job_number, name)")
          .or("prelim_sent_at.is.null,lien_recorded_at.is.null")
          .limit(100)
      : empty,
    // Open bug reports — the owner's "is CIB on watch for bugs" surface. Staff only.
    isStaff
      ? supabase
          .from("bug_reports")
          .select("id, note, page, created_at")
          .eq("status", "open")
          .order("created_at", { ascending: false })
          .limit(50)
      : empty,
    // ── The end-of-day money-leak sweep feeders (staff only) ──
    // Every open clock, whatever its age — a handful of rows at most; the stray
    // rule (past-day OR 14h+) is applied per-row in detectStrayTime.
    isStaff
      ? supabase
          .from("time_entries")
          .select("id, status, job_id, clock_in, clock_out, profiles(full_name), time_allocations(job_id)")
          .eq("status", "open")
          .order("clock_in", { ascending: true })
          .limit(50)
      : empty,
    // Recent entries (bounded window) — drive the closed-with-no-job stray rule
    // plus the worked-jobs rollup behind the unbilled-work / needs-return detectors.
    isStaff
      ? supabase
          .from("time_entries")
          .select("id, status, job_id, clock_in, clock_out, profiles(full_name), time_allocations(job_id)")
          .gte("clock_in", daysAgoStr(todayStr, NEEDS_RETURN_DAYS))
          .order("clock_in", { ascending: false })
          .limit(200)
      : empty,
    // ── Materials-routing candidates (staff only) — jobs the crew is about to
    // stand on: scheduled today/tomorrow, plus multi-day segments covering the
    // same window. (Worked-in-the-last-2-days jobs join via the rollup below.)
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
  ]);

  // Built without `stream`, stamped once at the return from KIND_STREAM — one
  // assignment site means a new kind can't ship with a forgotten/mismatched stream.
  const items: Omit<ActionItem, "stream">[] = [];

  for (const t of (tasksR.data ?? []) as any[]) {
    // A task is a task — even when it belongs to a job. (Previously a job_id
    // mislabeled it as a "work order" and stripped its snooze affordance.)
    const job = t.jobs;
    items.push({
      id: t.id,
      kind: "task",
      title: t.title,
      subtitle: job ? `${job.job_number} · ${job.name}` : t.category,
      who: t.assignee?.full_name ?? null,
      when: t.due_date,
      urgency: clamp(Number(t.priority) || 0),
      done: false,
      // Land ON the task, not the job's front page: deep-link to the job's Tasks
      // tab (or the category list for a standalone task) so a tap opens the item.
      href: t.job_id ? `/jobs/${t.job_id}?tab=tasks` : `/tasks/${t.category}`,
      affordances: AFFORDANCES.task,
    });
  }

  for (const j of (jobsR.data ?? []) as any[]) {
    items.push({
      id: j.id,
      kind: "job_to_schedule",
      title: `${j.job_number} · ${j.name}`,
      subtitle: j.customers?.name ?? null,
      who: null,
      when: null,
      urgency: 1,
      done: false,
      href: `/jobs/${j.id}`,
      affordances: AFFORDANCES.job_to_schedule,
    });
  }

  for (const q of (inqR.data ?? []) as any[]) {
    const overdue = q.next_follow_up_at != null && q.next_follow_up_at <= todayStr;
    items.push({
      id: q.id,
      kind: "inquiry",
      title: q.name,
      subtitle: q.status === "new" ? "New inquiry" : "Follow up",
      who: null,
      when: q.next_follow_up_at,
      urgency: overdue ? 1 : 0,
      done: false,
      href: "/leads",
      affordances: AFFORDANCES.inquiry,
    });
  }

  for (const a of (apptR.data ?? []) as any[]) {
    if (!isStaff && a.assigned_to !== userId) continue;
    items.push({
      id: a.id,
      kind: "appointment",
      title: a.title || (a.type ? `${a.type[0].toUpperCase()}${a.type.slice(1)}` : "Appointment"),
      subtitle: a.type ?? null,
      who: null,
      when: a.starts_at,
      urgency: 0,
      done: false,
      // Open the appointment where it lives: the job's Appointments tab, else the
      // schedule day drill for its date — not the job overview / bare calendar.
      href: a.job_id
        ? `/jobs/${a.job_id}?tab=appointments`
        : a.starts_at
          ? `/schedule?view=day&date=${todayStrInTz(DEFAULT_TIMEZONE, new Date(a.starts_at))}`
          : "/schedule",
      affordances: AFFORDANCES.appointment,
    });
  }

  for (const o of (orgR.data ?? []) as any[]) {
    items.push({
      id: o.id,
      kind: "organize",
      title: ORGANIZE_LABEL[o.kind] ?? "To file",
      subtitle: null,
      who: null,
      when: null,
      urgency: 0,
      done: false,
      href: "/organize",
      affordances: AFFORDANCES.organize,
    });
  }

  // Unpaid invoices (A/R) — the money the business is owed. Surfaced when past their
  // due date OR simply old (created INVOICE_STALE_DAYS+ ago), so an unpaid invoice
  // reaches the inbox by AGE even before a due_date is entered.
  const todayMs = Date.parse(todayStr);
  for (const inv of (invR.data ?? []) as any[]) {
    const balance = Number(inv.total ?? 0) - Number(inv.amount_paid ?? 0);
    if (balance < 0.005) continue; // effectively paid; status just lagging
    // Days past due (only when a due_date is set) and days since created.
    const daysOverDue = inv.due_date ? Math.floor((todayMs - Date.parse(inv.due_date)) / 86_400_000) : null;
    const daysOld = inv.created_at ? Math.floor((todayMs - Date.parse(inv.created_at)) / 86_400_000) : 0;
    const pastDue = daysOverDue != null && daysOverDue > 0;
    const stale = daysOld >= INVOICE_STALE_DAYS;
    if (!pastDue && !stale) continue; // not yet worth chasing
    // Urgency tracks the worse of the two clocks: very overdue, or very old.
    const overWindow = Math.max(daysOverDue ?? 0, stale ? daysOld - INVOICE_STALE_DAYS : 0);
    items.push({
      id: inv.id,
      kind: "invoice_overdue",
      title: `${inv.invoice_number} · ${formatCurrency(balance)} due`,
      subtitle: inv.customers?.name ?? null,
      who: null,
      // Prefer the due date for the "when"; fall back to created so undated rows still sort by age.
      when: inv.due_date ?? inv.created_at ?? null,
      urgency: overWindow > 14 ? 2 : 1,
      done: false,
      href: `/billing/${inv.id}`,
      affordances: AFFORDANCES.invoice_overdue,
    });
  }

  // Sent quotes/estimates gone quiet — surfaced once the customer has had it
  // QUOTE_QUIET_DAYS+ with no answer, or the valid-until window is closing/past.
  // Open-only: acting on a quote (resend, follow up, mark declined) happens on
  // its own page, and there's no snooze field that wouldn't alter the offer.
  for (const q of (quoteR.data ?? []) as any[]) {
    const daysOut = q.created_at ? Math.floor((todayMs - Date.parse(q.created_at)) / 86_400_000) : 0;
    const daysToExpiry = q.valid_until ? Math.floor((Date.parse(q.valid_until) - todayMs) / 86_400_000) : null;
    const quiet = daysOut >= QUOTE_QUIET_DAYS;
    const expiring = daysToExpiry != null && daysToExpiry <= QUOTE_EXPIRY_SOON_DAYS;
    if (!quiet && !expiring) continue; // still fresh — give the customer room
    items.push({
      id: q.id,
      kind: "quote_awaiting",
      title: `${(q.doc_type ?? "quote") === "estimate" ? "Estimate" : "Quote"} ${q.quote_number} awaiting reply`,
      subtitle: q.customers?.name ?? formatCurrency(Number(q.total ?? 0)),
      who: null,
      // Prefer the expiry for the "when" (that's the clock that matters); fall
      // back to created so undated offers still sort by age.
      when: q.valid_until ?? q.created_at ?? null,
      // Past its valid-until the offer is dying — bump it above the routine chase.
      urgency: daysToExpiry != null && daysToExpiry < 0 ? 2 : 1,
      done: false,
      href: `/quotes/${q.id}`,
      affordances: AFFORDANCES.quote_awaiting,
    });
  }

  // Draft invoices — money one tap from "sent" sitting in limbo. Every draft
  // surfaces (no age cut): it either goes out or gets deleted, never forgotten.
  for (const d of (draftR.data ?? []) as any[]) {
    items.push({
      id: d.id,
      kind: "invoice_draft",
      title: `Draft invoice ${d.invoice_number}`,
      subtitle: d.customers?.name ?? formatCurrency(Number(d.total ?? 0)),
      who: null,
      when: d.created_at ?? null,
      urgency: 0,
      done: false,
      href: `/billing/${d.id}`,
      affordances: AFFORDANCES.invoice_draft,
    });
  }

  // Contracts sent but not yet signed — chase the signature to lock the deal.
  for (const cont of (conR.data ?? []) as any[]) {
    const job = cont.jobs;
    items.push({
      id: cont.id,
      kind: "contract_unsigned",
      title: cont.contract_number ? `Contract ${cont.contract_number} unsigned` : "Contract unsigned",
      subtitle: job ? `${job.job_number} · ${job.name}` : "Awaiting signature",
      who: null,
      when: null,
      urgency: 1,
      done: false,
      href: `/jobs/${cont.job_id}?tab=invoices`,
      affordances: AFFORDANCES.contract_unsigned,
    });
  }

  // Lien deadlines coming due or past — surface only the pressing one per job.
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
    const job = l.jobs;
    const pastDue = top.daysLeft != null && top.daysLeft < 0;
    items.push({
      id: l.id,
      kind: "lien_deadline",
      title: `${top.label} ${pastDue ? "past due" : "due soon"}`,
      subtitle: job ? `${job.job_number} · ${job.name}` : null,
      who: null,
      when: top.when,
      urgency: 2,
      done: false,
      href: `/jobs/${l.job_id}?tab=invoices`,
      affordances: AFFORDANCES.lien_deadline,
    });
  }

  // Open bug reports — ONE rollup item (not one per bug) so a backlog of routine field reports
  // can't flood the dock badge (it stays +1) and the "open" tap lands cleanly on Bug watch.
  // Low urgency: it sorts below the money/legal items. Triage happens on /bugs.
  const openBugs = (bugR.data ?? []) as any[];
  if (openBugs.length) {
    items.push({
      id: "bugs-open", // synthetic rollup id — the only affordance is "open" (navigate), no per-row dispatch
      kind: "bug_report",
      title: `${openBugs.length} open bug report${openBugs.length > 1 ? "s" : ""}`,
      subtitle: "Reported from the field",
      who: null,
      when: openBugs[0]?.created_at ?? null,
      urgency: 0,
      done: false,
      href: "/bugs",
      affordances: AFFORDANCES.bug_report,
    });
  }

  // ── The end-of-day money-leak sweep (staff only) — the "Apache Ct" detectors. ──
  // Detection only, per the hard boundary: each item names the gap and deep-links to
  // the surface that fixes it; nothing infers hours, dollars, or clock-out times.

  // 1) STRAY TIME — an open clock from a past day, or a past-day close with no job.
  const strayFindings = detectStrayTime(
    [...((openTimeR.data ?? []) as any[]), ...((recentTimeR.data ?? []) as any[])],
    todayStr,
  );
  for (const f of strayFindings) {
    items.push({
      id: `stray-${f.entryId}`, // synthetic (kind-prefixed) — open-only, no per-row dispatch
      kind: "time_stray",
      title: f.openStill
        ? `${f.name}'s ${formatDateShort(f.when)} entry is still open`
        : `${f.name}'s ${formatDateShort(f.when)} entry has no job`,
      subtitle: f.openStill ? "Still clocked in — hours accruing" : "Closed hours nobody can bill",
      who: f.name,
      when: f.when,
      urgency: f.openStill ? 2 : 1, // a running clock is accruing payroll right now
      done: false,
      href: "/timecards",
      affordances: AFFORDANCES.time_stray,
    });
  }

  // ── MATERIALS ROUTING (staff only) — the "who's buying?" feeder. Unpurchased
  // take-off items on a job about to be worked route back to whoever is coming
  // through next. Distinct from job_unbilled_work BY CONSTRUCTION: that one fires
  // on ZERO recorded materials/costs ("nothing recorded"); this one fires on
  // recorded-but-unpurchased items ("needed to buy") — having items makes a job
  // costed, so the same job can never show both.
  const matCandidates = new Map<string, { job: { id: string; job_number?: string | null; name?: string | null }; when: string | null }>();
  const matStatusOk = (s: string | null | undefined) => s !== "cancelled" && s !== "complete" && s !== "invoiced";
  for (const j of (matJobsR.data ?? []) as any[]) {
    if (matStatusOk(j.status)) matCandidates.set(j.id, { job: j, when: j.scheduled_start ?? null });
  }
  for (const s of (matSegR.data ?? []) as any[]) {
    const j = s.jobs;
    if (!j || !matStatusOk(j.status) || matCandidates.has(j.id)) continue;
    // The day the crew is next on it: the segment's start if still ahead, else today.
    matCandidates.set(j.id, { job: j, when: s.start_date && s.start_date > todayStr ? s.start_date : todayStr });
  }

  // 2 & 3) Job-level detectors need the worked jobs' costs/schedule — one small
  // dependent round, bounded by the recent-entries rollup (a couple dozen ids max).
  const worked = rollupWorkedJobs((recentTimeR.data ?? []) as any[], todayStr);
  if (isStaff && worked.size > 0) {
    const jobIds = [...worked.keys()].slice(0, 30);
    const [wJobsR, wBillsR, wPosR, wMatR, wInvR, wApptR, wSegR] = await Promise.all([
      supabase.from("jobs").select("id, job_number, name, status, scheduled_start").in("id", jobIds),
      supabase.from("bills").select("job_id").in("job_id", jobIds).limit(200),
      supabase.from("purchase_orders").select("job_id").in("job_id", jobIds).limit(200),
      supabase.from("material_lists").select("job_id, material_list_items(id)").in("job_id", jobIds).limit(100),
      supabase.from("invoices").select("job_id, status").in("job_id", jobIds).limit(200),
      supabase
        .from("appointments")
        .select("job_id")
        .in("job_id", jobIds)
        .eq("status", "scheduled")
        .gte("starts_at", todayStr)
        .limit(200),
      supabase.from("job_schedule_segments").select("job_id").in("job_id", jobIds).gte("end_date", todayStr).limit(200),
    ]);

    const costedJobIds = new Set<string>([
      ...((wBillsR.data ?? []) as any[]).map((b) => b.job_id as string),
      ...((wPosR.data ?? []) as any[]).map((p) => p.job_id as string),
      ...((wMatR.data ?? []) as any[])
        .filter((m) => (m.material_list_items?.length ?? 0) > 0)
        .map((m) => m.job_id as string),
    ]);
    const invoicedJobIds = new Set<string>(
      ((wInvR.data ?? []) as any[]).filter((i) => i.status !== "void" && i.job_id).map((i) => i.job_id as string),
    );
    const futureApptJobIds = new Set<string>(((wApptR.data ?? []) as any[]).map((a) => a.job_id as string));
    const futureSegmentJobIds = new Set<string>(((wSegR.data ?? []) as any[]).map((s) => s.job_id as string));
    const workedJobs = (wJobsR.data ?? []) as any[];

    // Jobs worked in the last UNBILLED_WORK_DAYS (2) join the materials-needed
    // candidates — the crew was JUST there, so leftover unpurchased items are live.
    for (const j of workedJobs) {
      if (worked.get(j.id)?.workedInUnbilledWindow && matStatusOk(j.status) && !matCandidates.has(j.id)) {
        matCandidates.set(j.id, { job: j, when: null });
      }
    }

    // 2) UNBILLED WORK — time on the job, zero costs/POs/materials. The Romex leak.
    for (const f of detectUnbilledWork({ jobs: workedJobs, worked, costedJobIds, invoicedJobIds })) {
      items.push({
        id: `unbilled-${f.job.id}`,
        kind: "job_unbilled_work",
        title: `Worked ${jobLabel(f.job)} — no materials/costs recorded yet`,
        subtitle: f.job.job_number ?? null,
        who: null,
        when: f.lastWorked,
        urgency: 1,
        done: false,
        href: `/jobs/${f.job.id}?tab=costs`,
        affordances: AFFORDANCES.job_unbilled_work,
      });
    }

    // 3) NO RETURN VISIT — worked recently, still in flight, nothing on the calendar.
    for (const f of detectNeedsReturn({ jobs: workedJobs, worked, todayStr, futureApptJobIds, futureSegmentJobIds })) {
      items.push({
        id: `return-${f.job.id}`,
        kind: "job_needs_return",
        title: `Worked ${jobLabel(f.job)} — nothing scheduled next`,
        subtitle: f.job.job_number ?? null,
        who: null,
        when: f.lastWorked,
        urgency: 1,
        done: false,
        href: `/jobs/${f.job.id}`,
        affordances: AFFORDANCES.job_needs_return,
      });
    }
  }

  // MATERIALS NEEDED — one dependent round for the candidates' take-off lists,
  // then ONE item per job with unpurchased (non-tool) items: "Materials needed at
  // {job}" + the first few item names, deep-linked to the job's materials tab.
  if (isStaff && matCandidates.size > 0) {
    const matJobIds = [...matCandidates.keys()].slice(0, 30);
    const { data: matLists } = await supabase
      .from("material_lists")
      .select("job_id, material_list_items(description, quantity, purchased, is_tool)")
      .in("job_id", matJobIds)
      .limit(100);
    const needByJob = new Map<string, { description: string; quantity: number }[]>();
    for (const ml of (matLists ?? []) as any[]) {
      for (const it of (ml.material_list_items ?? []) as any[]) {
        // Tools are brought from the shop, not bought — an owned tool would sit
        // "unpurchased" forever and nag the shopping run daily.
        if (it.purchased || it.is_tool) continue;
        if (!needByJob.has(ml.job_id)) needByJob.set(ml.job_id, []);
        needByJob.get(ml.job_id)!.push({ description: it.description, quantity: Number(it.quantity ?? 1) });
      }
    }
    for (const [jobId, need] of needByJob) {
      const cand = matCandidates.get(jobId);
      if (!cand || need.length === 0) continue;
      const preview = need.slice(0, 3).map((it) => `${it.quantity}× ${it.description}`).join(", ");
      const more = need.length - 3;
      items.push({
        id: `materials-${jobId}`, // synthetic (kind-prefixed) — open-only, no per-row dispatch
        kind: "materials_needed",
        title: `Materials needed at ${jobLabel(cand.job)}`,
        subtitle: preview + (more > 0 ? ` +${more} more` : ""),
        who: null,
        when: cand.when,
        urgency: 1,
        done: false,
        href: `/jobs/${jobId}?tab=materials`,
        affordances: AFFORDANCES.materials_needed,
      });
    }
  }

  return items.map((it) => ({ ...it, stream: KIND_STREAM[it.kind] }));
}
