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
  CLOSED_PICK_WINDOW_MS,
  LAST_JOB_LOOKBACK_MS,
  WHICH_JOB_COLUMNS,
  orderWhichJobChoices,
  whichJobLabel,
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
export async function whichJobChoices(entryId: string): Promise<WhichJobChoices> {
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
  if (entry.job_id) return { ok: false, isStaff, error: "This punch is already on a job." };

  const settings = getOrgSettings((orgR.data as { settings?: unknown } | null)?.settings);
  const tz = settings.timezone || "America/Los_Angeles";
  const codesOn = settings.timeclock_job_codes;
  const { todayStr, dayStart, dayEnd } = todayBoundsInTz(tz);

  // Four reads at once: the job he punched on last (three days back), today's schedule segments,
  // the jobs in progress, and the jobs whose own window reaches today.
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
    supabase.from("jobs").select(WHICH_JOB_COLUMNS).eq("status", "in_progress").order("created_at", { ascending: false }).limit(100),
    // A job with no segment rows is on today when its own window covers it. Started within the
    // last month (a longer-running one is in progress already, and listed above).
    supabase
      .from("jobs")
      .select(WHICH_JOB_COLUMNS)
      .in("status", ACTIVE_JOB_STATUSES)
      .gte("scheduled_start", new Date(dayStart.getTime() - 31 * 86_400_000).toISOString())
      .lt("scheduled_start", dayEnd.toISOString())
      .limit(100),
  ]);
  if (goingR.error) return { ok: false, isStaff, error: "Couldn't load the jobs just now. Skip, and the office will put this punch on its job." };

  const lastJobId = ((lastR.data as { job_id?: string | null } | null)?.job_id ?? null) || null;
  const segToday = new Set(((segR.data ?? []) as { job_id: string }[]).map((s) => s.job_id));
  const have = new Set<string>([...((goingR.data ?? []) as ChoiceJob[]), ...((windowR.data ?? []) as ChoiceJob[])].map((j) => j.id));
  const missing = [...new Set([lastJobId, ...segToday].filter((x): x is string => !!x && !have.has(x)))];
  const extraR = missing.length
    ? await supabase.from("jobs").select(WHICH_JOB_COLUMNS).in("id", missing).in("status", ACTIVE_JOB_STATUSES)
    : { data: [] };

  const jobs = orderWhichJobChoices({
    jobs: [...((goingR.data ?? []) as ChoiceJob[]), ...((windowR.data ?? []) as ChoiceJob[]), ...(((extraR as { data?: unknown }).data ?? []) as ChoiceJob[])],
    lastJobId,
    segToday,
    todayStr,
    tz,
    codesOn,
  });
  return { ok: true, isStaff, jobs };
}

/**
 * PUT THE PUNCH ON A JOB — the write behind "Which Job Are You On?" (My Day's Now block, and the
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
 * same promotion clock-in makes.
 *
 * Checked write (the silent-write law): a zero-row UPDATE is a refusal with a sentence.
 */
export async function putPunchOnJob(entryId: string, jobId: string): Promise<WhichJobResult> {
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
  if (entry.job_id) {
    return { ok: false, stale: true, error: "This punch already carries a job. The screen is catching up; the office moves it from Timecards." };
  }
  const open = entry.status === "open";
  if (!open) {
    const code = (entry.job_code ?? "").trim();
    if (code) return { ok: false, stale: true, error: `That shift is filed under ${code}. The office moves it from Timecards.` };
    const outMs = Date.parse(entry.clock_out ?? "");
    if (!Number.isFinite(outMs) || Date.now() - outMs > CLOSED_PICK_WINDOW_MS) {
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
  const { data: hit, error } = await supabase
    .from("time_entries")
    .update({ job_id: job.id })
    .eq("id", entry.id)
    .eq("profile_id", user.id)
    .eq("status", entry.status)
    .is("job_id", null)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false, error: dbError(error) };
  if (!hit) return { ok: false, stale: true, error: "Nothing changed: the punch closed or got a job in the meantime. The screen is catching up." };

  await promoteJobToInProgress(supabase, job.id);

  revalidatePath("/planner"); // the Now block's doors
  revalidatePath("/timeclock"); // the running banner's job name
  revalidatePath("/timecards"); // the crew strip + week grid
  revalidatePath(`/jobs/${job.id}`); // the job's Time tab + labor totals
  revalidatePath("/jobs");
  const codesOn = getOrgSettings((orgRow as { settings?: unknown } | null)?.settings).timeclock_job_codes;
  return { ok: true, label: whichJobLabel(job, codesOn) };
}
