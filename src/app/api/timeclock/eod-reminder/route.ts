import { NextResponse } from "next/server";
import { requireCron } from "@/lib/cron-guard";
import { sendSms, smsReadiness } from "@/lib/sms";
import { getOrgSettings } from "@/lib/org-settings";
import { sendCloseOutNudges } from "@/lib/action-items/eod-sweep";
import { todayBoundsInTz } from "@/lib/tz";
import { reportError } from "@/lib/observe";
import { reportBlockerAwaited } from "@/lib/observe-blocker";
import { withoutHeldCrumb } from "@/lib/held-crumb";
import { EOD_LOCAL_HOUR, atLocalHour, readAllOrgs } from "@/lib/cron-orgs";

// Every company in one run, one after another: the budget every cron carries now (cn-v1130).
export const maxDuration = 300;

type Org = { id: string; name: string | null; settings: unknown };

/**
 * End-of-day "fill out your form" reminder — HOURLY (vercel.json "0 * * * *", cn-v1130). Each
 * company is handled on the run that falls in ITS 6 PM (atLocalHour on the org's timezone setting),
 * every day; every other run counts it in `not_due_yet`. It used to run at 01:00 UTC, an hour tuned
 * to Pacific summer: on the Sunday DST ends (2026-11-01) the reminder would have moved to 5 PM, and
 * a company in any other zone never had its own evening at all.
 *
 * For each company due (the service client bypasses RLS, so every query MUST be org-scoped), texts
 * active techs who, for today, either:
 *   • are still clocked in (open entry) — remind them to clock out, or
 *   • clocked out but left no notes and no job breakdown — fill out the EOD form.
 * Per-org opt-out via settings.remind_timeclock === false (default on). An org that cannot text
 * yet (lib/sms-readiness) is skipped and counted in `not_ready`; the night debrief push below still
 * goes to it, since that never needed texting: it is handed every company at its 6 PM, before the
 * opt-out and readiness checks.
 *
 * NOTHING FAILS SILENTLY (the 2026-10-26 deep review, ops layer). The company list is whole or the
 * run is a 500 that is filed (readAllOrgs pages past PostgREST's silent 1,000-row cap and throws on
 * a failed read; one bare select made a failed read an empty run). Inside a company the techs read
 * and the entries read each throw on error: the failure is counted, filed with the orgId, and texts
 * NOBODY — `const { data }` with no error check read a failed read as "nothing to say".
 *
 *   GET /api/timeclock/eod-reminder   Authorization: Bearer <CRON_SECRET>
 */
export async function GET(request: Request) {
  const guard = requireCron(request);
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const counts = { checked: 0, reminded: 0, not_ready: 0, due: 0, not_due_yet: 0, failed: 0 };
  // One clock for the whole run, taken BEFORE the company read: a company late in the list (or a
  // slow read) is judged on the hour the run began, never on the one it happened to reach.
  const nowMs = Date.now();
  let orgs: Org[];
  try {
    orgs = await readAllOrgs<Org>(supabase, "id, name, settings");
  } catch (e) {
    // Waited for (cn-v1130, skeptic #34): this function answers on the tick it files, and a
    // fire-and-forget write can freeze with it. A BLOCKER (cn-v1136): no company was reached, so
    // the first such night pages North's own team.
    await reportBlockerAwaited("cron-eod", e);
    return NextResponse.json({ ...counts, failed: 1 }, { status: 500 });
  }
  // The companies whose own 6 PM this run is. The texts and the night debrief both ride this list.
  // A loop, not a filter (cn-v1130, skeptic #34): a timezone Intl cannot read throws in atLocalHour,
  // and that must cost ONE company its evening — counted, filed with the company — never the rest.
  const dueOrgs: Org[] = [];
  for (const org of orgs) {
    try {
      if (atLocalHour(getOrgSettings(org.settings).timezone, EOD_LOCAL_HOUR, nowMs)) dueOrgs.push(org);
      else counts.not_due_yet++;
    } catch (e) {
      counts.failed++;
      reportError("cron-eod", e, { orgId: org.id });
    }
  }
  counts.due = dueOrgs.length;

  for (const org of dueOrgs) {
    if (!getOrgSettings(org.settings).remind_timeclock) continue; // per-org opt-out (Settings → Scheduling)
    // TEXTING NOT SET UP (lib/sms-readiness): the org's choice is kept, nothing is sent, and the
    // skip is counted. Settings shows this option as not active and lists what is missing, so
    // the person who ticked it reads the truth there rather than in a cron reply nobody opens.
    if (!smsReadiness(org).ready) {
      counts.not_ready++;
      continue;
    }
    try {
      // "Today" is the org's LOCAL day, not the (UTC-on-Vercel) server day, so a
      // Pacific evening shift counts toward today rather than tomorrow.
      const { dayStart } = todayBoundsInTz(getOrgSettings(org.settings).timezone);
      const [techsR, entriesR] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, full_name, phone")
          .eq("org_id", org.id)
          .eq("active", true)
          .eq("role", "tech"),
        supabase
          .from("time_entries")
          .select("profile_id, status, notes")
          .eq("org_id", org.id)
          // TODAY'S ROWS **OR** ANYTHING STILL OPEN (audit v921). Filtering on clock_in alone meant
          // a punch left open from yesterday was reminded once, on Monday evening, and never again:
          // Tuesday's fetch didn't return it, the tech's list came back empty and the loop skipped
          // him, while the hours kept accruing. 0193 only closes a stale entry on that person's NEXT
          // punch — if he never punches again, nothing else catches it. Still org-scoped: the
          // service client bypasses RLS, so the org filter stays outside the or().
          .or(`clock_in.gte.${dayStart.toISOString()},status.eq.open`),
      ]);
      if (techsR.error) throw techsR.error;
      if (entriesR.error) throw entriesR.error; // a failed read is not "nothing to say": it texts nobody
      const techs = techsR.data;
      const entries = entriesR.data;
      if (!techs?.length) continue;

      const byTech = new Map<string, any[]>();
      for (const e of entries ?? []) {
        const list = byTech.get(e.profile_id) ?? [];
        list.push(e);
        byTech.set(e.profile_id, list);
      }

      counts.checked += techs.length;
      for (const t of techs) {
        const todays = byTech.get(t.id) ?? [];
        if (todays.length === 0) continue; // never clocked in — handled by /nudge

        const stillOpen = todays.some((e) => e.status === "open");
        const anyDocumented = todays.some((e) => withoutHeldCrumb(e.notes)); // the clock's own take-back line is not a note

        let message = "";
        if (stillOpen) {
          message = `Hi ${t.full_name ?? ""} — you're still clocked in. Please clock out and fill out your end-of-day form in Contractor North.`;
        } else if (!anyDocumented) {
          message = `Hi ${t.full_name ?? ""} — please fill out your end-of-day form (what you worked on today) in Contractor North.`;
        } else {
          continue; // done for the day
        }

        const sent = await sendSms(t.phone, message, (org.settings as any)?.sms_from_number);
        if (sent) counts.reminded++;
      }
    } catch (e) {
      // Counted and filed with the company, never a quiet skip; the next company still gets its evening.
      counts.failed++;
      reportError("cron-eod", e, { orgId: org.id });
    }
  }

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
