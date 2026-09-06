import { NextResponse } from "next/server";
import { requireCron } from "@/lib/cron-guard";
import { sendSms } from "@/lib/sms";
import { getOrgSettings } from "@/lib/org-settings";
import { sendCloseOutNudges } from "@/lib/action-items/eod-sweep";
import { todayBoundsInTz } from "@/lib/tz";
import { reportError } from "@/lib/observe";

/**
 * End-of-day "fill out your form" reminder. Runs on an evening schedule (Vercel
 * Cron). For each org (the service client bypasses RLS, so every query MUST be
 * org-scoped), texts active techs who, for today, either:
 *   • are still clocked in (open entry) — remind them to clock out, or
 *   • clocked out but left no notes and no job breakdown — fill out the EOD form.
 * Re-running only texts those still not done. Per-org opt-out via
 * settings.remind_timeclock === false (default on).
 *
 *   GET /api/timeclock/eod-reminder   Authorization: Bearer <CRON_SECRET>
 */
export async function GET(request: Request) {
  const guard = requireCron(request);
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const { data: orgs } = await supabase.from("organizations").select("id, settings");
  let checked = 0;
  let reminded = 0;

  for (const org of orgs ?? []) {
    if (!getOrgSettings(org.settings).remind_timeclock) continue; // per-org opt-out (Settings → Scheduling)
    // "Today" is the org's LOCAL day, not the (UTC-on-Vercel) server day, so a
    // Pacific evening shift counts toward today rather than tomorrow.
    const { dayStart } = todayBoundsInTz(getOrgSettings(org.settings).timezone);
    const [{ data: techs }, { data: entries }] = await Promise.all([
      supabase
        .from("profiles")
        .select("id, full_name, phone")
        .eq("org_id", org.id)
        .eq("active", true)
        .eq("role", "tech"),
      supabase
        .from("time_entries")
        .select("profile_id, status, notes, time_allocations(id)")
        .eq("org_id", org.id)
        // TODAY'S ROWS **OR** ANYTHING STILL OPEN (audit v921). Filtering on clock_in alone meant
        // a punch left open from yesterday was reminded once, on Monday evening, and never again:
        // Tuesday's fetch didn't return it, the tech's list came back empty and the loop skipped
        // him, while the hours kept accruing. 0193 only closes a stale entry on that person's NEXT
        // punch — if he never punches again, nothing else catches it. Still org-scoped: the
        // service client bypasses RLS, so the org filter stays outside the or().
        .or(`clock_in.gte.${dayStart.toISOString()},status.eq.open`),
    ]);
    if (!techs?.length) continue;

    const byTech = new Map<string, any[]>();
    for (const e of entries ?? []) {
      const list = byTech.get(e.profile_id) ?? [];
      list.push(e);
      byTech.set(e.profile_id, list);
    }

    checked += techs.length;
    for (const t of techs) {
      const todays = byTech.get(t.id) ?? [];
      if (todays.length === 0) continue; // never clocked in — handled by /nudge

      const stillOpen = todays.some((e) => e.status === "open");
      const anyDocumented = todays.some(
        (e) => (e.notes && e.notes.trim()) || (e.time_allocations && e.time_allocations.length > 0),
      );

      let message = "";
      if (stillOpen) {
        message = `Hi ${t.full_name ?? ""} — you're still clocked in. Please clock out and fill out your end-of-day form in Contractor North.`;
      } else if (!anyDocumented) {
        message = `Hi ${t.full_name ?? ""} — please fill out your end-of-day form (what you worked on today) in Contractor North.`;
      } else {
        continue; // done for the day
      }

      const sent = await sendSms(t.phone, message, (org.settings as any)?.sms_from_number);
      if (sent) reminded++;
    }
  }

  // NIGHT DEBRIEF NUDGE (Erik: "i want a night debrief") — this cron already fires at the end
  // of the workday (01:00 UTC ≈ 6pm PT), so the "Close out your day" push rides it: staff get the
  // day's money leaks + a deep link to /planner?debrief=1, which opens Nort's debrief interview.
  let close_out: unknown = null;
  try {
    close_out = await sendCloseOutNudges(supabase);
  } catch (e) {
    // "failed" in a cron JSON nobody reads is a silent failure (audit v921). Every sub-step of
    // the morning cron reports; this one didn't, so the night debrief could stop going out for
    // weeks with nothing in error_events to say so.
    close_out = "failed";
    reportError("cron-close-out", e);
  }

  return NextResponse.json({ checked, reminded, close_out });
}
