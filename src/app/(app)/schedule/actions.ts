"use server";

import { revalidatePath } from "next/cache";
import { emptyToNull } from "@/lib/forms";
import { requireStaff } from "@/lib/staff-guard";
import { getOrgSettings } from "@/lib/org-settings";
import { todayStrInTz, tzLocalHourUtc, tzDateTimeUtc } from "@/lib/tz";
import { addDaySegment, shiftSegmentCovering } from "@/lib/schedule-math";
import type { SupabaseClient } from "@supabase/supabase-js";

export type Result = { ok: boolean; error?: string; id?: string };

// Work-day window the scheduler blocks off for a dated (all-day) job.
const DAY_START_HOUR = 8; // 8 AM local
const DAY_END_HOUR = 16; // 4 PM local

/** The org's IANA timezone (default America/Los_Angeles). Server actions run in
 *  UTC, so any "8 AM local" instant must be built against this — never via a
 *  bare `new Date("…T08:00")`, which the server parses as UTC. */
async function orgTimezone(supabase: SupabaseClient): Promise<string> {
  const { data } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  return getOrgSettings((data as any)?.settings).timezone;
}

/** The stored scheduled_start's wall-clock "HH:MM" in the org timezone, or null.
 *  Lets a day-move preserve an explicit start time instead of snapping back to
 *  the 8 AM default. A time that reads exactly as the all-day default window
 *  start (08:00) is treated as "no explicit time" — the same convention the
 *  calendar uses to decide whether to render a time at all. */
function localHmInTz(iso: string | null, tz: string): string | null {
  if (!iso) return null;
  const hm = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(iso));
  return hm === `${String(DAY_START_HOUR).padStart(2, "0")}:00` ? null : hm;
}

/** Advance an early-stage job to "scheduled" once it has a date — without ever
 *  downgrading a job that's already further along (in_progress, complete, …).
 *  The conditional `.in()` means non-early jobs are simply left untouched. */
async function advanceToScheduled(supabase: SupabaseClient, id: string): Promise<void> {
  await supabase
    .from("jobs")
    .update({ status: "scheduled" })
    .eq("id", id)
    .in("status", ["lead", "quoted", "estimate"]);
}

