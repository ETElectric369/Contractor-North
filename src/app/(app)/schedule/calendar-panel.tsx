import { createClient } from "@/lib/supabase/server";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { workDayWindowHm } from "@/lib/org-settings";
import { getSchedulePickerOptions } from "@/lib/schedule-options";
import {
  CalendarView,
  type CalJob,
  type CalSegment,
  type CalAppt,
  type CalTask,
  type CalExternal,
} from "../calendar/calendar-view";

/** Data layer for the /schedule calendar. Forward-looking records only —
 *  clocked time (WHEN-DID) lives on /timeclock + /timecards, so the old
 *  time_entries fetch and former-employee roster union are gone. The client
 *  slices this preloaded ±window into day/week/month; paging never refetches. */
export async function CalendarPanel() {
  const supabase = await createClient();

  const now = Date.now();
  // A WIDE window so far-future bookings and long in-flight jobs don't silently
  // vanish when you page the calendar forward (the client handles slicing).
  const jobFrom = new Date(now - 120 * 86400_000).toISOString();
  const jobTo = new Date(now + 400 * 86400_000).toISOString();

  const [{ data: jobs }, { data: segments }, { data: appointments }, { data: tasks }, { data: unschedRows }, { data: externalRows }, picker, { data: org }] =
    await Promise.all([
      // Overlap test, not a point test on scheduled_start: a job shows if it
      // STARTS before the window end AND (ends after the window start, or is an
      // open-ended job that started within the window). Closes the "job booked
      // far out / long job started a while ago" disappearance.
      supabase
        .from("jobs")
        .select("id, job_number, name, status, scheduled_start, scheduled_end, assigned_to, customers(name)")
        .lte("scheduled_start", jobTo)
        .or(`scheduled_end.gte.${jobFrom},and(scheduled_end.is.null,scheduled_start.gte.${jobFrom})`)
        .order("scheduled_start"),
      supabase
        .from("job_schedule_segments")
        .select("job_id, start_date, end_date")
        .gte("end_date", jobFrom.slice(0, 10))
        .lte("start_date", jobTo.slice(0, 10)),
      // Full row (location/notes/links) — the day drill hosts the edit modal
      // and quick actions now that the appointments tab is gone.
      supabase
        .from("appointments")
        .select(
          "id, type, title, starts_at, ends_at, location, notes, status, job_id, customer_id, assigned_to, jobs(job_number, name), customers(name), profiles!appointments_assigned_to_fkey(full_name)",
        )
        .gte("starts_at", jobFrom)
        .lte("starts_at", jobTo)
        .neq("status", "cancelled")
        .order("starts_at"),
      // Open tasks with a due date in the window — the calendar shows tasks IN
      // TIME (week "N tasks due" lines + the day drill); /tasks stays the workbench.
      supabase
        .from("tasks")
        .select("id, title, due_date, job_id, category, assigned_to, assignee:assigned_to(full_name), jobs(job_number, name)")
        .eq("status", "open")
        .gte("due_date", jobFrom.slice(0, 10))
        .lte("due_date", jobTo.slice(0, 10))
        .order("due_date")
        .limit(500),
      // "To schedule" tray — the SAME definition as the action-items
      // job_to_schedule feeder (query.ts): every still-in-flight dateless job,
      // via the ACTIVE_JOB_STATUSES spine, so the tray and the inbox can't drift.
      supabase
        .from("jobs")
        .select("id, job_number, name, customers(name)")
        .is("scheduled_start", null)
        .in("status", ACTIVE_JOB_STATUSES)
        .order("created_at", { ascending: false })
        .limit(50),
      // Mirrored Google events (0132 two-way sync) — read-only zinc pills.
      // Fail-soft by construction: a missing table / RLS miss / fetch error
      // returns data:null and the calendar simply renders zero Google pills.
      supabase
        .from("external_events")
        .select("id, title, starts_at, ends_at, all_day")
        .gte("starts_at", jobFrom)
        .lte("starts_at", jobTo)
        .order("starts_at")
        .limit(1000),
      // Jobs/customers/staff option lists for the appointment modal; the staff
      // rows double as the roster (assignee dropdowns, initials, person filter).
      getSchedulePickerOptions(supabase),
      // Org settings: the configured work-day start is the "all-day job" time
      // sentinel the week agenda uses to decide whether to render a start time.
      supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    ]);

  const unscheduled = (unschedRows ?? []).map((j: any) => ({
    id: j.id,
    job_number: j.job_number,
    name: j.name,
    customer: j.customers?.name ?? null,
  }));

  return (
    <div className="mx-auto max-w-5xl">
      <CalendarView
        jobs={(jobs ?? []) as unknown as CalJob[]}
        segments={(segments ?? []) as unknown as CalSegment[]}
        appointments={(appointments ?? []) as unknown as CalAppt[]}
        tasks={(tasks ?? []) as unknown as CalTask[]}
        external={(externalRows ?? []) as unknown as CalExternal[]}
        unscheduled={unscheduled}
        members={picker.staff}
        picker={{ jobs: picker.jobOpts, customers: picker.custOpts, staff: picker.staffOpts }}
        now={new Date().toISOString()}
        workDayStart={workDayWindowHm((org as any)?.settings).start}
        workDayEnd={workDayWindowHm((org as any)?.settings).end}
      />
    </div>
  );
}
