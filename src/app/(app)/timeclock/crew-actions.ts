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
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { pickScheduledJobForDay } from "./crew-plan";

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
  /**
   * WHAT "no job" MEANS (0170). Absence used to mean two opposite things at once, which is the
   * whole bug behind "can't unassign Brian":
   *   "clear"  — forget the plan for this day. The row is deleted and the board goes back to
   *              GUESSING, which is what it did before and what made the old "— No job —" a no-op.
   *   "off"    — he is deliberately not on a job (vacation, sick, day off). Writes a row that
   *              short-circuits every guess, so the cell reads OFF and stays OFF.
   */
  clear?: "forget" | "off";
  offReason?: "vacation" | "sick" | "other" | null;
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
    // OFF is a RECORD, not an absence. Deleting the row hands the cell straight back to the
    // inference — which cannot return "nobody", because the member is still on the job's roster —
    // so the same job reappeared one refresh later. Writing an explicit off row is what finally
    // lets a day be empty on purpose. Deliberately leaves jobs.assigned_to alone: a man on
    // vacation has not left the crew, and stripping the roster would mean re-adding him by hand,
    // from memory, on every job, next Monday.
    if (input.clear === "off") {
      const { data: me } = await supabase.from("profiles").select("org_id").eq("id", ctx.userId).maybeSingle();
      const { error } = await supabase.from("crew_day_assignments").upsert(
        {
          org_id: (me as { org_id?: string } | null)?.org_id ?? null,
          profile_id: profileId,
          work_date: workDate,
          job_id: null,
          kind: "off",
          off_reason: input.offReason ?? null,
          is_crew_lead: false,
          created_by: ctx.userId,
        },
        { onConflict: "profile_id,work_date" },
      );
      if (error) return { ok: false, error: error.message };
      revalidatePath("/timeclock");
      revalidatePath("/planner");
      return { ok: true };
    }
    // "forget" — drop the plan and let the board suggest again. Same behaviour as before 0170.
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
      // Pinning a job must also clear a prior OFF for that day — otherwise the upsert would leave
      // kind='off' beside a job_id, which the 0170 shape constraint (rightly) refuses.
      kind: "job",
      off_reason: null,
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

/**
 * MARK SOMEBODY OFF FOR A RANGE OF DAYS — vacation, sick leave, a long weekend.
 *
 * This is the shape the need actually has. A man out until the 7th is ONE fact about a PERSON, not
 * eleven facts about jobs — and the alternative the app offered was to strip him from every job's
 * roster and re-add him, from memory, on every job, when he gets back. So: one action, N day rows,
 * and `jobs.assigned_to` is never touched. He hasn't left the crew; he just isn't there.
 *
 * Writes only WEEKDAYS by default, because a Saturday nobody was working doesn't need a record
 * saying so — and rows that say nothing make the ones that do say something harder to see.
 */
export async function setCrewOffRange(input: {
  profileId: string;
  fromDate: string; // YYYY-MM-DD, org-local, inclusive
  toDate: string;   // inclusive
  reason?: "vacation" | "sick" | "other" | null;
  includeWeekends?: boolean;
}): Promise<CrewActionResult & { days?: number }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { profileId, fromDate, toDate } = input;

  if (!profileId) return { ok: false, error: "Pick a crew member." };
  if (!isYmd(fromDate) || !isYmd(toDate)) return { ok: false, error: "I couldn't read those dates." };
  if (toDate < fromDate) return { ok: false, error: "The last day is before the first one." };

  // A bounded span. Anything longer isn't a vacation, it's a leave of absence, and that should be
  // a deliberate conversation rather than 400 silent rows.
  const days: string[] = [];
  for (let d = new Date(`${fromDate}T00:00:00Z`); ; d.setUTCDate(d.getUTCDate() + 1)) {
    const ds = d.toISOString().slice(0, 10);
    if (ds > toDate) break;
    if (days.length > 120) return { ok: false, error: "That's over four months — set it in shorter stretches." };
    const dow = d.getUTCDay();
    if (!input.includeWeekends && (dow === 0 || dow === 6)) continue;
    days.push(ds);
  }
  if (!days.length) return { ok: false, error: "No working days in that range." };

  const { data: member } = await supabase.from("profiles").select("id, org_id").eq("id", profileId).maybeSingle();
  if (!member) return { ok: false, error: "Member not found." };

  // One upsert for the whole span — a partial write would leave somebody half on vacation, which
  // is worse than a clean failure because nothing on screen would say so.
  const { error } = await supabase.from("crew_day_assignments").upsert(
    days.map((work_date) => ({
      org_id: (member as { org_id?: string }).org_id ?? null,
      profile_id: profileId,
      work_date,
      job_id: null,
      kind: "off",
      off_reason: input.reason ?? "vacation",
      is_crew_lead: false,
      created_by: ctx.userId,
    })),
    { onConflict: "profile_id,work_date" },
  );
  if (error) return { ok: false, error: error.message };

  revalidatePath("/timeclock");
  revalidatePath("/planner");
  revalidatePath("/schedule");
  return { ok: true, days: days.length };
}

