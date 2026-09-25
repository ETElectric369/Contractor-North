"use server";
/**
 * START THE JOB FROM THE VISIT (Erik, 2026-09-25, Tom Goodman: "I just needed a job linked to that
 * lead to start the clock, simple").
 *
 * Nothing here is new machinery. Each door is the app's own path, called in order:
 *   - the job:      createJobFromAppointment (it carries customer, address, planned time and lead,
 *                   and links appointments.job_id);
 *   - the clock:    the Timeclock's clockIn, or its switchJob when the tapper is already on the clock
 *                   somewhere else, so every guard those two keep (one open clock, the long-shift
 *                   refusal, the tech clamp, the job promotion) holds here too;
 *   - the link:     linkAppointmentTo, the Edit Details door, for "Link To J-055 Instead";
 *   - the ask:      ringOffice, for a tech on a visit with no job yet.
 *
 * The app suggests, a person decides: nothing links or starts itself, and every result says what
 * happened in one plain sentence.
 */
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";
import { getOrgSettings } from "@/lib/org-settings";
import { officeRecipients, ringOffice } from "@/lib/notifications";
import { startedAtProblem, startedWords, clockWords, jobShort, type StartedClock } from "@/lib/appointments/visit-start";
import { loadLinkInstead } from "@/lib/appointments/visit-start-read";
import { overlapRefusal } from "@/lib/overlap-refusal";
import type { GeoPoint } from "@/lib/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createJobFromAppointment, linkAppointmentTo } from "./actions";
import { clockIn, switchJob } from "../timeclock/actions";

export type StartJobResult = {
  ok: boolean;
  error?: string;
  jobId?: string;
  jobNumber?: string;
  /** The sentence to show: "Started J-056 for Tom Goodman and clocked you in at 12:00 PM." */
  message?: string;
  /** Something the person must read: the clock-in did not land, a pay rate stayed behind a switch. */
  warning?: string;
  /** The entry a fresh clock-in opened, for the Undo on the toast. Never set on a switch. */
  undoEntryId?: string;
  /** Refused because the tapper is already on the clock elsewhere: the sheet offers Switch To This
   *  Job instead (or, when that clock is on the job the visit could link to, Link To It). Nothing
   *  was created. */
  onClock?: OnClock;
};

/** The tapper's running clock, as the card needs it. `whole`: it has no job and no code, so a
 *  switch RE-POINTS the whole shift onto the new job instead of cutting it (0288). */
export type OnClock = { entryId: string; jobId: string | null; label: string; since: string; whole: boolean };

type VisitRow = {
  id: string;
  title: string | null;
  status: string | null;
  job_id: string | null;
  starts_at: string | null;
  customer_id: string | null;
  inquiry_id: string | null;
  customers: { name: string | null } | { name: string | null }[] | null;
  inquiries: { name: string | null } | { name: string | null }[] | null;
};

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

async function readVisit(supabase: SupabaseClient, id: string): Promise<VisitRow | null> {
  const { data } = await supabase
    .from("appointments")
    .select("id, title, status, job_id, starts_at, customer_id, inquiry_id, customers(name), inquiries(name)")
    .eq("id", id)
    .maybeSingle();
  return (data as VisitRow | null) ?? null;
}

function visitWho(v: VisitRow): string | null {
  return one(v.customers)?.name?.trim() || one(v.inquiries)?.name?.trim() || null;
}

async function orgTz(supabase: SupabaseClient): Promise<string> {
  const { data } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  return getOrgSettings((data as { settings?: unknown } | null)?.settings).timezone;
}

type OpenRow = {
  id: string;
  job_id: string | null;
  job_code: string | null;
  clock_in: string;
  job: { job_number: string | null; name: string | null } | { job_number: string | null; name: string | null }[] | null;
};

async function openEntryOf(supabase: SupabaseClient, userId: string): Promise<OpenRow | null> {
  const { data } = await supabase
    .from("time_entries")
    .select("id, job_id, job_code, clock_in, job:job_id(job_number, name)")
    .eq("profile_id", userId)
    .eq("status", "open")
    .maybeSingle();
  return (data as OpenRow | null) ?? null;
}

