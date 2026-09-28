import { createClient } from "@/lib/supabase/server";
import { CAL_WINDOW_BACK_DAYS, CAL_WINDOW_FWD_DAYS, segmentJobsNotLoaded } from "@/lib/schedule/cal-window";
import { segmentCols, withDayHours } from "@/lib/schedule/segment-hours";
import type { AddableJob } from "./add-to-schedule-sheet";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { getOrgSettings, workDayWindowHm } from "@/lib/org-settings";
import { featureOn } from "@/lib/features";
import { getSchedulePickerOptions } from "@/lib/schedule-options";
import { dayRowsByDay, type CrewDayRow } from "@/lib/schedule/block-info";
import { ACTUALS_LIMIT, actualsFrom, type ActualEntryRow } from "@/lib/schedule/plan-vs-actual";
import { todayStrInTz, tzDayStartUtc } from "@/lib/tz";
import {
  CalendarView,
  type CalJob,
  type CalSegment,
  type CalAppt,
  type CalTask,
  type CalExternal,
} from "../calendar/calendar-view";

/** Data layer for the /schedule calendar: the ONE time map. Future days show what's booked; past days
 *  show what was booked and what happened, inside the same block.
 *  In Wave 2 (SV-actual) the July rule "the calendar never shows clocked time" was retired: one
 *  past-only clocked-time read below, never a pay column. The timesheet (editing, pay) stays on
 *  /timecards. The client slices this preloaded ±window into day/week/month; paging never refetches. */
