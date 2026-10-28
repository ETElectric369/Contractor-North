import { NextResponse } from "next/server";
import { requireCron } from "@/lib/cron-guard";
import { sendSms, smsReadiness } from "@/lib/sms";
import { getOrgSettings } from "@/lib/org-settings";
import { todayBoundsInTz } from "@/lib/tz";
import { reportError } from "@/lib/observe";
import { reportBlockerAwaited } from "@/lib/observe-blocker";
import { NUDGE_LOCAL_HOUR, atLocalHour, readAllOrgs } from "@/lib/cron-orgs";

// Every company in one run, one after another: the budget every cron carries now (cn-v1130).
export const maxDuration = 300;

type Org = { id: string; name: string | null; settings: unknown };

/**
 * "If no clock-in, send text" — HOURLY (vercel.json "0 * * * *", cn-v1130). Each company is handled
 * on the run that falls in ITS 7 AM on ITS weekdays (atLocalHour on the org's timezone setting);
 * every other run counts it in `not_due_yet`. It used to run at 14:00 UTC Mon–Fri, an hour tuned to
 * Pacific summer: on the Sunday DST ends (2026-11-01) the text would have moved to 6 AM, and a
 * company in any other zone never had its own morning at all.
 *
 * For each company due (the service client bypasses RLS, so every query MUST be org-scoped —
 * otherwise one global pass would text every tenant's techs), finds active techs who have NOT
 * clocked in today and texts them. Per-org opt-out via settings.remind_timeclock === false (default
 * on). An org that cannot text yet (lib/sms-readiness) is skipped and counted in `not_ready`.
 *
 * NOTHING FAILS SILENTLY (the 2026-10-26 deep review, ops layer). The company list is whole or the
 * run is a 500 that is filed (readAllOrgs pages past PostgREST's silent 1,000-row cap and throws on
 * a failed read; one bare select made a failed read an empty run). Inside a company the techs read
 * and the punches read each throw on error: the failure is counted, filed with the orgId, and texts
 * NOBODY. `const { data: clockedIn }` with no error check read a failed punches read as "nobody has
 * clocked in" and texted every active tech "You haven't clocked in yet".
 *
 *   GET /api/timeclock/nudge   Authorization: Bearer <CRON_SECRET>
 */
export async function GET(request: Request) {
  const guard = requireCron(request);
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const counts = { checked: 0, texted: 0, not_ready: 0, due: 0, not_due_yet: 0, failed: 0 };
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
    await reportBlockerAwaited("cron-nudge", e);
    return NextResponse.json({ ...counts, failed: 1 }, { status: 500 });
  }

  for (const org of orgs) {
    // The whole company is inside the try, the hour gate too (cn-v1130, skeptic #34): a timezone
    // Intl cannot read throws in atLocalHour, and that must cost one company its morning, never
    // the rest of the list theirs.
    try {
      const tz = getOrgSettings(org.settings).timezone;
      if (!atLocalHour(tz, NUDGE_LOCAL_HOUR, nowMs, true)) {
        counts.not_due_yet++;
        continue;
      }
      counts.due++;
      if (!getOrgSettings(org.settings).remind_timeclock) continue; // per-org opt-out (Settings → Scheduling)
      // TEXTING NOT SET UP (lib/sms-readiness): the org's choice is kept, nothing is sent, and the
      // skip is counted. Settings shows this option as not active and lists what is missing, so
      // the person who ticked it reads the truth there rather than in a cron reply nobody opens.
      if (!smsReadiness(org).ready) {
        counts.not_ready++;
        continue;
      }
      const { data: techs, error: techErr } = await supabase
        .from("profiles")
        .select("id, full_name, phone")
        .eq("org_id", org.id)
        .eq("active", true)
        .eq("role", "tech");
      if (techErr) throw techErr;
      if (!techs?.length) continue;

      // "Today" is the org's LOCAL day, not the (UTC-on-Vercel) server day, so an
      // early/late clock-in counts against the right calendar day.
      const { dayStart } = todayBoundsInTz(tz);
      const { data: clockedIn, error: punchErr } = await supabase
        .from("time_entries")
        .select("profile_id")
        .eq("org_id", org.id)
        .gte("clock_in", dayStart.toISOString());
      if (punchErr) throw punchErr; // a failed read is not "nobody clocked in": it texts nobody
      const clockedSet = new Set((clockedIn ?? []).map((e: any) => e.profile_id));

      counts.checked += techs.length;
      for (const t of techs.filter((t: any) => !clockedSet.has(t.id))) {
        const sent = await sendSms(
          t.phone,
          `Good morning ${t.full_name ?? ""}! You haven't clocked in yet. Open Contractor North to clock in.`,
          (org.settings as any)?.sms_from_number,
        );
        if (sent) counts.texted++;
      }
    } catch (e) {
      // Counted and filed with the company, never a quiet skip; the next company still gets its morning.
      counts.failed++;
      reportError("cron-nudge", e, { orgId: org.id });
    }
  }

  return NextResponse.json(counts);
}
