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
 *   - the link:     linkAppointmentTo, the Edit Details door, for "Link to J-055 Instead";
 *   - the ask:      ringOffice, for a tech on a visit with no job yet.
 *
 * The app suggests, a person decides: nothing links or starts itself, and every result says what
 * happened in one plain sentence.
 *
 * THE CALLER'S OWN WORDS (the visit-page-in-Spanish wave): every message, error and warning this file
 * returns, and the running clock's `since`, come from lib/words/visit-page (vp_) in the caller's
 * language — profiles.language through lib/lang-of callerLang, read ONCE per call and only when an
 * answer needs words (hear-actions wordsOf, the same shape); English when nobody is signed in or the
 * read fails, byte for byte what this file always said. The pure rules it shares with the page
 * (lib/appointments/visit-start: startedAtProblem, startedWords, jobShort, clockWords) take the same
 * language and the caller's translator. A warning the Time Clock's own clockIn / switchJob sends back
 * is already in the caller's language (cs_) and rides through as received. The office's bell line
 * (Ask the Office) is one line for every office reader and stays as it was.
 */
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff-guard";
import { getOrgSettings } from "@/lib/org-settings";
import { officeRecipients, ringOffice } from "@/lib/notifications";
import { startedAtProblem, startedWords, clockWords, jobShort, visitIsOver, type StartedClock } from "@/lib/appointments/visit-start";
import { loadLinkInstead } from "@/lib/appointments/visit-start-read";
import { clockInClashWords, findOverlap } from "@/lib/overlap-refusal";
import type { GeoPoint } from "@/lib/types";
import type { SupabaseClient } from "@supabase/supabase-js";
import { translator } from "@/lib/i18n";
import { callerLang } from "@/lib/lang-of";
import { fillSlots, say, type Words } from "@/lib/lang-words";
import type { Lang } from "@/lib/locale";
import { createJobFromAppointment, linkAppointmentTo } from "./actions";
import { clockIn, switchJob } from "../timeclock/actions";

/** The caller's language, read once per call, and its words. Not exported: a "use server" file exports only async functions. */
type Said = { lang: () => Promise<Lang>; say: (key: string, vars?: Record<string, string | number>) => Promise<string> };
function wordsOf(supabase: Awaited<ReturnType<typeof createClient>>, userId?: string | null): Said {
  let read: Promise<Lang> | null = null;
  const lang = () => (read ??= callerLang(supabase as unknown as Parameters<typeof callerLang>[0], userId));
  return { lang, say: async (key, vars) => fillSlots(translator(await lang())(key), vars) };
}

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

/**
 * The tapper's running clock, as the card needs it.
 *
 * `clockIn` and `jobCode` are here, and no `whole` flag is, because whether a switch moves the whole
 * punch or cuts it turns on the punch's AGE (switch-window) — and this answer is built on the server,
 * minutes before the person taps. A boolean decided here would be a promise about the past: the card
 * asks the one rule itself, on its own ticking clock, from these two facts, which no clock can change.
 */
export type OnClock = {
  entryId: string;
  jobId: string | null;
  /** A time code with no job (Drive, Shop) is a PLACE too: switch_job cuts it like a job. */
  jobCode: string | null;
  label: string;
  /** The punch's own clock-in, ISO — what the age is measured from. */
  clockIn: string;
  /** The same instant in the org's words, for the sentence. */
  since: string;
};

type VisitRow = {
  id: string;
  title: string | null;
  status: string | null;
  job_id: string | null;
  starts_at: string | null;
  ends_at?: string | null;
  customer_id: string | null;
  inquiry_id: string | null;
  customers: { name: string | null } | { name: string | null }[] | null;
  inquiries: { name: string | null } | { name: string | null }[] | null;
};

const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

