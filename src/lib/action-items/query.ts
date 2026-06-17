import { createClient } from "@/lib/supabase/server";
import type { ActionItem, ActionKind } from "./types";
import { AFFORDANCES } from "./types";

const ORGANIZE_LABEL: Record<string, string> = {
  receipt: "Receipt to file",
  note: "Note to review",
  job_document: "Document to file",
};

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

  const [tasksR, jobsR, inqR, apptR, orgR] = await Promise.all([
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
  ]);

  const items: ActionItem[] = [];

  for (const t of (tasksR.data ?? []) as any[]) {
    const kind: ActionKind = t.job_id ? "work_order" : "task";
    const job = t.jobs;
    items.push({
      id: t.id,
      kind,
      title: t.title,
      subtitle: job ? `${job.job_number} · ${job.name}` : t.category,
      who: t.assignee?.full_name ?? null,
      when: t.due_date,
      urgency: clamp(Number(t.priority) || 0),
      done: false,
      href: t.job_id ? `/jobs/${t.job_id}` : `/tasks/${t.category}`,
      affordances: AFFORDANCES[kind],
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
      href: a.job_id ? `/jobs/${a.job_id}` : "/schedule?view=calendar",
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

  return items;
}