/** The running clock in the card's shape. */
function onClockOf(o: OpenRow, tz: string): OnClock {
  return {
    entryId: o.id,
    jobId: o.job_id,
    label: openLabel(o),
    since: clockWords(o.clock_in, tz),
    whole: !o.job_id && !(o.job_code ?? "").trim(),
  };
}

/** "J-050", or the time code a job-less clock runs on ("Shop"), or "the clock". */
function openLabel(o: OpenRow): string {
  const j = one(o.job);
  if (j) return jobShort(j);
  return (o.job_code ?? "").trim() || "no job";
}

/**
 * Make the visit's job, and (when asked) put the tapper on the clock on it.
 *
 *   clock "in":     clockIn at `startAt` (null = now). Refused, with nothing created, when the tapper
 *                   is already on the clock: the answer carries `onClock` and the sheet offers the
 *                   switch instead of a second open clock.
 *   clock "switch": switchJob from the running entry onto the new job, at now (a switch is a cut at
 *                   the moment of the tap; the start picker is for a fresh clock-in).
 *   clock "none":   the job only.
 *
 * Staff only: making a job is an office deed. A tech on an unlinked visit asks the office.
 */
export async function startJobFromVisit(input: {
  appointmentId: string;
  clock: "in" | "switch" | "none";
  /** ISO start for a fresh clock-in; null/absent = now. */
  startAt?: string | null;
  gps?: GeoPoint | null;
}): Promise<StartJobResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) {
    return { ok: false, error: "Only the office can start a job. Ask the office to start it, then clock in here." };
  }
  const supabase = ctx.supabase as unknown as SupabaseClient;

  const visit = await readVisit(supabase, input.appointmentId);
  if (!visit) return { ok: false, error: "That visit could not be found." };
  if (visit.status === "cancelled") return { ok: false, error: "This visit was cancelled. Nothing was started." };

  const tz = await orgTz(supabase);
  const startAt = input.clock === "in" ? (input.startAt ?? null) : null;
  if (input.clock === "in") {
    const problem = startedAtProblem(startAt, Date.now(), tz);
    if (problem) return { ok: false, error: `${problem} Nothing was started.` };
  }

  // Who is on the clock, read BEFORE anything is made, so a refusal leaves no job behind.
  let running: OpenRow | null = null;
  if (input.clock !== "none") {
    running = await openEntryOf(supabase, ctx.userId);
    if (input.clock === "in" && running && !(visit.job_id && running.job_id === visit.job_id)) {
      const oc = onClockOf(running, tz);
      return {
        ok: false,
        onClock: oc,
        error: `You're on the clock on ${oc.label} since ${oc.since}. Switch To This Job moves your clock here now. Nothing was started yet.`,
      };
    }
    /* THE RIGHT SHIFT IS NEVER CUT FOR A DUPLICATE (review, Tom Goodman as it stood): Erik on the
       clock on J-055, the job he made by hand for this very customer that afternoon, and the visit
       still unlinked. A switch here would mint J-056 and cut his J-055 shift onto it. The card leads
       with Link To J-055 in that case; this is the same answer for a stale page. */
    if (input.clock === "switch" && running?.job_id && !visit.job_id) {
      const pick = await loadLinkInstead(supabase, visit, tz);
      if (pick && pick.id === running.job_id) {
        const j = jobShort(pick);
        return {
          ok: false,
          error: `You're on the clock on ${j}, the job ${visitWho(visit) ?? "this customer"} already has from today. Link this visit to ${j} instead. Nothing was started.`,
        };
      }
    }
  }

  /* A START IN THE PAST MAY NOT LAND ON HOURS ALREADY RECORDED (review, 2026-09-25). The open row
     clockIn inserts passes 0278/0291 (they judge a finished shift), so the clash only surfaced at
     clock-out tonight, as a shift nobody could close. Asked here, before anything is made, with the
     Timecards' own test and words. Only a fresh clock-in has a start to judge: a switch cuts at now. */
  if (input.clock === "in" && startAt && !running) {
    const clash = await overlapRefusal(supabase, ctx.userId, Date.parse(startAt), Date.now(), { tz });
    if (clash) return { ok: false, error: `${clash} Nothing was started. Pick a start after that shift, or Now.` };
  }

  const made = await createJobFromAppointment(visit.id);
  if (!made.ok || !made.id) return { ok: false, error: made.error ?? "The job could not be started. Nothing was changed." };
  const jobId = made.id;
  // `already`: another device made this visit's job a moment ago, and made.id is THAT job.
  const existing = !!visit.job_id || !!made.already;

  const { data: jobRow } = await supabase.from("jobs").select("id, job_number, name").eq("id", jobId).maybeSingle();
  if (!jobRow) return { ok: false, error: "The job was made but could not be read back. Reload the page before trying again." };
  const jobNumber = jobShort(jobRow as { job_number?: string | null; name?: string | null });
  const customer = visitWho(visit);
  const warnings: string[] = [];
  if (made.note) warnings.push(made.note);

  let clock: StartedClock | null = null;
  let undoEntryId: string | undefined;

  if (input.clock === "switch" && running && running.job_id !== jobId) {
    const at = new Date().toISOString();
    const from = openLabel(running);
    const sw = await switchJob({ entry_id: running.id, job_id: jobId, job_code: null, gps: input.gps ?? null });
    if (!sw.ok) {
      warnings.push(`Your clock is still on ${from}: ${sw.error ?? "the switch did not go through."}`);
    } else {
      // A job-less clock is RE-POINTED whole (0288), not cut: the shift since its clock-in is now
      // on this job, and the sentence has to say that rather than "switched at 3:32 PM".
      clock = sw.mode === "repointed" ? { kind: "move", since: running.clock_in } : { kind: "switch", at, from };
      if (sw.warning) warnings.push(sw.warning);
    }
  } else if (input.clock === "in" || input.clock === "switch") {
    // "switch" with nothing running (the clock stopped since the sheet opened) is a plain clock-in at now.
    if (running && running.job_id === jobId) {
      clock = null; // already on this very job: nothing to do, and the sentence below says so
      warnings.push(`You were already on the clock on ${jobNumber}.`);
    } else {
      const res = await clockIn({ job_id: jobId, job_code: null, gps: input.gps ?? null, clock_in_at: startAt });
      if (!res.ok) {
        warnings.push(`The clock-in didn't go through: ${res.error ?? "try again from the job page."}`);
      } else {
        const now = await openEntryOf(supabase, ctx.userId);
        if (now && now.job_id === jobId) {
          clock = { kind: "in", at: now.clock_in };
          undoEntryId = now.id;
        } else {
          clock = { kind: "in", at: startAt ?? new Date().toISOString() };
        }
        if (res.warning) warnings.push(res.warning);
      }
    }
  }

  revalidatePath("/planner"); // My Day shows the visit, the job and who is on the clock
  revalidatePath(`/appointments/${visit.id}`);
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/jobs");
  revalidatePath("/timeclock");

  return {
    ok: true,
    jobId,
    jobNumber,
    message: startedWords({ jobNumber, customer, tz, clock, existing }),
    ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    ...(undoEntryId ? { undoEntryId } : {}),
  };
}

