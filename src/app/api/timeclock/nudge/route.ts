import { NextResponse } from "next/server";
import { requireCron } from "@/lib/cron-guard";
import { sendSms, smsReadiness } from "@/lib/sms";
import { clockInRemindersOn, getOrgSettings, timeclockRemindersPush, timeclockRemindersText, workDayWindowHm } from "@/lib/org-settings";
import { notifyPeople } from "@/lib/notifications";
import { todayStrInTz, tzDayStartUtc } from "@/lib/tz";
import { reportError } from "@/lib/observe";
import { reportBlockerAwaited } from "@/lib/observe-blocker";
import { readActiveOrgs } from "@/lib/cron-orgs";
import { readCrewDay } from "@/lib/schedule/crew-day";
import { clockInSlotMs, clockSince, dueToClockIn } from "@/lib/timeclock-reminders";
import { asLang, fillText, translator } from "@/lib/i18n";

// Every company in one run, one after another: the budget every cron carries now (cn-v1130).
export const maxDuration = 300;

type Org = { id: string; name: string | null; settings: unknown };

/**
 * THE CLOCK-IN REMINDER — EVERY 15 MINUTES (vercel.json: every fifteen minutes, cn-v1192). It used to text
 * every active tech at the company's 7 AM on weekdays, scheduled or not; no company could text, so
 * nobody got it. The owner: "a morning push should be optional in settings like the other
 * notifications". Now the SCHEDULE says who works and when (a Saturday job reminds its crew; a
 * weekday with nothing scheduled reminds nobody), and ONE rule (lib/timeclock-reminders dueToClockIn)
 * decides who is reminded on this run, for both channels:
 *   · the person is active and SCHEDULED on the company's today, by the Schedule's own rules
 *     (lib/schedule/crew-day: the day row decides, an 'off' row is never reminded; else the in-flight
 *     jobs on today whose crew holds them; plus the visits on their name);
 *   · they have no punch with a clock-in on the company's today (any status), and no punch still
 *     open from any day (someone on the clock since yesterday is the 12-hour question's, never told
 *     "you haven't clocked in");
 *   · their FIRST start today is 15 to 30 minutes before this run's quarter hour (one run per start).
 * The PUSH (Push or Both, Settings → Scheduling): one "Time to Clock In" per person through
 * notifyPeople under kind clock_in, any role, naming their own start. The TEXT (Text or Both, texting
 * ready): the same people who are techs, nb_nudgeMorning.
 *
 * THE COMPANY'S SWITCH (cn-v1193). The owner: "the clock in reminder setting should be controlled by
 * the boss not the employee", and, of the reminder, "Start off". Clock-In Reminders on the Scheduling
 * card (org-settings clockInRemindersOn, off until ticked) governs BOTH channels: a company with it off
 * is passed over before anything of it is read, counted in `off`. With it on, everyone due is reminded,
 * any role; nobody can mute it for themselves (lib/push COMPANY_DECIDED), and the bell line is written
 * for every due person.
 *
 * CHEAP WHEN IDLE: the route looks at every company on every run, so the schedule is read first and
 * a company with the switch off stops before that (`off`), and one with no start due in this run's quarter hour
 * stops there (`not_due_yet`); people and punches are read
 * only for a company with someone due (`due`).
 *
 * NOTHING FAILS SILENTLY. The company list is whole or the run is a 500 that is filed. Inside a
 * company a failed read (the schedule, the people, the punches) reminds NOBODY there, is counted in
 * `failed` and filed with the company. A refusal from notifyPeople (no bell line) is counted in
 * `push_failed` and filed. A company whose plan has ended is passed over (readActiveOrgs) and
 * counted in `lapsed_skipped`. No stamp: each start has exactly one run.
 *
 *   GET /api/timeclock/nudge   Authorization: Bearer <CRON_SECRET>
 */
