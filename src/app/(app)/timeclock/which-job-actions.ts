"use server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { dbError } from "@/lib/db-error";
import { isStaffRole } from "@/lib/actions/perms";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { getOrgSettings } from "@/lib/org-settings";
import { todayBoundsInTz } from "@/lib/tz";
import { promoteJobToInProgress } from "@/lib/job-promote";
import {
  LAST_JOB_LOOKBACK_MS,
  WHICH_JOB_COLUMNS,
  closedPickable,
  orderWhichJobChoices,
  whichJobLabel,
  windowOnDay,
  type ChoiceJob,
  type WhichJobChoices,
  type WhichJobResult,
} from "./which-job-choices";

/**
 * THE JOBS "WHICH JOB ARE YOU ON?" OFFERS for one of the caller's own punches (which-job-choices
 * has the order and why). Read AFTER the punch is saved, by the sheet itself: the clock never
 * waits on this list.
 *
 * Every read runs on the caller's RLS client, and the job read selects labels and schedule only:
 * a tech sees the same rows as the office, with no price anywhere on them.
 */
export async function whichJobChoices(entryId: string, fromJobId?: string | null): Promise<WhichJobChoices> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, isStaff: false, error: "Not signed in." };

  const [meR, orgR, entryR] = await Promise.all([
    supabase.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
    supabase.from("time_entries").select("id, job_id, status").eq("id", entryId).eq("profile_id", user.id).maybeSingle(),
  ]);
  const isStaff = isStaffRole((meR.data as { role?: string } | null)?.role ?? "");
  const entry = entryR.data as { id: string; job_id: string | null } | null;
  if (!entry) return { ok: false, isStaff, error: "That punch isn't there any more. The office can see it on Timecards." };
  // A MOVE OFF THE APP'S PICK IS THE SAME QUESTION (Erik, 2026-10-01). The clock's sentence names the
  // job the app chose and its Change door opens this sheet with that job as `fromJobId`, so a punch
  // that carries exactly that job is offered the list. Any OTHER job on it means the screen is behind
  // (the office moved it, a Switch Job landed): the old refusal stands, because the list the sheet
  // would show would be answering about a punch that no longer exists as shown.
  const moving = !!fromJobId && entry.job_id === fromJobId;
  if (entry.job_id && !moving) return { ok: false, isStaff, error: "This punch is already on a job." };

  const settings = getOrgSettings((orgR.data as { settings?: unknown } | null)?.settings);
  const tz = settings.timezone || "America/Los_Angeles";
  const codesOn = settings.timeclock_job_codes;
  const { todayStr, dayStart, dayEnd } = todayBoundsInTz(tz);

  // Four reads at once: the job he punched on last (three days back), today's schedule segments,
  // the jobs in progress, and the jobs whose own window reaches today.
  //
  // NO CAP ON EITHER JOB LIST (build for millions). My Day learned it first: a .limit on the
  // in-progress read hid the oldest long-running jobs, the very ones a crew is on. The window read
  // is the only one that finds a job on today's schedule with no segment rows and not started yet,
  // so a cap there dropped today's job itself in a company with many recent jobs. It is bounded by
  // its filter instead: exactly the jobs whose own window covers today (onToday's rule: it starts
  // before today ends, and it starts today or ends today or later).
  const dayStartIso = dayStart.toISOString();
  const [lastR, segR, goingR, windowR] = await Promise.all([
    supabase
      .from("time_entries")
      .select("job_id, clock_in")
      .eq("profile_id", user.id)
      .neq("id", entry.id)
      .not("job_id", "is", null)
      .gte("clock_in", new Date(Date.now() - LAST_JOB_LOOKBACK_MS).toISOString())
      .order("clock_in", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.from("job_schedule_segments").select("job_id").lte("start_date", todayStr).gte("end_date", todayStr),
    supabase.from("jobs").select(WHICH_JOB_COLUMNS).eq("status", "in_progress").order("created_at", { ascending: false }),
    // A job with no segment rows is on today when its own window covers it.
    supabase
      .from("jobs")
      .select(WHICH_JOB_COLUMNS)
      .in("status", ACTIVE_JOB_STATUSES)
      .lt("scheduled_start", dayEnd.toISOString())
      .or(`scheduled_start.gte.${dayStartIso},scheduled_end.gte.${dayStartIso}`),
  ]);
  if (goingR.error) return { ok: false, isStaff, error: "Couldn't load the jobs just now. Skip, and the office will put this punch on its job." };

  const lastJobId = ((lastR.data as { job_id?: string | null } | null)?.job_id ?? null) || null;
  const segToday = new Set(((segR.data ?? []) as { job_id: string }[]).map((s) => s.job_id));
  const have = new Set<string>([...((goingR.data ?? []) as ChoiceJob[]), ...((windowR.data ?? []) as ChoiceJob[])].map((j) => j.id));
  const missing = [...new Set([lastJobId, ...segToday].filter((x): x is string => !!x && !have.has(x)))];
  const extraR = missing.length
    ? await supabase.from("jobs").select(WHICH_JOB_COLUMNS).in("id", missing).in("status", ACTIVE_JOB_STATUSES)
    : { data: [] };

  const all = [...((goingR.data ?? []) as ChoiceJob[]), ...((windowR.data ?? []) as ChoiceJob[]), ...(((extraR as { data?: unknown }).data ?? []) as ChoiceJob[])];

  // A GAP DAY IS NOT A JOB DAY. A job whose window reaches today but has day rows (segments) on
  // other days only is not on today's schedule: its window is just their first-to-last mirror. So
  // ask, for exactly the jobs the window alone would put on today, whether they have any day rows
  // (the same rule as scheduledJobFor, Next Up and the crew plan). A read that fails leaves the
  // window answering, as before.
  const windowOnly = [...new Set(all.filter((j) => !segToday.has(j.id) && windowOnDay(j, todayStr, tz)).map((j) => j.id))];
  const hasR = windowOnly.length
    ? await supabase.from("job_schedule_segments").select("job_id").in("job_id", windowOnly)
    : { data: [] };
  const hasSegments = new Set((((hasR as { data?: unknown }).data ?? []) as { job_id: string }[]).map((s) => s.job_id));

  const jobs = orderWhichJobChoices({
    jobs: all,
    lastJobId,
    segToday,
    hasSegments,
    todayStr,
    tz,
    codesOn,
    // On a move, the job the punch is on is never offered back to itself.
    excludeJobId: moving ? entry.job_id : null,
  });
  return { ok: true, isStaff, jobs };
}

