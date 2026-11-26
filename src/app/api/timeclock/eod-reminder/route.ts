import { NextResponse } from "next/server";
import { requireCron } from "@/lib/cron-guard";
import { sendSms, smsReadiness } from "@/lib/sms";
import { getOrgSettings, timeclockRemindersPush, timeclockRemindersText, workDayWindowHm } from "@/lib/org-settings";
import { sendCloseOutNudges } from "@/lib/action-items/eod-sweep";
import { notifyPeople } from "@/lib/notifications";
import { loadShiftChains } from "@/lib/shift-chain";
import { todayBoundsInTz, tzMinutesOfDay } from "@/lib/tz";
import { reportError } from "@/lib/observe";
import { reportBlockerAwaited } from "@/lib/observe-blocker";
import { EOD_LOCAL_HOUR, atLocalHour, readActiveOrgs } from "@/lib/cron-orgs";
import { readCrewDay } from "@/lib/schedule/crew-day";
import { LAST_CLOCK_OUT_HOUR, clockSince, dueToClockOut, shiftsInPlay, type OpenShift } from "@/lib/timeclock-reminders";
import { asLang, fillText, translator } from "@/lib/i18n";

// Every company in one run, one after another: the budget every cron carries now (cn-v1130).
export const maxDuration = 300;

type Org = { id: string; name: string | null; settings: unknown };

/**
 * THE CLOCK-OUT REMINDER — HOURLY (vercel.json "0 * * * *", cn-v1130). Each company is looked at on
 * the runs from ITS 6 PM through ITS 11 PM (company time, atLocalHour / tzMinutesOfDay on the org's
 * timezone setting); every other run counts it in `not_due_yet`. The 6 PM run counts it in `due`, the
 * runs after it in `late_checked`. The night debrief (sendCloseOutNudges) rides the 6 PM run only.
 *
 * PRECISE (cn-v1192, the owner: "the 6pm push should only be necessary if someone is clocked in or
 * scheduled correct? it should be precise dont you think?"). ONE rule (lib/timeclock-reminders
 * dueToClockOut) decides who is reminded on this run, and both channels read it:
 *   · the person is active, and their shift (by loadShiftChains: a Switch Job does not reset it) is
 *     still open and began on the company's today;
 *   · the shift is at least an hour old (a shift younger than that gets no reminder that evening; the
 *     12-hour question is still the backstop);
 *   · the 12-hour question has not asked about it;
 *   · and this run is THEIR due hour: 6 PM, or, when the job they are clocked into right now is on
 *     today's schedule (lib/schedule/crew-day, the Schedule's own rule) and its hours end later, the
 *     first whole hour at or after that end. Hours that end after 11 PM get no reminder: the run after
 *     them is tomorrow. Nobody is reminded twice: each person has one due hour.
 * The PUSH (Push or Both, Settings → Scheduling): one "Still Clocked In" per person through
 * notifyPeople under kind clock_out, any role, the bell line first, in the person's own language and
 * under their own Clock-out Reminders switch; it opens the Time Clock. The TEXT (Text or Both, and
 * texting ready, lib/sms-readiness): the same people who are techs, nb_eodStillIn. A company that
 * cannot text yet is counted in `not_ready`. The old "fill out your end-of-day form" text is gone: it
 * named nothing a person could do (both clock-out sheets open only at the clock-out itself).
 *
 * NOTHING FAILS SILENTLY. The company list is whole or the run is a 500 that is filed. Inside a
 * company a failed read (the open shifts, their families, the schedule, the techs for the text) is
 * counted in `failed`, filed with the company, and reminds NOBODY on that channel: it is never read
 * as "nobody is on the clock" or "no hours". A refusal from notifyPeople (no bell line) is counted
 * in `push_failed` and filed. `pushed` counts the people pushed (one who muted clock-out pushes still
 * gets the bell line and is not counted). A company whose plan has ended is passed over
 * (readActiveOrgs) and counted in `lapsed_skipped`.
 *
 *   GET /api/timeclock/eod-reminder   Authorization: Bearer <CRON_SECRET>
 */
