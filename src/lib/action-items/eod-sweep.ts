import "server-only";
import { todayStrInTz } from "@/lib/tz";
import { orgStaffIds, pushConfigured, sendPushToProfiles } from "@/lib/push";
import {
  NEEDS_RETURN_DAYS,
  daysAgoStr,
  detectNeedsReturn,
  detectStrayTime,
  detectUnbilledWork,
  jobLabel,
  rollupWorkedJobs,
} from "./leak-detectors";

/**
 * The "Close out your day" nudge (run by the daily automations cron) — the push
 * side of the end-of-day money-leak sweep. Reuses the SAME pure detectors as the
 * inbox (leak-detectors.ts): stray time entries, worked-but-uncosted jobs, worked
 * jobs with no return visit scheduled. When any detector fires for an org, its
 * staff get one push naming the top gaps, deep-linked to /planner?debrief=1
 * (which auto-opens Nort's debrief).
 *
 * TIMING (v1): the daily cron runs each MORNING, so this sweeps YESTERDAY's gaps —
 * "close out your day" arrives with the day-ahead digest, before the new day buries
 * them. The evening SMS (/api/timeclock/eod-reminder) already chases techs same-day;
 * this is the OWNER's money view the morning after.
 *
 * The service client BYPASSES RLS: time_entries queries filter org_id explicitly,
 * and every job-level query is scoped through those org-owned job ids. Opt-out is
 * the same per-user toggle as the day-ahead digest (push_prefs.day_ahead, default
 * OFF, enforced inside sendPushToProfiles). No gaps → no push.
 */
export async function sendCloseOutNudges(supabase: any): Promise<{ orgs: number; pushed: number }> {
  const counts = { orgs: 0, pushed: 0 };
  if (!pushConfigured()) return counts; // no VAPID keys → nothing to send

  const { data: orgs } = await supabase.from("organizations").select("id, settings");

  for (const org of orgs ?? []) {
    counts.orgs++;
    const tz = org.settings?.timezone || "America/Los_Angeles";
    const today = todayStrInTz(tz);

    const [openR, recentR] = await Promise.all([
      supabase
        .from("time_entries")
        .select("id, status, job_id, clock_in, clock_out, profiles(full_name), time_allocations(job_id)")
        .eq("org_id", org.id)
        .eq("status", "open")
        .limit(50),
      supabase
        .from("time_entries")
        .select("id, status, job_id, clock_in, clock_out, profiles(full_name), time_allocations(job_id)")
        .eq("org_id", org.id)
        .gte("clock_in", daysAgoStr(today, NEEDS_RETURN_DAYS))
        .limit(200),
    ]);

    const stray = detectStrayTime([...((openR.data ?? []) as any[]), ...((recentR.data ?? []) as any[])], today);
    const worked = rollupWorkedJobs((recentR.data ?? []) as any[], today);

    // Detection only — name the gap, never fill in hours/dollars for the user.
    const gaps: string[] = stray.map((f) =>
      f.openStill ? `${f.name}'s entry is still open` : `${f.name}'s entry has no job`,
    );

    if (worked.size > 0) {
      // Org-scoping note: jobIds come from the org-filtered time_entries above, so
      // every .in("job_id", jobIds) below is org-scoped by construction.
      const jobIds = [...worked.keys()].slice(0, 30);
      const [jobsR, billsR, posR, matR, invR, apptR, segR] = await Promise.all([
        supabase.from("jobs").select("id, job_number, name, status, scheduled_start").in("id", jobIds),
        supabase.from("bills").select("job_id").in("job_id", jobIds).limit(200),
        supabase.from("purchase_orders").select("job_id").in("job_id", jobIds).limit(200),
        supabase.from("material_lists").select("job_id, material_list_items(id)").in("job_id", jobIds).limit(100),
        supabase.from("invoices").select("job_id, status").in("job_id", jobIds).limit(200),
        supabase
          .from("appointments")
          .select("job_id")
          .in("job_id", jobIds)
          .eq("status", "scheduled")
          .gte("starts_at", today)
          .limit(200),
        supabase.from("job_schedule_segments").select("job_id").in("job_id", jobIds).gte("end_date", today).limit(200),
      ]);

      const costedJobIds = new Set<string>([
        ...((billsR.data ?? []) as any[]).map((b: any) => b.job_id as string),
        ...((posR.data ?? []) as any[]).map((p: any) => p.job_id as string),
        ...((matR.data ?? []) as any[])
          .filter((m: any) => (m.material_list_items?.length ?? 0) > 0)
          .map((m: any) => m.job_id as string),
      ]);
      const invoicedJobIds = new Set<string>(
        ((invR.data ?? []) as any[]).filter((i: any) => i.status !== "void" && i.job_id).map((i: any) => i.job_id as string),
      );
      const futureApptJobIds = new Set<string>(((apptR.data ?? []) as any[]).map((a: any) => a.job_id as string));
      const futureSegmentJobIds = new Set<string>(((segR.data ?? []) as any[]).map((s: any) => s.job_id as string));
      const jobs = (jobsR.data ?? []) as any[];

      for (const f of detectUnbilledWork({ jobs, worked, costedJobIds, invoicedJobIds })) {
        gaps.push(`${jobLabel(f.job)} has no costs recorded`);
      }
      for (const f of detectNeedsReturn({ jobs, worked, todayStr: today, futureApptJobIds, futureSegmentJobIds })) {
        gaps.push(`${jobLabel(f.job)} has nothing scheduled next`);
      }
    }

    if (gaps.length === 0) continue; // clean day → no push

    const staff = await orgStaffIds(org.id);
    if (!staff.length) continue;

    const top = gaps.slice(0, 2);
    const more = gaps.length - top.length;
    await sendPushToProfiles(staff, "day_ahead", {
      title: "Close out your day",
      body: top.join(" · ") + (more > 0 ? ` · +${more} more` : ""),
      url: "/planner?debrief=1",
    });
    counts.pushed++;
  }

  return counts;
}