export async function CalendarPanel({ canEdit = false }: { canEdit?: boolean } = {}) {
  const supabase = await createClient();

  const now = Date.now();
  // A WIDE window so far-future bookings and long in-flight jobs don't silently
  // vanish when you page the calendar forward (the client handles slicing).
  // The constants are shared with the view's clamps — see lib/schedule/cal-window.
  const jobFrom = new Date(now - CAL_WINDOW_BACK_DAYS * 86400_000).toISOString();
  const jobTo = new Date(now + CAL_WINDOW_FWD_DAYS * 86400_000).toISOString();

  // `address` (the street) rides along: every block says where (lib/schedule/block-info).
  const JOB_COLS = "id, job_number, name, status, scheduled_start, scheduled_end, planned_minutes, assigned_to, address, city, customers(name)";
  // EVERYONE'S DAY'S ROWS from today on (a day early, so the company's today is in it in any timezone):
  // the day row wins for that day on every upcoming chip (lib/schedule/block-info crewChips).
  const dayRowsFrom = new Date(now - 86400_000).toISOString().slice(0, 10);
  const [{ data: listedJobs }, { data: segments, perDayHours }, { data: appointments }, { data: tasks }, { data: externalRows }, picker, { data: org }, { data: addableRows }, { data: dayRowRows }, { data: everyone }] =
    await Promise.all([
      // Overlap test, not a point test on scheduled_start: a job shows if it
      // STARTS before the window end AND (ends after the window start, or is an
      // open-ended job that started within the window). Closes the "job booked
      // far out / long job started a while ago" disappearance.
      supabase
        .from("jobs")
        .select(JOB_COLS)
        .lte("scheduled_start", jobTo)
        .or(`scheduled_end.gte.${jobFrom},and(scheduled_end.is.null,scheduled_start.gte.${jobFrom})`)
        .order("scheduled_start"),
      // Each day's own hours ride along (0370); before the migration, the read without them.
      withDayHours((h) =>
        supabase
          .from("job_schedule_segments")
          .select(segmentCols("job_id, start_date, end_date", h))
          .gte("end_date", jobFrom.slice(0, 10))
          .lte("start_date", jobTo.slice(0, 10)),
      ),
      // Full row (location/notes/links) — the day drill hosts the edit modal
      // and quick actions now that the appointments tab is gone.
      supabase
        .from("appointments")
        .select(
          // jobs(address): a visit with no place of its own is at its job's street (My Day reads it the same).
          "id, type, title, starts_at, ends_at, location, notes, status, job_id, customer_id, assigned_to, absorbed, jobs(job_number, name, address), customers(name), profiles!appointments_assigned_to_fkey(full_name)",
        )
        .gte("starts_at", jobFrom)
        .lte("starts_at", jobTo)
        .neq("status", "cancelled")
        .order("starts_at"),
      // Open REMINDERS with a due date in the window — the calendar shows them IN TIME (week "N
      // tasks due" lines + the day drill); /tasks stays the workbench. Job tasks left the calendar
      // in 0358 (they are the job's list, with no dates), and RLS shows each person only their own
      // Reminders (0358's tasks_read).
      supabase
        .from("tasks")
        .select("id, title, due_date, job_id, category, assigned_to, assignee:assigned_to(full_name), jobs(job_number, name)")
        .is("job_id", null)
        .eq("status", "open")
        .gte("due_date", jobFrom.slice(0, 10))
        .lte("due_date", jobTo.slice(0, 10))
        .order("due_date")
        .limit(500),
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
      /* ADD TO SCHEDULE's job list (the office only): every job still in flight (to be scheduled,
         scheduled, in progress, on hold), the most recently worked first, with its street, who, its
         size (the length it starts with) and its crew. No money. */
      canEdit
        ? supabase
            .from("jobs")
            .select("id, job_number, name, status, address, city, planned_minutes, assigned_to, customers(name)")
            .in("status", ACTIVE_JOB_STATUSES)
            .order("updated_at", { ascending: false, nullsFirst: false })
            .order("created_at", { ascending: false })
            .limit(300)
        : Promise.resolve({ data: [] as unknown[] }),
      /* WHO'S ON IT, THAT DAY (Everyone's Day, crew_day_assignments, both kinds: 'off', and 'job' for
         this job or another). RLS scopes it to the company. Fail-soft: no rows read, the chips are the
         job's crew as it stands. */
      supabase
        .from("crew_day_assignments")
        .select("profile_id, work_date, kind, job_id")
        .gte("work_date", dayRowsFrom)
        .lte("work_date", jobTo.slice(0, 10))
        .order("work_date")
        .limit(2000),
      /* EVERYONE THE COMPANY EVER HAD (id, name, active), so a chip names someone who has left ("No
         Longer On The Team") instead of "Unnamed". The pickers still list the active team only. */
      supabase.from("profiles").select("id, full_name, active").limit(1000),
    ]);

  const tz = getOrgSettings((org as any)?.settings).timezone;
  const todayStr = todayStrInTz(tz);

  /* HISTORY DRAWS TOO. A job whose date was cleared keeps its worked days as segments with no listed
     span, so the read above (on scheduled_start) never brings it; its worked day would vanish while
     Clear The Date's note says it was kept on the calendar. Read those jobs by id (in reads of 200 ids:
     a long list is a long URL; every one is read, none dropped): the segments place them on their
     worked days (drawn all day, the day drill reads "Worked day"). Fail-soft: a failed read draws what
     the first one brought. It runs beside the clocked-time read below, one round. */
  const missing = segmentJobsNotLoaded(((listedJobs ?? []) as { id: string }[]).map((j) => j.id), (segments ?? []) as unknown as { job_id: string }[]);
  const missingChunks: string[][] = [];
  for (let i = 0; i < missing.length; i += 200) missingChunks.push(missing.slice(i, i + 200));

  /* WHAT HAPPENED ON PAST DAYS (Wave 2, SV-actual: the July rule "the calendar never shows clocked
     time" is retired). The schedule is the one time map: future days show what's booked; past days
     show what was booked AND what happened, inside the same block (lib/schedule/plan-vs-actual). The
     timesheet (editing, pay) stays on /timecards. ONE read, before today on the company's clock, only
     entries on a job (a no-job punch is never guessed onto a block), newest first, capped. NO PAY
     COLUMN: no rate, no paid, no miles, no notes. Names come from the entry's own person, so someone
     who has left still has initials on the days they worked. The job rides along so a ghost (part D)
     can name a job the window's jobs read didn't bring. RLS scopes it to the company (0249's
     (org_id, clock_in desc) index serves it). Fail-soft: a failed read draws no bars, and says so. */
  const ENTRY_COLS =
    "id, profile_id, job_id, clock_in, clock_out, source, profiles:profile_id(full_name), job:job_id(id, job_number, name, customers(name))";
  const [historyReads, entriesRead] = await Promise.all([
    Promise.all(missingChunks.map((missingChunk) => supabase.from("jobs").select(JOB_COLS).in("id", missingChunk))),
    supabase
      .from("time_entries")
      .select(ENTRY_COLS)
      .not("job_id", "is", null)
      .gte("clock_in", jobFrom)
      .lt("clock_in", tzDayStartUtc(todayStr, tz).toISOString())
      .order("clock_in", { ascending: false })
      .limit(ACTUALS_LIMIT),
  ]);
  const historyJobs = historyReads.flatMap((r) => (r.data ?? []) as unknown[]);
  const jobs: unknown[] = [...(listedJobs ?? []), ...(historyJobs ?? [])];
  const { actuals, actualsCappedBefore } = actualsFrom(entriesRead.error ? null : ((entriesRead.data ?? []) as unknown as ActualEntryRow[]), tz, todayStr);

  return (
    <div className="mx-auto max-w-5xl">
      <CalendarView
        jobs={(jobs ?? []) as unknown as CalJob[]}
        segments={(segments ?? []) as unknown as CalSegment[]}
        appointments={(appointments ?? []) as unknown as CalAppt[]}
        tasks={(tasks ?? []) as unknown as CalTask[]}
        external={(externalRows ?? []) as unknown as CalExternal[]}
        members={picker.staff}
        picker={{ jobs: picker.jobOpts, customers: picker.custOpts, staff: picker.staffOpts }}
        now={new Date().toISOString()}
        // The org tz drives EVERY instant→day/minutes mapping in the view —
        // without it the client fell back to Date methods (server UTC on SSR,
        // browser zone after), the "UTC problem in the new calendars".
        tz={tz}
        workDayStart={workDayWindowHm((org as any)?.settings).start}
        workDayEnd={workDayWindowHm((org as any)?.settings).end}
        crewBoard={featureOn(getOrgSettings((org as any)?.settings).features, "crew_board")}
        // The office taps a block for its day, time and crew (schedule/tile-sheet). Staff only: the
        // page sends anyone else to My Day, and every writer behind the sheet asks requireStaff too.
        canEdit={canEdit}
        // A day can keep its own hours (0370 applied): the tile's time is This Day's.
        perDayHours={perDayHours}
        // Add To Schedule: an open spot (or a day's "+") opens the sheet with these jobs.
        addableJobs={(addableRows ?? []) as unknown as AddableJob[]}
        // Each day's crew rows (Everyone's Day), by day, and everyone the company ever had.
        dayRows={dayRowsByDay((dayRowRows ?? []) as unknown as CrewDayRow[])}
        people={((everyone ?? []) as { id: string; full_name: string | null; active?: boolean | null }[]).map((p) => ({ id: p.id, full_name: p.full_name, active: p.active ?? null }))}
        // What happened on past days (compact spans; null: the read failed) and, when the read hit its
        // cap, the first day it covers whole (older days are never drawn hollow: blank is not zero).
        actuals={actuals}
        actualsCappedBefore={actualsCappedBefore}
      />
    </div>
  );
}