/**
 * PUT THE PUNCH ON A JOB — the write behind "Which Job Are You On?" (My Day's Now card, and the
 * sheet every clock door opens when the clock couldn't tell the job).
 *
 * Sets job_id on the caller's OWN, still job-less time entry, so every hour of the punch lands on
 * the job. Why this is its own small action and not one of the two that already exist:
 *   · switchJob (0288 switch_job) re-points a job-less punch whole, exactly as this does, but it
 *     is the office's More Options door, only for a running clock, and needs a job the caller is
 *     not already on.
 *   · updateTimeEntry is the Timecards edit path — it demands clock_out and writes status
 *     'closed', so on an OPEN punch it would clock the person out to name the job.
 * Self-scoped (own entry), job visible to the caller's RLS client and still going. ONLY a punch
 * with no job: moving one that already carries a job stays the office's Timecards correction. That
 * is also why it is open to every role — a member naming the site they are standing on is the
 * same fact the resolver would have attached at clock-in, not an after-the-fact edit; the DB guard
 * (0143/0154) freezes clock_in/rate/person for a tech, never job_id.
 *
 * A PUNCH THAT JUST CLOSED counts too: the clock-out door asks once more when the shift ends still
 * on no job. Only within a day of its clock-out, and only with no time code on it (a code was named
 * on purpose); older ones are the office's, on Timecards.
 *
 * Naming the job is clocking into it, so a job not started yet is promoted to in progress, the
 * same promotion clock-in makes. A job on hold comes off hold the same way, and the answer says so
 * (`warning`, NY-hold 0366): the sheet lists a held job last, marked On Hold, so it is never a
 * surprise either.
 *
 * AND IT MOVES A PUNCH OFF THE JOB THE APP CHOSE (`fromJobId`; Erik, 2026-10-01: "we didn't do the
 * job at TTP 56 this morning"). The clock now says which job it picked when nobody picked it, and
 * that sentence's Change door opens this same sheet and lands on this same write — a punch whose job
 * nobody chose is not an after-the-fact edit, it is the person finally being asked. The whole punch
 * moves, every hour since the tap, which is why Switch Job is not the door: switch_job (0288) only
 * re-points whole for the first two minutes and CUTS after that, leaving the hours before the tap on
 * the job nobody picked — the exact 2h19m this defect is about.
 *
 * NO NEW AUTHORITY. A TECH has no job picker anywhere, so every job on a tech's punch is the app's
 * pick, and a tech could already move a job-less punch whole (above) and re-point inside two minutes
 * (switchJob). The OFFICE can already move any entry from Timecards. What is new is only that the
 * person is told, and that the move is not limited to the first two minutes. Bounded the same way as
 * every other pick: the caller's OWN punch, still open or closed within the day (closedPickable), a
 * job visible to the caller's RLS client and still going, and `fromJobId` named ON the write, so a
 * punch that moved underneath is a zero-row UPDATE that says so.
 *
 * Checked write (the silent-write law): a zero-row UPDATE is a refusal with a sentence.
 */