/** Undo a range — put those days back to "nothing planned" so the board can plan them again. */
export async function clearCrewOffRange(input: {
  profileId: string;
  fromDate: string;
  toDate: string;
}): Promise<CrewActionResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  if (!isYmd(input.fromDate) || !isYmd(input.toDate)) return { ok: false, error: "I couldn't read those dates." };
  // Only OFF rows are cleared — a real job pinned inside the range is a plan somebody made, and
  // cancelling a vacation must never quietly delete it.
  const { error } = await ctx.supabase
    .from("crew_day_assignments")
    .delete()
    .eq("profile_id", input.profileId)
    .eq("kind", "off")
    .gte("work_date", input.fromDate)
    .lte("work_date", input.toDate);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/timeclock");
  revalidatePath("/planner");
  return { ok: true };
}

/**
 * FILL THE WEEK FROM THE SCHEDULE — turn the guess into a decision.
 *
 * THE PROBLEM WITH THE OLD PILL: the board drew a dashed "suggested job" chip in the same slot it
 * draws real assignments. Nothing was saved. Erik's "i didn't know what that did" was exactly
 * right, because it did nothing — it was the app having an OPINION where it shows FACTS, and the
 * opinion vanished on refresh. Worse, it made the plan un-comparable: you cannot diff the schedule
 * against the timecards when half the schedule was never written down.
 *
 * THE RULE THIS IMPLEMENTS:
 *
 *   Never SHOW a guess. Offer to MAKE the guess real, then show what's real.
 *
 * So this materialises the suggestion into ordinary rows the office can then edit, reassign or
 * clear like any other. Afterwards every cell on the board is a decision somebody made.
 *
 * NEVER OVERWRITES. An existing row — a pinned job OR an OFF day — is a decision, and a bulk
 * convenience must not walk over one. Only genuinely empty days are filled, and only where the
 * schedule actually puts that person somewhere.
 */
export async function fillWeekFromSchedule(input: {
  weekOffset?: number;
  /** Limit to one person (the per-member "fill mine" affordance). */
  profileId?: string;
}): Promise<CrewActionResult & { filled?: number }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const offset = Math.max(-52, Math.min(52, Math.trunc(Number(input.weekOffset) || 0)));
  const { data: org } = await supabase.from("organizations").select("id, settings").limit(1).maybeSingle();
  const settings = getOrgSettings((org as { settings?: unknown } | null)?.settings);
  const orgId = (org as { id?: string } | null)?.id ?? null;
  const days = weekDayStrs(todayStrInTz(settings.timezone), settings.week_start, offset);
  const todayStr = todayStrInTz(settings.timezone);

  const [{ data: members }, { data: jobRows }, { data: existing }] = await Promise.all([
    supabase.from("profiles").select("id").eq("active", true),
    supabase
      .from("jobs")
      .select("id, scheduled_start, assigned_to")
      .in("status", ACTIVE_JOB_STATUSES),
    supabase
      .from("crew_day_assignments")
      .select("profile_id, work_date")
      .gte("work_date", days[0])
      .lte("work_date", days[6]),
  ]);

  const jobs = ((jobRows ?? []) as { id: string; scheduled_start: string | null; assigned_to: string[] | null }[]);
  const { data: segs } = await supabase
    .from("job_schedule_segments")
    .select("job_id, start_date, end_date")
    .lte("start_date", days[6])
    .gte("end_date", days[0]);
  const segsByJob = new Map<string, { start: string; end: string }[]>();
  for (const sg of (segs ?? []) as { job_id: string; start_date: string; end_date: string }[]) {
    const list = segsByJob.get(sg.job_id) ?? [];
    list.push({ start: sg.start_date, end: sg.end_date });
    segsByJob.set(sg.job_id, list);
  }
  const schedDayByJob = new Map<string, string | null>(
    jobs.map((j) => [j.id, j.scheduled_start ? todayStrInTz(settings.timezone, new Date(j.scheduled_start)) : null]),
  );

  // Any existing row — job OR off — makes that (person, day) untouchable.
  const taken = new Set(
    ((existing ?? []) as { profile_id: string; work_date: string }[]).map((r) => `${r.profile_id}|${r.work_date}`),
  );

  const toWrite: { org_id: string | null; profile_id: string; work_date: string; job_id: string; kind: string; created_by: string }[] = [];
  for (const m of (members ?? []) as { id: string }[]) {
    if (input.profileId && m.id !== input.profileId) continue;
    const mine = jobs.filter((j) => (j.assigned_to ?? []).includes(m.id));
    if (!mine.length) continue;
    for (const ds of days) {
      // PAST DAYS ARE HISTORY, not a plan. Writing one would assert somebody was somewhere, and
      // that is the timecards' truth to tell, not the planner's.
      if (ds < todayStr) continue;
      if (taken.has(`${m.id}|${ds}`)) continue;
      const pick = pickScheduledJobForDay(mine, ds, segsByJob, schedDayByJob);
      if (!pick) continue;
      toWrite.push({ org_id: orgId, profile_id: m.id, work_date: ds, job_id: pick.id, kind: "job", created_by: ctx.userId });
    }
  }

  if (!toWrite.length) return { ok: true, filled: 0 };
  const { error } = await supabase.from("crew_day_assignments").upsert(toWrite, { onConflict: "profile_id,work_date" });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/timeclock");
  revalidatePath("/planner");
  return { ok: true, filled: toWrite.length };
}