/**
 * "Link To J-055 Instead": the visit gets the job somebody already made for this customer today,
 * rather than a second one. Re-asks the same rule the page offered it from, so a stale page cannot
 * link a job the rule no longer names; Edit Details still links any job by hand.
 */
export async function linkVisitInstead(appointmentId: string, jobId: string): Promise<StartJobResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: "Only the office can link a visit to a job." };
  const supabase = ctx.supabase as unknown as SupabaseClient;

  const visit = await readVisit(supabase, appointmentId);
  if (!visit) return { ok: false, error: "That visit could not be found." };
  if (visit.job_id) {
    if (visit.job_id === jobId) return { ok: true, jobId, message: "This visit is already linked to that job." };
    return { ok: false, error: "This visit is already linked to another job. Nothing was changed." };
  }

  const tz = await orgTz(supabase);
  const pick = await loadLinkInstead(supabase, visit, tz);
  if (!pick || pick.id !== jobId) {
    return {
      ok: false,
      error: "That job is no longer the one to offer here. Nothing was changed. Edit Details links any job by hand.",
    };
  }

  const res = await linkAppointmentTo(appointmentId, "job", jobId);
  if (!res.ok) return { ok: false, error: res.error ?? "The visit could not be linked. Nothing was changed." };

  /* STAMP FOLLOWS DEED, the lead too (review, 2026-09-25). A visit booked from a lead that takes the
     existing job has converted that lead exactly as createJobFromAppointment would: the job carries
     the lead (only when it carries none), and the lead is won (only when nobody stamped it yet). */
  const warnings: string[] = [];
  if (visit.inquiry_id) {
    const nowIso = new Date().toISOString();
    const { error: jErr } = await supabase
      .from("jobs")
      .update({ inquiry_id: visit.inquiry_id })
      .eq("id", jobId)
      .is("inquiry_id", null)
      .select("id");
    const { error: lErr } = await supabase
      .from("inquiries")
      .update({ status: "won", converted_at: nowIso, updated_at: nowIso })
      .eq("id", visit.inquiry_id)
      .is("converted_at", null)
      .select("id");
    if (jErr || lErr) warnings.push("The lead behind this visit could not be marked won. Mark it on Leads.");
    revalidatePath("/leads");
  }

  const jobNumber = jobShort(pick);
  const running = await openEntryOf(supabase, ctx.userId);
  const onIt = running?.job_id === jobId ? ` Your clock is already running on ${jobNumber}.` : "";
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/planner");
  return {
    ok: true,
    jobId,
    jobNumber,
    message: `Linked this visit to ${jobNumber}. Nothing new was made.${onIt}`,
    ...(warnings.length ? { warning: warnings.join(" ") } : {}),
  };
}

