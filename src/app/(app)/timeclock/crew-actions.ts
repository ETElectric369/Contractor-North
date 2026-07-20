"use server";

/**
 * Crew DAY-assignments (migration 0139) — the /timeclock board's week-planning
 * write path. One row per member per org-local day: which job carries them + a
 * per-day crew-leader flag (profiles.crew_lead stays the debrief CAPABILITY
 * flag from 0128; is_crew_lead here is "who leads the crew THAT day").
 *
 * PRECEDENCE LAW (Erik, 2026-07-20): a day-assignment WINS over every other
 * "which job is this person on" read — the board pick (pickMemberCurrentJob
 * tier 0), the job-less clock-in resolution (resolveTechJobToday tier 0), and,
 * via the clock-in default, My Day's current job. Payroll math on
 * clock_in/clock_out/lunch NEVER changes from assignments.
 */

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";
import { getOrgSettings } from "@/lib/org-settings";
import { prettyDay, todayStrInTz, weekDayStrs } from "@/lib/tz";
import { createNotifications } from "@/lib/notifications";
import { sendPushToProfiles } from "@/lib/push";
import { setJobCrew } from "../schedule/actions";

export type CrewActionResult = { ok: boolean; error?: string };

/** One week-grid row: an assignment joined with its job's label fields (both
 *  label worlds — job_number·name for codes-on, customer·address for codes-off). */
export type CrewDayAssignmentRow = {
  profile_id: string;
  work_date: string; // YYYY-MM-DD (org-local day)
  job_id: string;
  is_crew_lead: boolean;
  job: {
    id: string;
    job_number: string | null;
    name: string | null;
    address: string | null;
    customer_name: string | null;
  } | null;
};

export type WeekAssignmentsResult = CrewActionResult & {
  /** The 7 org-local day-strings of the requested week (org week_start honored). */
  days?: string[];
  rows?: CrewDayAssignmentRow[];
};

const isYmd = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(s ?? "") && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime());

/**
 * Upsert (or clear) one member's assignment for one day — the day-picker board's
 * single write verb. STAFF ONLY (app guard here + RLS crew_day_assignments_staff
 * as the real boundary).
 *
 *   • jobId null ⇒ CLEAR the row (silent, like every crew removal).
 *   • Otherwise upsert on (profile_id, work_date) — ONE assignment per member
 *     per day; mid-shift splits stay the switch-job flow.
 *   • Write-through is ADDITIVE: the member is ensured into jobs.assigned_to via
 *     the canonical setJobCrew (which bells+pushes a newly ADDED member — the
 *     cn-v74 board lineage) and NEVER removed from other jobs (unlike the
 *     today-only assignMemberToJob — a week plan holds many jobs at once).
 *   • Notify on create/change of the day's JOB: if setJobCrew just told them
 *     ("You're on <job>"), that's the notification; if they were already on the
 *     crew, send the day-specific bell+push instead. A lead-flag-only toggle is
 *     silent (it's a duty marker, not a reassignment). Never notifies the caller.
 */