export async function createJob(formData: FormData): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const start = String(formData.get("scheduled_start") ?? "");
  const address = emptyToNull(formData.get("address"));

  // Optionally create a customer inline (when no existing one is selected).
  let customerId = emptyToNull(formData.get("customer_id"));
  const newCustomerName = String(formData.get("new_customer_name") ?? "").trim();
  if (!customerId && newCustomerName) {
    const { data: cust, error: cErr } = await supabase
      .from("customers")
      .insert({
        name: newCustomerName,
        phone: emptyToNull(formData.get("new_customer_phone")),
        email: emptyToNull(formData.get("new_customer_email")),
        status: "active",
        created_by: ctx.userId,
      })
      .select("id")
      .single();
    if (cErr) return { ok: false, error: cErr.message };
    customerId = cust.id;
  }

  // Fragment-first: a bare address (or just a customer) is a valid start — never
  // make the caller invent a name. Default: address → customer's name → dated stub.
  let name = String(formData.get("name") ?? "").trim();
  if (!name && address) name = address;
  if (!name && customerId) {
    if (newCustomerName) {
      name = newCustomerName;
    } else {
      const { data: cust } = await supabase.from("customers").select("name").eq("id", customerId).maybeSingle();
      name = String(cust?.name ?? "").trim();
    }
  }
  if (!name) {
    const tz = await orgTimezone(supabase); // org-local date, not the server's UTC day
    const day = new Date(`${todayStrInTz(tz)}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    name = `New job — ${day}`;
  }

  const { data, error } = await supabase
    .from("jobs")
    .insert({
      name,
      customer_id: customerId,
      description: emptyToNull(formData.get("description")),
      // In Progress is the default (Erik 2026-07): when he creates a job by hand he's usually
      // already working it — "estimate" as a default just parked real work in a dead bucket.
      status: String(formData.get("status") || "in_progress"),
      billing_type: String(formData.get("billing_type") ?? "tm"), // T&M is the default now (Estimate); switch to fixed per job
      address,
      scheduled_start: start ? new Date(start).toISOString() : null,
      created_by: ctx.userId,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: error.message };

  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day reads today's scheduled jobs — keep it in sync
  return { ok: true, id: data.id };
}

// setJobStatus lived here as an UNGUARDED copy (no requireStaff / no status whitelist) — the job-page
// status dropdown imported THIS one, silently bypassing the guard on the canonical jobs/actions copy.
// Removed to kill the name-collision footgun; the single caller now imports the guarded jobs/actions one
// (which revalidates /schedule + /planner so the calendar stays fresh).

/** Assign a job to a single employee (or clear). */
export async function setJobAssignee(
  id: string,
  employeeId: string,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase
    .from("jobs")
    .update({ assigned_to: employeeId ? [employeeId] : [] })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day reads today's scheduled jobs — keep it in sync
  revalidatePath(`/jobs/${id}`);
  return { ok: true };
}

/** Set a job's FULL crew (multi-assign). The picker sends the complete desired set, so ticking a
 *  SECOND person ADDS them instead of replacing — the "put both me and Brian on it" fix. This is the
 *  #1 item from both the audit and Nort's self-review: the old single-Select silently overwrote the
 *  crew to one person. De-duped; empty = unassigned. Same guards/revalidation as setJobAssignee. */
export async function setJobCrew(id: string, employeeIds: string[]): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const ids = Array.from(new Set((employeeIds ?? []).map(String).filter(Boolean)));
  const { error } = await supabase.from("jobs").update({ assigned_to: ids }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/schedule");
  revalidatePath("/planner");
  revalidatePath(`/jobs/${id}`);
  return { ok: true };
}

/** Offer the customer up to 3 date+time slots; returns the public pick token.
 *  A slot with no time schedules the job at 8 AM (legacy behavior). */
export async function createScheduleProposal(
  jobId: string,
  slots: { date: string; time?: string }[],
  timeNote?: string | null,
): Promise<Result & { token?: string }> {
  const ctx = await requireStaff(); // defense-in-depth (RLS also blocks non-staff)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  const clean = slots
    .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s?.date ?? ""))
    .map((s) => ({ date: s.date, time: /^\d{2}:\d{2}/.test(s.time ?? "") ? (s.time as string) : "" }))
    .slice(0, 3);
  if (!clean.length) return { ok: false, error: "Pick at least one date." };

  // One pending proposal per job — replace any existing one.
  await supabase.from("schedule_proposals").update({ status: "cancelled" }).eq("job_id", jobId).eq("status", "pending");

  const { data, error } = await supabase
    .from("schedule_proposals")
    .insert({ job_id: jobId, dates: clean, time_note: timeNote || null, created_by: ctx.userId })
    .select("token")
    .single();
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true, token: data.token };
}

export async function cancelScheduleProposal(id: string, jobId: string): Promise<Result> {
  const ctx = await requireStaff(); // defense-in-depth (RLS also blocks non-staff)
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  const { error } = await supabase.from("schedule_proposals").update({ status: "cancelled" }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/jobs/${jobId}`);
  return { ok: true };
}

// setJobSchedule (raw scheduled_start/end writer) is GONE: it never touched
// job_schedule_segments, so the calendar (segments-first) kept drawing a moved
// multi-range job on its old days — the stale-schedule trap. Day moves go
// through moveJobDay/placeJobOnDay below; range edits through setJobScheduleRanges.

export type DateRange = { start: string; end: string }; // yyyy-mm-dd each

/** Canonical writer for a job's schedule as one or more date ranges. Replaces
 *  all segments, and mirrors the overall min start / max end onto
 *  jobs.scheduled_start/end (8am–4pm local) so every legacy reader still works.
 *
 *  `startTime` ("HH:MM", optional) refines ONLY the single primary
 *  scheduled_start mirror — a real time-of-day the calendar renders instead of
 *  the all-day window. Segments stay date-only (a time refines the primary start,
 *  not each span). When omitted, any explicit time already on the job is
 *  preserved (so a day-move keeps it) and otherwise the 8 AM default is used. */
