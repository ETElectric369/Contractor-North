import { NextResponse } from "next/server";
import { requireCron } from "@/lib/cron-guard";
import { getOrgSettings } from "@/lib/org-settings";
import { reportError } from "@/lib/observe";
import { createNotifications } from "@/lib/notifications";
import { orgStaffIds, sendPushToProfiles } from "@/lib/push";
import { isStaffRole } from "@/lib/actions/perms";
import { jobLabel } from "@/lib/schedule-options";
import { pickLongShiftNudges, quietHold } from "@/lib/long-shift";

/**
 * THE TEN-HOUR NUDGE (2026-09-24). Hourly (vercel.json "0 * * * *").
 *
 * Erik: "Brian did it the other day too and I had no way to stop it to set the time for the
 * invoice". A forgotten clock was found by the office a day later, by hand. This asks the person
 * whose clock it is while he still remembers when he stopped: once, at LONG_SHIFT_HOURS, never
 * between 9 PM and 6 AM org-local (the 6 AM run picks those up). Brian's 1:37 PM clock-in reaches
 * ten hours at 11:37 PM, inside the hold, so the push goes out at 6:00 AM, 16.4 hours in and still
 * under the 18-hour ceiling his own picker allows.
 *
 * It never closes anything. A clock stops only at a time a person states (payroll does not invent
 * hours, and nothing here observed when the work ended).
 *
 * CLAIM FIRST. long_shift_nudged_at (0291) is set with a guarded UPDATE before anything is sent,
 * and a zero-row claim is skipped, so two overlapping runs can never ask the same man twice.
 *
 * The service client bypasses RLS: every query is org-scoped by hand. The push uses the
 * clock_out kind, so a person who turned clock-out pushes off in Settings is not pushed; the bell
 * reaches him either way. The office hears about a crew member's clock on the bell only.
 *
 *   GET /api/timeclock/long-shift   Authorization: Bearer <CRON_SECRET>
 */
export async function GET(request: Request) {
  const guard = requireCron(request);
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const counts = { orgs: 0, held: 0, candidates: 0, claimed: 0, told_office: 0, failed: 0 };
  const { data: orgs, error: orgErr } = await supabase.from("organizations").select("id, settings");
  if (orgErr) {
    reportError("cron-long-shift", orgErr);
    return NextResponse.json({ ...counts, failed: 1 }, { status: 500 });
  }

  for (const org of orgs ?? []) {
    counts.orgs++;
    const tz = getOrgSettings(org.settings).timezone;
    const nowMs = Date.now();
    if (quietHold(nowMs, tz)) {
      counts.held++;
      continue;
    }
    try {
      const { data: open, error } = await supabase
        .from("time_entries")
        .select("id, profile_id, clock_in, long_shift_nudged_at, job:job_id(job_number, name), profiles:profile_id(full_name, role, active)")
        .eq("org_id", org.id)
        .eq("status", "open")
        .is("long_shift_nudged_at", null);
      if (error) throw error;

      type Row = {
        id: string;
        profile_id: string;
        clock_in: string;
        long_shift_nudged_at: string | null;
        job?: { job_number?: string | null; name?: string | null } | { job_number?: string | null; name?: string | null }[] | null;
        profiles?: { full_name?: string | null; role?: string | null; active?: boolean | null } | { full_name?: string | null; role?: string | null; active?: boolean | null }[] | null;
      };
      const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
      const rows = pickLongShiftNudges((open ?? []) as unknown as Row[], nowMs, tz);
      counts.candidates += rows.length;
      let staffIds: string[] | null = null;

      for (const r of rows) {
        const { data: claimed, error: claimErr } = await supabase
          .from("time_entries")
          .update({ long_shift_nudged_at: new Date(nowMs).toISOString() })
          .eq("id", r.id)
          .eq("org_id", org.id)
          .eq("status", "open")
          .is("long_shift_nudged_at", null)
          .select("id");
        if (claimErr) throw claimErr;
        if (!claimed?.length) continue; // another run took it, or the clock stopped meanwhile
        counts.claimed++;

        const person = one(r.profiles);
        if (person?.active === false) continue; // a removed person's phone is never pushed
        const job = one(r.job);
        const label = job ? jobLabel(job) : null;
        const inAt = new Date(r.clock_in);
        const since = `${inAt.toLocaleDateString("en-US", { timeZone: tz, weekday: "short" })} ${inAt
          .toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })
          .replace(/ /g, " ")}`;

        const title = "Still On The Clock?";
        const body = `You've been clocked in${label ? ` at ${label}` : ""} since ${since}. Tap to set when you stopped.`;
        await sendPushToProfiles([r.profile_id], "clock_out", { title, body, url: "/timeclock" });
        await createNotifications(org.id, [r.profile_id], { type: "long_shift", title, body, url: "/timeclock" });

        if (!isStaffRole(person?.role ?? "")) {
          staffIds ??= await orgStaffIds(org.id);
          const name = (person?.full_name ?? "").trim();
          const first = name.split(/\s+/)[0] || "A crew member";
          const hours = Math.floor((nowMs - inAt.getTime()) / 3_600_000);
          await createNotifications(org.id, staffIds, {
            type: "long_shift",
            title: `${first} Is Still On The Clock`,
            body: `Clocked in ${since}${label ? ` at ${label}` : ""}, ${hours} hours ago.`,
            url: `/timecards?entry=${r.id}`,
          });
          counts.told_office++;
        }
      }
    } catch (e) {
      // Nothing silent: a cron JSON nobody reads is not a report (audit v921).
      counts.failed++;
      reportError("cron-long-shift", e, { orgId: org.id });
    }
  }

  return NextResponse.json(counts);
}