export async function putPunchOnJob(entryId: string, jobId: string, fromJobId?: string | null): Promise<WhichJobResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };

  const { data: entryRow } = await supabase
    .from("time_entries")
    .select("id, job_id, job_code, status, clock_out")
    .eq("id", entryId)
    .eq("profile_id", user.id)
    .maybeSingle();
  const entry = entryRow as { id: string; job_id: string | null; job_code: string | null; status: string; clock_out: string | null } | null;
  // `stale` refusals: the punch is not what the screen shows. The shell has no pull-to-refresh,
  // so the sentence never asks for one — the door re-renders from the server itself.
  if (!entry) return { ok: false, stale: true, error: "That punch isn't there any more. The screen is catching up." };
  // Moving off the app's pick: only off the very job the screen named. A punch on some OTHER job got
  // there another way (the office, a Switch Job) and that is Timecards' business, as it always was.
  const moving = !!fromJobId && entry.job_id === fromJobId;
  if (entry.job_id && !moving) {
    return { ok: false, stale: true, error: "This punch already carries a job. The screen is catching up; the office moves it from Timecards." };
  }
  if (moving && jobId === entry.job_id) return { ok: false, error: "That's the job it's already on." };
  const open = entry.status === "open";
  if (!open) {
    const code = (entry.job_code ?? "").trim();
    if (code) return { ok: false, stale: true, error: `That shift is filed under ${code}. The office moves it from Timecards.` };
    if (!closedPickable(entry.clock_out)) {
      return { ok: false, stale: true, error: "That shift closed a while ago, so the office puts it on its job from Timecards." };
    }
  }

  // A foreign/stray id resolves to nothing under RLS; a finished job is not a site to be on.
  const [{ data: jobRow }, { data: orgRow }] = await Promise.all([
    supabase.from("jobs").select("id, status, job_number, name, address, customers(name)").eq("id", jobId).maybeSingle(),
    supabase.from("organizations").select("settings").limit(1).maybeSingle(),
  ]);
  const job = jobRow as (ChoiceJob & { id: string }) | null;
  if (!job) return { ok: false, error: "That job isn't available." };
  if (!ACTIVE_JOB_STATUSES.includes(String(job.status ?? "") as (typeof ACTIVE_JOB_STATUSES)[number])) {
    return { ok: false, error: "That job is finished. Pick one that's still going, or skip and the office will pick." };
  }

  // The predicates repeat the checks above ON the write itself, so a punch that closed, reopened or
  // got a job between the read and the update is a zero-row UPDATE — reported, never assumed landed.
  const write = supabase
    .from("time_entries")
    .update({ job_id: job.id })
    .eq("id", entry.id)
    .eq("profile_id", user.id)
    .eq("status", entry.status);
  const { data: hit, error } = await (moving ? write.eq("job_id", fromJobId!) : write.is("job_id", null)).select("id").maybeSingle();
  if (error) return { ok: false, error: dbError(error) };
  if (!hit) {
    return moving
      ? { ok: false, stale: true, error: "Nothing changed: the punch closed or moved to another job in the meantime. The screen is catching up." }
      : { ok: false, stale: true, error: "Nothing changed: the punch closed or got a job in the meantime. The screen is catching up." };
  }

  // A held job comes off hold with the pick, and the sheet says so in its own words (NY-hold, 0366):
  // the same sentence the clock's other doors show, riding back as `warning`.
  const offHold = (await promoteJobToInProgress(supabase, job.id))?.offHold ?? null;

  revalidatePath("/planner"); // the Now card's doors
  revalidatePath("/timeclock"); // the running banner's job name
  revalidatePath("/timecards"); // the crew strip + week grid
  revalidatePath(`/jobs/${job.id}`); // the job's Time tab + labor totals
  revalidatePath("/jobs");
  // THE SCHEDULE FREES ITSELF (and this is why no migration is needed). A job's worked days are
  // DERIVED from its time_entries by job_id on every read (workedDaysFrom, schedule/actions), never
  // stored — so the day the app's pick pinned stops being a worked day the moment the punch leaves,
  // and the day moves again. Its page and the calendar just have to be told to re-read.
  if (moving) {
    revalidatePath(`/jobs/${fromJobId!}`);
    revalidatePath("/schedule");
    revalidatePath("/calendar");
  }
  if (offHold) revalidatePath("/schedule"); // the rail's held card goes
  const codesOn = getOrgSettings((orgRow as { settings?: unknown } | null)?.settings).timeclock_job_codes;
  return { ok: true, label: whichJobLabel(job, codesOn), ...(offHold ? { warning: offHold } : {}) };
}