export async function setJobScheduleRanges(
  jobId: string,
  ranges: DateRange[],
  startTime?: string | null,
): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;

  // Keep only well-formed ranges; default a missing end to the start.
  const clean = ranges
    .map((r) => ({ start: r.start, end: r.end || r.start }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.start) && /^\d{4}-\d{2}-\d{2}$/.test(r.end))
    .map((r) => (r.end < r.start ? { start: r.start, end: r.start } : r))
    .sort((a, b) => a.start.localeCompare(b.start));

  // Mirror the overall window onto the job FIRST — this is what every legacy
  // reader uses, and it must succeed even if the segments table isn't there.
  // Build the 8am–4pm window in the ORG timezone (this runs server-side in UTC,
  // so a bare `new Date("…T08:00")` would store 8am UTC = ~midnight Pacific and
  // disagree with the client-side writers — the root of the "wrong time" bug).
  const tz = await orgTimezone(supabase);
  const minStart = clean.length ? clean[0].start : null;
  const maxEnd = clean.length ? clean.reduce((m, r) => (r.end > m ? r.end : m), clean[0].end) : null;

  // Decide the primary start's time-of-day, with THREE distinct intents:
  //  • startTime === undefined (movers, undo, registry verb): PRESERVE whatever
  //    real time the job already carries so a day-move doesn't snap it to 8 AM.
  //  • startTime "HH:MM": use it (an explicit time-of-day the editor set).
  //  • startTime null/"" (the editor cleared the time input): back to all-day.
  let clock: string | null;
  if (/^\d{2}:\d{2}/.test(startTime ?? "")) {
    clock = (startTime as string).slice(0, 5);
  } else if (startTime === undefined && minStart) {
    const { data: prior } = await supabase.from("jobs").select("scheduled_start").eq("id", jobId).maybeSingle();
    clock = localHmInTz((prior as any)?.scheduled_start ?? null, tz);
  } else {
    clock = null; // explicit clear (null/"") or no start → 8 AM default window
  }
  const startIso = minStart
    ? clock
      ? tzDateTimeUtc(minStart, clock, tz) ?? tzLocalHourUtc(minStart, DAY_START_HOUR, tz).toISOString()
      : tzLocalHourUtc(minStart, DAY_START_HOUR, tz).toISOString()
    : null;

  const patch: Record<string, unknown> = {
    scheduled_start: startIso,
    scheduled_end: maxEnd ? tzLocalHourUtc(maxEnd, DAY_END_HOUR, tz).toISOString() : null,
    updated_at: new Date().toISOString(),
  };
  // The mirror update must PROVE it touched a row: an RLS-invisible or nonexistent
  // job matches zero rows (no error), and without this guard we'd fall through to the
  // segment insert below, which org-stamps to the CALLER — writing an orphan segment
  // for a foreign job id. Guarding here (the choke point) covers every caller: the
  // movers, the calendar undo, the schedule control, the registry verb, and a direct
  // server-action POST (audit cn-v328 — the loadJobDaySegments guard only caught the
  // wrappers). See also the belt-and-suspenders note in that audit.
  const { data: upd, error } = await supabase.from("jobs").update(patch).eq("id", jobId).select("id");
  if (error) return { ok: false, error: error.message };
  if (!upd?.length) return { ok: false, error: "Job not found." };
  // A scheduled date advances early-stage status (consistent with the other writers).
  if (minStart) await advanceToScheduled(supabase, jobId);

  // Replace segments wholesale. If the table is missing (migration 0040 not yet
  // applied) a single range is already fully saved via the mirror above; only
  // multi-range needs the table, so surface a clear message in that case.
  const { error: delErr } = await supabase.from("job_schedule_segments").delete().eq("job_id", jobId);
  let segOk = !delErr;
  if (segOk && clean.length) {
    const rows = clean.map((r) => ({ job_id: jobId, start_date: r.start, end_date: r.end }));
    const { error: insErr } = await supabase.from("job_schedule_segments").insert(rows);
    segOk = !insErr;
  }

  revalidatePath("/schedule");
  revalidatePath("/planner"); // My Day reads today's scheduled jobs — keep it in sync
  revalidatePath("/jobs");
  revalidatePath(`/jobs/${jobId}`);

  // Surface ANY segment-write failure (not just multi-range) so the editor
  // never silently shows a stale range while the mirror moved underneath it.
  if (!segOk && clean.length > 1) {
    return { ok: false, error: "Multiple date ranges need a quick database update (migration 0040). The first range was saved." };
  }
  if (!segOk && clean.length === 1) {
    return { ok: false, error: "Couldn't save the date range — please try again. The job's overall window was updated." };
  }
  return { ok: true };
}