export async function GET(request: Request) {
  const guard = requireCron(request);
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const counts = { off: 0, checked: 0, texted: 0, pushed: 0, push_failed: 0, not_ready: 0, due: 0, not_due_yet: 0, lapsed_skipped: 0, failed: 0 };
  // One clock for the whole run, taken BEFORE the company read: a company late in the list (or a
  // slow read) is judged on the run's own slot, never on the minute it happened to reach.
  const nowMs = Date.now();
  const slotMs = clockInSlotMs(nowMs);
  let orgs: Org[];
  try {
    const active = await readActiveOrgs<Org>(supabase, "id, name, settings", nowMs);
    orgs = active.rows;
    counts.lapsed_skipped = active.lapsedSkipped;
  } catch (e) {
    // Waited for (cn-v1130, skeptic #34): this function answers on the tick it files, and a
    // fire-and-forget write can freeze with it. A BLOCKER (cn-v1136): no company was reached, so
    // the first such night pages North's own team.
    await reportBlockerAwaited("cron-nudge", e);
    return NextResponse.json({ ...counts, failed: 1 }, { status: 500 });
  }

  for (const org of orgs) {
    // The whole company is inside the try (cn-v1130, skeptic #34): a timezone Intl cannot read
    // throws, and that must cost one company its reminder, never the rest of the list theirs.
    try {
      // THE COMPANY'S SWITCH FIRST (cn-v1193): off, nothing of the company is read and nobody is reminded.
      if (!clockInRemindersOn(org.settings)) {
        counts.off++;
        continue;
      }
      const tz = getOrgSettings(org.settings).timezone;
      const push = timeclockRemindersPush(org.settings);
      const text = timeclockRemindersText(org.settings);
      // THE SCHEDULE FIRST: who starts in this run's hour. Throws on a failed read.
      const day = todayStrInTz(tz, new Date(nowMs));
      const crew = await readCrewDay(supabase, { orgId: org.id, tz, workDay: workDayWindowHm(org.settings), day });
      const starts = new Map<string, number>();
      for (const [pid, v] of crew.people) if (!v.off && v.firstStartMs != null) starts.set(pid, v.firstStartMs);
      const scheduled = dueToClockIn(starts, slotMs);
      if (!scheduled.length) {
        counts.not_due_yet++;
        continue;
      }
      counts.due++;

      // The people and today's punches, read whole before anyone is reminded: a failed read reminds nobody.
      const ids = scheduled.map((d) => d.profileId);
      // The day's start from the SAME day the schedule was read for (the run's one clock), never the wall clock.
      const dayStart = tzDayStartUtc(day, tz);
      const [peopleR, punchesR] = await Promise.all([
        // `language` rides the one people read (cn-v1138): each reminder speaks the person's own language.
        supabase.from("profiles").select("id, full_name, phone, language, role").eq("org_id", org.id).eq("active", true).in("id", ids),
        // Clocked in today (any status), OR still open from any day. The company stays outside the or().
        supabase
          .from("time_entries")
          .select("profile_id")
          .eq("org_id", org.id)
          .in("profile_id", ids)
          .or(`clock_in.gte.${dayStart.toISOString()},status.eq.open`),
      ]);
      if (peopleR.error) throw peopleR.error;
      if (punchesR.error) throw punchesR.error; // a failed read is not "nobody clocked in": it reminds nobody
      const clockedIn = new Set((punchesR.data ?? []).map((e: { profile_id: string }) => e.profile_id));
      const people = new Map(((peopleR.data ?? []) as { id: string; full_name: string | null; phone: string | null; language: string | null; role: string | null }[]).map((p) => [p.id, p]));
      const due = scheduled.filter((d) => people.has(d.profileId) && !clockedIn.has(d.profileId));
      counts.checked += due.length;

      if (push) {
        for (const d of due) {
          const res = await notifyPeople(org.id, [d.profileId], "clock_in", (lang) => {
            const t = translator(lang);
            return {
              title: t("nb_clockInPushTitle"),
              body: fillText(t("nb_clockInPushBody"), { time: clockSince(d.startMs, tz, lang) }),
              url: "/timeclock",
            };
          });
          counts.pushed += res.pushed.length;
          if (!res.bell) {
            counts.push_failed++;
            reportError("cron-nudge", new Error("The clock-in push was refused: no bell line was written."), { orgId: org.id, step: "push" });
          }
        }
      }

      if (!text) continue; // the company sends these by Push only (Settings → Scheduling, cn-v1190)
      const techs = due.filter((d) => people.get(d.profileId)?.role === "tech");
      if (!techs.length) continue;
      // TEXTING NOT SET UP (lib/sms-readiness): the org's choice is kept, nothing is sent, and the
      // skip is counted. Settings shows this option as not active and lists what is missing.
      if (!smsReadiness(org).ready) {
        counts.not_ready++;
        continue;
      }
      for (const d of techs) {
        const tech = people.get(d.profileId)!;
        const lang = asLang(tech.language);
        const t = translator(lang);
        const message = fillText(t("nb_nudgeMorning"), { name: tech.full_name ?? "", time: clockSince(d.startMs, tz, lang) });
        const sent = await sendSms(tech.phone, message, (org.settings as any)?.sms_from_number);
        if (sent) counts.texted++;
      }
    } catch (e) {
      // Counted and filed with the company, never a quiet skip; the next company still gets its reminder.
      counts.failed++;
      reportError("cron-nudge", e, { orgId: org.id });
    }
  }

  return NextResponse.json(counts);
}