export async function setCrewDayAssignment(input: {
  profileId: string;
  workDate: string; // YYYY-MM-DD, org-local
  jobId: string | null;
  isCrewLead?: boolean;
}): Promise<CrewActionResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { profileId, workDate, jobId } = input;

  if (!profileId) return { ok: false, error: "Pick a crew member." };
  if (!isYmd(workDate)) return { ok: false, error: "I couldn't read that date." };

  // CLEAR — jobId null wipes the member's row for that day. RLS org-scopes the
  // delete; removals are silent by design (the notifyJobCrewAdded doctrine).
  if (!jobId) {
    const { error } = await supabase
      .from("crew_day_assignments")
      .delete()
      .eq("profile_id", profileId)
      .eq("work_date", workDate);
    if (error) return { ok: false, error: error.message };
    revalidatePath("/timeclock");
    revalidatePath("/planner"); // clock-in default + My Day follow the assignment
    return { ok: true };
  }

  // The member must be visible to the caller (RLS keeps this org-scoped).
  const { data: member } = await supabase.from("profiles").select("id").eq("id", profileId).maybeSingle();
  if (!member) return { ok: false, error: "Member not found." };

  // The job too — org_id rides along as the explicit belt for the upsert (the
  // set_org_id trigger is the suspenders), assigned_to feeds the write-through
  // diff, the label fields feed the notification body.
  const { data: jobRow } = await supabase
    .from("jobs")
    .select("id, org_id, job_number, name, assigned_to")
    .eq("id", jobId)
    .maybeSingle();
  if (!jobRow) return { ok: false, error: "Job not found." };
  const job = jobRow as {
    id: string;
    org_id: string | null;
    job_number: string | null;
    name: string | null;
    assigned_to: string[] | null;
  };

  // Prior row (if any) — diffs the notify below (create/job-change ⇒ tell them;
  // lead-flag-only toggle ⇒ silent).
  const { data: prevRow } = await supabase
    .from("crew_day_assignments")
    .select("job_id")
    .eq("profile_id", profileId)
    .eq("work_date", workDate)
    .maybeSingle();
  const prevJobId = (prevRow as { job_id?: string } | null)?.job_id ?? null;

  // ADDITIVE write-through FIRST (the assignMemberToJob "add before anything can
  // fail" ordering): ensure the member is on the job's crew via the canonical
  // setJobCrew — never a direct assigned_to fork — so the job page, /schedule and
  // the "mine" reads all see them. Never removes anyone.
  const alreadyOnCrew = (job.assigned_to ?? []).includes(profileId);
  if (!alreadyOnCrew) {
    const res = await setJobCrew(jobId, [...(job.assigned_to ?? []), profileId]);
    if (!res.ok) return { ok: false, error: res.error };
  }

  const { error } = await supabase.from("crew_day_assignments").upsert(
    {
      org_id: job.org_id, // belt; the 0139 stamp trigger is the suspenders
      profile_id: profileId,
      work_date: workDate,
      job_id: jobId,
      is_crew_lead: !!input.isCrewLead,
      created_by: ctx.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "profile_id,work_date" },
  );
  if (error) return { ok: false, error: error.message };

  // Day-specific notify — only when the day's JOB was created/changed AND
  // setJobCrew didn't already bell them for the add. Never the caller
  // (self-suppress precedent). Best-effort by construction: both helpers
  // try/catch internally, and they're awaited so serverless can't drop them.
  const jobChanged = prevJobId !== jobId;
  if (jobChanged && alreadyOnCrew && profileId !== ctx.userId && job.org_id) {
    const label = [job.job_number, job.name].filter(Boolean).join(" · ") || "a job";
    const payload = {
      title: "Crew assignment",
      body: `You're on ${label} for ${prettyDay(workDate)}.`,
      url: "/timeclock",
    };
    await createNotifications(job.org_id, [profileId], { type: "assigned", ...payload });
    await sendPushToProfiles([profileId], "assigned", payload);
  }

  revalidatePath("/timeclock"); // the board + week grid
  revalidatePath("/planner"); // My-Day law: the clock-in default / current job follow this
  return { ok: true };
}

/**
 * The week grid's read: the org's assignments for the week `weekOffset` weeks
 * from the current one — SIGNED, and **positive = FUTURE** (planning looks
 * ahead; /timecards' back-paging offset points the other way on purpose).
 * Any org member may call it (RLS crew_day_assignments_read — a tech can see
 * where the week puts them); rows join the job's label fields for both label
 * worlds. Fails soft to an empty week until migration 0139 lands.
 */
export async function listWeekAssignments(weekOffset = 0): Promise<WeekAssignmentsResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const offset = Math.max(-52, Math.min(52, Math.trunc(Number(weekOffset) || 0)));
  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const settings = getOrgSettings((org as { settings?: unknown } | null)?.settings);
  const days = weekDayStrs(todayStrInTz(settings.timezone), settings.week_start, offset);

  const { data, error } = await supabase
    .from("crew_day_assignments")
    .select("profile_id, work_date, job_id, is_crew_lead, job:job_id(id, job_number, name, address, customers(name))")
    .gte("work_date", days[0])
    .lte("work_date", days[6])
    .order("work_date", { ascending: true });
  // Pre-0139 (or transient) failure: an empty week, never a dead page — the
  // 0128 fail-soft precedent.
  if (error) return { ok: true, days, rows: [] };

  const rows: CrewDayAssignmentRow[] = ((data ?? []) as any[]).map((r) => {
    const j = (r.job ?? null) as {
      id: string;
      job_number: string | null;
      name: string | null;
      address: string | null;
      customers?: { name?: string | null } | null;
    } | null;
    return {
      profile_id: r.profile_id as string,
      work_date: r.work_date as string,
      job_id: r.job_id as string,
      is_crew_lead: !!r.is_crew_lead,
      job: j
        ? {
            id: j.id,
            job_number: j.job_number ?? null,
            name: j.name ?? null,
            address: j.address ?? null,
            customer_name: j.customers?.name ?? null,
          }
        : null,
    };
  });
  return { ok: true, days, rows };
}