async function readVisit(supabase: SupabaseClient, id: string): Promise<VisitRow | null> {
  const { data } = await supabase
    .from("appointments")
    .select("id, title, status, job_id, starts_at, ends_at, customer_id, inquiry_id, customers(name), inquiries(name)")
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

/** The running clock in the card's shape, its label and `since` in the caller's language. */
function onClockOf(o: OpenRow, tz: string, lang: Lang, words: Words): OnClock {
  return {
    entryId: o.id,
    jobId: o.job_id,
    jobCode: (o.job_code ?? "").trim() || null,
    label: openLabel(o, lang, words),
    clockIn: o.clock_in,
    since: clockWords(o.clock_in, tz, lang),
  };
}

/** "J-050", or the time code a job-less clock runs on ("Shop"), or "no job" (vp_noJob, the page's own word). */
function openLabel(o: OpenRow, lang: Lang, words: Words): string {
  const j = one(o.job);
  if (j) return jobShort(j, lang, words);
  return (o.job_code ?? "").trim() || say(lang, words, "vp_noJob", "no job");
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
    // No staff client came back: the refusal is said in the member's own language, read once.
    return { ok: false, error: await wordsOf(await createClient()).say("vp_onlyOfficeStartsJob") };
  }
  const supabase = ctx.supabase as unknown as SupabaseClient;
  const ws = wordsOf(ctx.supabase, ctx.userId);

  const visit = await readVisit(supabase, input.appointmentId);
  if (!visit) return { ok: false, error: await ws.say("vp_visitNotFound") };
  if (visit.status === "cancelled") return { ok: false, error: await ws.say("vp_visitCancelledNothingStarted") };

  // The language once, for the pure rules this file shares with the page (visit-start) and for the
  // sentences built from their pieces.
  const lang = await ws.lang();
  const words = translator(lang);
  const tz = await orgTz(supabase);
  const startAt = input.clock === "in" ? (input.startAt ?? null) : null;
  if (input.clock === "in") {
    const problem = startedAtProblem(startAt, Date.now(), tz, lang, words);
    if (problem) return { ok: false, error: `${problem} ${await ws.say("vp_nothingWasStarted")}` };
  }

  // Who is on the clock, read BEFORE anything is made, so a refusal leaves no job behind.
  let running: OpenRow | null = null;
  if (input.clock !== "none") {
    running = await openEntryOf(supabase, ctx.userId);
    if (input.clock === "in" && running && !(visit.job_id && running.job_id === visit.job_id)) {
      const oc = onClockOf(running, tz, lang, words);
      return {
        ok: false,
        onClock: oc,
        error: await ws.say("vp_onClockSwitchHere", { label: oc.label, since: oc.since }),
      };
    }
    /* THE RIGHT SHIFT IS NEVER CUT FOR A DUPLICATE (review, Tom Goodman as it stood): Erik on the
       clock on J-055, the job he made by hand for this very customer that afternoon, and the visit
       still unlinked. A switch here would mint J-056 and cut his J-055 shift onto it. The card leads
       with Link To J-055 in that case; this is the same answer for a stale page. */
    if (input.clock === "switch" && running?.job_id && !visit.job_id) {
      const pick = await loadLinkInstead(supabase, visit, tz);
      if (pick && pick.id === running.job_id) {
        const j = jobShort(pick, lang, words);
        return {
          ok: false,
          error: await ws.say("vp_onClockLinkInstead", { job: j, customer: visitWho(visit) ?? (await ws.say("vp_thisCustomerLower")) }),
        };
      }
    }
  }

  /* A START IN THE PAST MAY NOT LAND ON HOURS ALREADY RECORDED (review, 2026-09-25). The open row
     clockIn inserts passes 0278/0291 (they judge a finished shift), so the clash only surfaced at
     clock-out tonight, as a shift nobody could close. Asked here, before anything is made, with the
     Timecards' own test and words. Only a fresh clock-in has a start to judge: a switch cuts at now. */
  if (input.clock === "in" && startAt && !running) {
    // The clock-in's own words (clockInClashWords, the Timeclock's): start after that shift, or fix
    // it. The Add Entry sentence ("Put that shift on the job") was for a door this card has not got,
    // and the job it would go on does not exist yet.
    const overlap = await findOverlap(supabase, ctx.userId, Date.parse(startAt), Date.now(), { tz });
    if (overlap) {
      // The clash itself is the Timecards' own sentence (lib/overlap-refusal), said in the caller's language — this
      // file has `lang` and its translator in hand, so it hands them over; what this tap did not do is this file's.
      const nothing = await ws.say("vp_nothingWasStarted");
      return {
        ok: false,
        error: overlap.clash
          ? clockInClashWords({ clash: overlap.clash, startIso: startAt, tz, isStaff: true, nothing }, lang, words)
          : `${overlap.sentence} ${nothing}`,
      };
    }
  }

  const made = await createJobFromAppointment(visit.id);
  if (!made.ok || !made.id) return { ok: false, error: made.error ?? (await ws.say("vp_jobCouldNotBeStarted")) };
  const jobId = made.id;
  // `already`: another device made this visit's job a moment ago, and made.id is THAT job.
  const existing = !!visit.job_id || !!made.already;

  const { data: jobRow } = await supabase.from("jobs").select("id, job_number, name").eq("id", jobId).maybeSingle();
  if (!jobRow) return { ok: false, error: await ws.say("vp_jobMadeNotReadBack") };
  const jobNumber = jobShort(jobRow as { job_number?: string | null; name?: string | null }, lang, words);
  const customer = visitWho(visit);
  const warnings: string[] = [];
  if (made.note) warnings.push(made.note);

  let clock: StartedClock | null = null;
  let undoEntryId: string | undefined;

  if (input.clock === "switch" && running && running.job_id !== jobId) {
    const at = new Date().toISOString();
    const from = openLabel(running, lang, words);
    const sw = await switchJob({ entry_id: running.id, job_id: jobId, job_code: null, gps: input.gps ?? null });
    if (!sw.ok) {
      warnings.push(await ws.say("vp_clockStillOn", { from, why: sw.error ?? (await ws.say("vp_switchDidntGoThrough")) }));
    } else {
      // A job-less clock — or one still inside the young-punch window (switch-window) — is RE-POINTED
      // whole, not cut: the time since its clock-in is now on this job, and the sentence has to say
      // that rather than "switched at 3:32 PM". Read off the mode switchJob answers with, never
      // guessed from the clock here.
      clock = sw.mode === "repointed" ? { kind: "move", since: running.clock_in } : { kind: "switch", at, from };
      if (sw.warning) warnings.push(sw.warning);
    }
  } else if (input.clock === "in" || input.clock === "switch") {
    // "switch" with nothing running (the clock stopped since the sheet opened) is a plain clock-in at now.
    if (running && running.job_id === jobId) {
      clock = null; // already on this very job: nothing to do, and the sentence below says so
      warnings.push(await ws.say("vp_alreadyOnClockOn", { job: jobNumber }));
    } else {
      const res = await clockIn({ job_id: jobId, job_code: null, gps: input.gps ?? null, clock_in_at: startAt });
      if (!res.ok) {
        warnings.push(await ws.say("vp_clockInDidntGoThrough", { why: res.error ?? (await ws.say("vp_tryAgainFromJobPage")) }));
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
    message: startedWords({ jobNumber, customer, tz, clock, existing }, lang, words),
    ...(warnings.length ? { warning: warnings.join(" ") } : {}),
    ...(undoEntryId ? { undoEntryId } : {}),
  };
}

/**
 * "Link to J-055 Instead": the visit gets the job somebody already made for this customer today,
 * rather than a second one. Re-asks the same rule the page offered it from, so a stale page cannot
 * link a job the rule no longer names; Edit Details still links any job by hand.
 */
export async function linkVisitInstead(appointmentId: string, jobId: string): Promise<StartJobResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: await wordsOf(await createClient()).say("vp_onlyOfficeLinksVisit") };
  const supabase = ctx.supabase as unknown as SupabaseClient;
  const ws = wordsOf(ctx.supabase, ctx.userId);

  const visit = await readVisit(supabase, appointmentId);
  if (!visit) return { ok: false, error: await ws.say("vp_visitNotFound") };
  if (visit.job_id) {
    if (visit.job_id === jobId) return { ok: true, jobId, message: await ws.say("vp_alreadyLinkedToThatJob") };
    return { ok: false, error: await ws.say("vp_alreadyLinkedToAnotherJob") };
  }

  const tz = await orgTz(supabase);
  const pick = await loadLinkInstead(supabase, visit, tz);
  if (!pick || pick.id !== jobId) {
    return { ok: false, error: await ws.say("vp_jobNoLongerOffered") };
  }

  const res = await linkAppointmentTo(appointmentId, "job", jobId);
  if (!res.ok) return { ok: false, error: res.error ?? (await ws.say("vp_visitCouldNotBeLinked")) };

  /* STAMP FOLLOWS DEED, the lead too (review, 2026-09-25) — done INSIDE the one attach door now
     (linkAppointmentTo → lib/appointments/lead-won, cn-v1069), so the visit's own Connect picker and
     this button cannot disagree about what attaching a job means. Its sentence rides back as the
     warning. */
  const warnings: string[] = [];
  if (res.warning) warnings.push(res.warning);

  const lang = await ws.lang();
  const jobNumber = jobShort(pick, lang, translator(lang));
  const running = await openEntryOf(supabase, ctx.userId);
  const onIt = running?.job_id === jobId ? ` ${await ws.say("vp_clockAlreadyRunningOn", { job: jobNumber })}` : "";
  revalidatePath(`/jobs/${jobId}`);
  revalidatePath("/planner");
  return {
    ok: true,
    jobId,
    jobNumber,
    // The attach door says what the visit's work did on the job (cn-v1134: "2 tasks and 1 part joined
    // J-055 …", "J-055 already had …"); only a door with nothing to say leaves the old sentence.
    message: await ws.say("vp_linkedThisVisitTo", { job: jobNumber, note: res.note ?? (await ws.say("vp_nothingNewWasMade")), onIt }),
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
  if (!user) return { ok: false, error: await wordsOf(supabase).say("vp_notSignedIn") };
  const ws = wordsOf(supabase, user.id);
  const { data: me } = await supabase.from("profiles").select("full_name, org_id, active").eq("id", user.id).maybeSingle();
  const prof = me as { full_name?: string | null; org_id?: string | null; active?: boolean | null } | null;
  if (!prof?.org_id || prof.active === false) return { ok: false, error: await ws.say("vp_accountCantSendThat") };

  const visit = await readVisit(supabase as unknown as SupabaseClient, appointmentId);
  if (!visit) return { ok: false, error: await ws.say("vp_visitNotFound") };
  if (visit.job_id) return { ok: false, error: await ws.say("vp_visitAlreadyHasJobReload") };

  const recipients = await officeRecipients(supabase, user.id);
  if (!recipients.length) {
    return { ok: false, error: await ws.say("vp_nobodyInOfficeGetsMessages") };
  }
  // The office reads English today (sh_spanishCovers: the office pages' contents stay in English for now);
  // its bell's words come from the same catalog so this file keeps no literal, and the day the office
  // reads Spanish this one line becomes the reader's language (the long-shift route's own rule).
  const office_t = translator("en");
  const first = (prof.full_name ?? "").trim().split(/\s+/)[0] || office_t("cs_aCrewMember");
  const who = visitWho(visit);
  const place = visit.title?.trim() || office_t("vp_aVisitLower");
  // A visit that is over (audit v1018): he is not "at" it, so the bell says what is true.
  const over = visitIsOver(visit, await orgTz(supabase as unknown as SupabaseClient));
  const rang = await ringOffice(prof.org_id, recipients, {
    type: "visit_needs_job",
    title: fillSlots(office_t("vp_bellNeedsJobStarted"), { first, forWho: who ? ` ${fillSlots(office_t("vp_forCustomer"), { customer: who })}` : "" }),
    body: fillSlots(office_t(over ? "vp_bellVisitOverBody" : "vp_bellAtVisitBody"), { first, place }),
    url: `/appointments/${visit.id}`,
    windowMinutes: 15,
    mode: "once_per_window",
  });
  if (rang === "failed" || rang === "nobody") {
    return { ok: false, error: await ws.say("vp_didntReachOffice") };
  }
  return {
    ok: true,
    message: await ws.say(over ? "vp_officeAskedToStartJob" : "vp_officeAskedClockInHere"),
  };
}