export async function GET(request: Request) {
  const guard = requireCron(request);
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const counts = { checked: 0, reminded: 0, not_ready: 0, due: 0, late_checked: 0, not_due_yet: 0, lapsed_skipped: 0, failed: 0, pushed: 0, push_failed: 0 };
  // One clock for the whole run, taken BEFORE the company read: a company late in the list (or a
  // slow read) is judged on the hour the run began, never on the one it happened to reach.
  const nowMs = Date.now();
  let orgs: Org[];
  try {
    const active = await readActiveOrgs<Org>(supabase, "id, name, settings", nowMs);
    orgs = active.rows;
    counts.lapsed_skipped = active.lapsedSkipped;
  } catch (e) {
    // Waited for (cn-v1130, skeptic #34): this function answers on the tick it files, and a
    // fire-and-forget write can freeze with it. A BLOCKER (cn-v1136): no company was reached, so
    // the first such night pages North's own team.
    await reportBlockerAwaited("cron-eod", e);
    return NextResponse.json({ ...counts, failed: 1 }, { status: 500 });
  }
  // The companies whose own 6 PM this run is (the reminder AND the night debrief), and those between
  // 7 PM and 11 PM (the reminder only, for a job whose hours end later). A loop, not a filter
  // (cn-v1130, skeptic #34): a timezone Intl cannot read throws, and that must cost ONE company its
  // evening — counted, filed with the company — never the rest.
  const dueOrgs: Org[] = [];
  const looked: { org: Org; hour: number }[] = [];
  for (const org of orgs) {
    try {
      const tz = getOrgSettings(org.settings).timezone;
      if (atLocalHour(tz, EOD_LOCAL_HOUR, nowMs)) {
        dueOrgs.push(org);
        looked.push({ org, hour: EOD_LOCAL_HOUR });
        continue;
      }
      const hour = Math.floor(tzMinutesOfDay(new Date(nowMs), tz) / 60);
      if (hour > EOD_LOCAL_HOUR && hour <= LAST_CLOCK_OUT_HOUR) {
        counts.late_checked++;
        looked.push({ org, hour });
      } else counts.not_due_yet++;
    } catch (e) {
      counts.failed++;
      reportError("cron-eod", e, { orgId: org.id });
    }
  }
  counts.due = dueOrgs.length;

  for (const { org, hour } of looked) await remindStillClockedIn(supabase, org, hour, nowMs, counts);

  // NIGHT DEBRIEF NUDGE (Erik: "i want a night debrief") — the "Close out your day" push rides
  // this run for the companies at their own 6 PM (dueOrgs, cn-v1130): staff get the day's money
  // leaks + a deep link to /planner?debrief=1, which opens Nort's debrief interview.
  let close_out: unknown = null;
  try {
    close_out = await sendCloseOutNudges(supabase, dueOrgs);
  } catch (e) {
    // "failed" in a cron JSON nobody reads is a silent failure (audit v921). Every sub-step of
    // the morning cron reports; this one didn't, so the night debrief could stop going out for
    // weeks with nothing in error_events to say so.
    close_out = "failed";
    counts.failed++; // the run's own count says it too (cn-v1130, skeptic #34), not only the word
    reportError("cron-close-out", e);
  }

  return NextResponse.json({ ...counts, close_out });
}

type ShiftRow = {
  id: string;
  profile_id: string;
  job_id: string | null;
  clock_in: string;
  split_from: string | null;
  long_shift_nudged_at: string | null;
  profiles?: { active?: boolean | null } | { active?: boolean | null }[] | null;
};

type Counts = { checked: number; reminded: number; not_ready: number; failed: number; pushed: number; push_failed: number };

/**
 * THE CLOCK-OUT REMINDER for one company on one run (cn-v1192): the people due at THIS hour, by the
 * one rule, pushed (Push or Both) and, the techs among them, texted (Text or Both, texting ready).
 * Every read names the company (the service client bypasses RLS).
 */