/**
 * A tech on a visit with no job yet: ring the office (the bell, and one push per visit per 15
 * minutes), so "ask the office" is a button and never a dead end.
 */
export async function askOfficeToStartJob(appointmentId: string): Promise<{ ok: boolean; error?: string; message?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not signed in." };
  const { data: me } = await supabase.from("profiles").select("full_name, org_id, active").eq("id", user.id).maybeSingle();
  const prof = me as { full_name?: string | null; org_id?: string | null; active?: boolean | null } | null;
  if (!prof?.org_id || prof.active === false) return { ok: false, error: "This account can't send that." };

  const visit = await readVisit(supabase as unknown as SupabaseClient, appointmentId);
  if (!visit) return { ok: false, error: "That visit could not be found." };
  if (visit.job_id) return { ok: false, error: "This visit already has a job. Reload the page to clock in on it." };

  const recipients = await officeRecipients(supabase, user.id);
  if (!recipients.length) {
    return { ok: false, error: "Nobody in the office gets messages in the app yet. Call them instead." };
  }
  const first = (prof.full_name ?? "").trim().split(/\s+/)[0] || "A crew member";
  const who = visitWho(visit);
  const rang = await ringOffice(prof.org_id, recipients, {
    type: "visit_needs_job",
    title: `${first} needs a job started${who ? ` for ${who}` : ""}`,
    body: `${first} is at ${visit.title?.trim() || "a visit"} and can't clock in until it has a job. Start it from the visit.`,
    url: `/appointments/${visit.id}`,
    windowMinutes: 15,
    mode: "once_per_window",
  });
  if (rang === "failed" || rang === "nobody") {
    return { ok: false, error: "That didn't reach the office. Call them instead." };
  }
  return { ok: true, message: "The office has been asked. Once they start the job, you can clock in right here." };
}