/** A job's schedule as date-only segments, for read-modify-write math. Legacy
 *  fallback: a job scheduled before segments existed (migration 0040) may carry
 *  only the scheduled_start/end mirror — synthesize that window (org-tz dates)
 *  so a move/place computed from "no segments" can't drop it. */
async function loadJobDaySegments(
  supabase: SupabaseClient,
  jobId: string,
): Promise<{ segments: DateRange[]; error?: string }> {
  const { data: segRows, error } = await supabase
    .from("job_schedule_segments")
    .select("start_date, end_date")
    .eq("job_id", jobId)
    .order("start_date");
  if (error) return { segments: [], error: error.message };
  const segments = (segRows ?? []).map((s: any) => ({ start: s.start_date as string, end: s.end_date as string }));
  if (segments.length) return { segments };
  const { data: job } = await supabase.from("jobs").select("scheduled_start, scheduled_end").eq("id", jobId).maybeSingle();
  // No segments AND no visible job = the id isn't ours (RLS) or doesn't exist. Bail
  // so movers/placers can't write an orphan segment row against a foreign job id
  // (audit cn-v328: the insert would org-stamp to the CALLER and pass WITH CHECK).
  if (!job) return { segments: [], error: "Job not found." };
  if (job?.scheduled_start) {
    const tz = await orgTimezone(supabase);
    const start = todayStrInTz(tz, new Date(job.scheduled_start));
    const end = job.scheduled_end ? todayStrInTz(tz, new Date(job.scheduled_end)) : start;
    segments.push({ start, end: end < start ? start : end });
  }
  return { segments };
}

/** MOVE one of a job's scheduled ranges to start on a new day, preserving its
 *  length and every OTHER range. Read-modify-write by construction: it loads ALL
 *  segments, shifts only the one covering fromDate (null = the earliest/only),
 *  and writes the FULL set back through setJobScheduleRanges — never just the
 *  tapped day, which would silently erase multi-range schedules. A pending
 *  customer date-pick link blocks the move (needsProposalConfirm) until the
 *  caller confirms withdrawing it, so a later customer tap on an OLD option
 *  can't silently overwrite the move. */
export async function moveJobDay(
  jobId: string,
  fromDate: string | null,
  toDate: string,
  opts?: { cancelProposals?: boolean },
): Promise<Result & { needsProposalConfirm?: boolean }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) return { ok: false, error: "Pick a day to move it to." };
  const from = fromDate && /^\d{4}-\d{2}-\d{2}$/.test(fromDate) ? fromDate : null;

  const { data: pending } = await supabase
    .from("schedule_proposals")
    .select("id")
    .eq("job_id", jobId)
    .eq("status", "pending")
    .limit(1);
  if (pending?.length) {
    if (!opts?.cancelProposals) {
      return {
        ok: false,
        needsProposalConfirm: true,
        error: "A date-pick link is out to the customer for this job — moving it withdraws that link.",
      };
    }
    // Withdraw it the same way createScheduleProposal replaces a pending one.
    await supabase.from("schedule_proposals").update({ status: "cancelled" }).eq("job_id", jobId).eq("status", "pending");
  }

  const { segments, error: segErr } = await loadJobDaySegments(supabase, jobId);
  if (segErr) return { ok: false, error: segErr };
  // setJobScheduleRanges revalidates /schedule, /planner, /jobs, and the job page.
  return setJobScheduleRanges(jobId, shiftSegmentCovering(segments, from, toDate));
}

/** PLACE a job on a day without touching anything already scheduled — the tray
 *  gesture. UNION, not replace: a needs-return job keeps its worked-history
 *  segments on the calendar instead of collapsing to the tapped day. */
export async function placeJobOnDay(jobId: string, dateISO: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const supabase = ctx.supabase;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) return { ok: false, error: "Pick a day." };
  const { segments, error: segErr } = await loadJobDaySegments(supabase, jobId);
  if (segErr) return { ok: false, error: segErr };
  // setJobScheduleRanges revalidates /schedule, /planner, /jobs, and the job page.
  return setJobScheduleRanges(jobId, addDaySegment(segments, dateISO));
}

