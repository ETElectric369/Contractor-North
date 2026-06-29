import { createClient } from "@/lib/supabase/server";
import type { ActionItem, ActionKind } from "./types";
import { AFFORDANCES } from "./types";
import { lienStatus } from "@/lib/lien-math";
import { formatCurrency } from "@/lib/utils";

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

/**
 * THE single union behind the "Needs action" inbox. Projects rows from five
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

  // Open to-dos due today/overdue. Techs see only their own.
  let taskQ = supabase
    .from("tasks")
    .select("id, title, category, status, priority, due_date, job_id, assignee:assigned_to(full_name), jobs(job_number, name)")
    .eq("status", "open")
    .lte("due_date", todayStr)
    .order("priority", { ascending: false });
  if (!isStaff) taskQ = taskQ.eq("assigned_to", userId);

  const empty = Promise.resolve({ data: [] as any[] });

  const [tasksR, jobsR, inqR, apptR, orgR, invR, conR, lienR, bugR] = await Promise.all([
    taskQ,
    // Unscheduled jobs — staff only (the "resting place" for things needing a date).
    isStaff
      ? supabase
          .from("jobs")
          .select("id, job_number, name, status, scheduled_start, customers(name)")
          .is("scheduled_start", null)
          .in("status", ["estimate", "scheduled"])
          .order("created_at", { ascending: false })
          .limit(50)
      : empty,
    // New/uncontacted inquiries due for follow-up — staff only.
    isStaff
      ? supabase
          .from("inquiries")
          .select("id, name, status, next_follow_up_at, converted_at")
          .in("status", ["new", "contacted"])
          .is("converted_at", null)
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
  ]);

  const items: ActionItem[] = [];

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
      // schedule's appointments view — not the job overview / bare calendar.
      href: a.job_id ? `/jobs/${a.job_id}?tab=appointments` : "/schedule?view=appointments",
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

  return items;
}