async function remindStillClockedIn(supabase: Parameters<typeof loadShiftChains>[0], org: Org, runHour: number, nowMs: number, counts: Counts): Promise<void> {
  const push = timeclockRemindersPush(org.settings);
  const text = timeclockRemindersText(org.settings);
  // TEXTING NOT SET UP (lib/sms-readiness): the org's choice is kept, nothing is texted, and the skip
  // is counted. Settings shows the option as not active and lists what is missing.
  const textReady = text && smsReadiness(org).ready;
  if (text && !textReady) counts.not_ready++;
  if (!push && !textReady) return;

  const settings = getOrgSettings(org.settings);
  const tz = settings.timezone;
  let due: { profileId: string; startMs: number }[];
  try {
    const { dayStart, todayStr } = todayBoundsInTz(tz);
    const { data, error } = await supabase
      .from("time_entries")
      .select("id, profile_id, job_id, clock_in, split_from, long_shift_nudged_at, profiles:profile_id(active)")
      .eq("org_id", org.id)
      .eq("status", "open");
    if (error) throw error;
    const rows = (data ?? []) as unknown as ShiftRow[];
    // The shift's start, and whether the 12-hour question went out on any piece of it. Throws on a failed read.
    const chains = await loadShiftChains(supabase, rows, org.id);
    const shifts: OpenShift[] = [];
    for (const r of rows) {
      const info = chains.get(String(r.id));
      if (!info) continue;
      const person = Array.isArray(r.profiles) ? (r.profiles[0] ?? null) : (r.profiles ?? null);
      shifts.push({
        profileId: r.profile_id,
        clockInMs: Date.parse(r.clock_in),
        startMs: info.startMs,
        jobId: r.job_id ?? null,
        nudged: !!info.nudged,
        active: person?.active === true, // a removed person's phone is never reminded
      });
    }
    const today = shiftsInPlay(shifts, { dayStartMs: dayStart.getTime(), nowMs });
    counts.checked += new Set(today.map((s) => s.profileId)).size;
    // The schedule is read only when someone on the clock is on a job: its hours can move their hour.
    const crew = today.some((s) => s.jobId) ? await readCrewDay(supabase, { orgId: org.id, tz, workDay: workDayWindowHm(org.settings), day: todayStr }) : null;
    due = dueToClockOut({
      shifts: today,
      jobEndMin: (jobId) => crew?.jobs.get(jobId)?.endMin ?? null,
      runHour,
      nowMs,
      dayStartMs: dayStart.getTime(),
    });
  } catch (e) {
    counts.failed++;
    reportError("cron-eod", e, { orgId: org.id, step: "read" });
    return;
  }
  if (!due.length) return;

  if (push) {
    for (const d of due) {
      const res = await notifyPeople(org.id, [d.profileId], "clock_out", (lang) => {
        const t = translator(lang);
        return {
          title: t("nb_eodPushTitle"),
          body: fillText(t("nb_eodPushBody"), { since: clockSince(d.startMs, tz, lang) }),
          url: "/timeclock",
        };
      });
      counts.pushed += res.pushed.length;
      if (!res.bell) {
        counts.push_failed++;
        reportError("cron-eod", new Error("The clock-out push was refused: no bell line was written."), { orgId: org.id, step: "push" });
      }
    }
  }

  if (!textReady) return;
  try {
    // The text's audience: the techs among the people due. `language` rides the one people read (cn-v1138).
    const { data: techs, error } = await supabase
      .from("profiles")
      .select("id, full_name, phone, language")
      .eq("org_id", org.id)
      .eq("active", true)
      .eq("role", "tech")
      .in("id", due.map((d) => d.profileId));
    if (error) throw error;
    for (const tech of techs ?? []) {
      const t = translator(asLang(tech.language));
      const sent = await sendSms(tech.phone, fillText(t("nb_eodStillIn"), { name: tech.full_name ?? "" }), (org.settings as any)?.sms_from_number);
      if (sent) counts.reminded++;
    }
  } catch (e) {
    // Counted and filed with the company, never a quiet skip; the next company still gets its evening.
    counts.failed++;
    reportError("cron-eod", e, { orgId: org.id, step: "text" });
  }
}
