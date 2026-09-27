import "server-only";
import { todayStrInTz } from "@/lib/tz";
import { getOrgSettings } from "@/lib/org-settings";
import { featureOn } from "@/lib/features";
import { orgStaffIds, pushConfigured, sendPushToProfiles } from "@/lib/push";
import { claimedSourcesOnJob } from "@/lib/unbilled-work";
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
 * TIMING: this rides the 6 PM run, /api/timeclock/eod-reminder (vercel.json "0 1 * * *",
 * 01:00 UTC, which is 6 PM Pacific in summer and 5 PM in winter), so "close out your day"
 * arrives the same evening the gaps were made, beside the tech-facing reminder that route
 * also sends. It is the OWNER's money view of the day that just ended.
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
    const tz = getOrgSettings(org.settings).timezone; // via the settings SSOT — no inline default
    const today = todayStrInTz(tz);

    const [openR, recentR, codesR] = await Promise.all([
      supabase
        .from("time_entries")
        .select("id, status, job_id, clock_in, clock_out, job_code, profiles(full_name)")
        .eq("org_id", org.id)
        .eq("status", "open")
        .limit(50),
      supabase
        .from("time_entries")
        .select("id, status, job_id, clock_in, clock_out, job_code, profiles(full_name)")
        .eq("org_id", org.id)
        .gte("clock_in", daysAgoStr(today, NEEDS_RETURN_DAYS))
        .limit(200),
      // The codes a job-less entry may carry on purpose (billable = false), the labor-billing predicate.
      supabase.from("job_codes").select("code").eq("org_id", org.id).eq("billable", false),
    ]);
    const nonBillable = new Set<string>(((codesR.data ?? []) as { code?: string | null }[]).map((c) => String(c.code ?? "").trim()).filter(Boolean));

    // The org's own calendar decides "a past day" (tz), not the UTC slice of the timestamp.
    const found = detectStrayTime([...((openR.data ?? []) as any[]), ...((recentR.data ?? []) as any[])], today, Date.now(), nonBillable, tz);
    const worked = rollupWorkedJobs((recentR.data ?? []) as any[], today);

    /* A CLOSED SHIFT ON NO JOB THAT A LIVE INVOICE HOLDS IS BILLED (0357: billed by hand on an
       invoice with no job, TTUSD on INV-055). My Day drops its Needs You row for that (query.ts,
       noJobStrayDoors over the same claims read), so the push does too: it never names a gap the
       page it links to no longer shows. Pinned to this org by hand (the service client skips RLS).
       A lost read keeps every finding: a nag too many, never a gap missed. */
    const closedNoJob = found.filter((f) => !f.openStill).map((f) => f.entryId);
    let billedNoJob = new Set<string>();
    if (closedNoJob.length) {
      try {
        const held = await claimedSourcesOnJob(supabase, null, null, closedNoJob, { orgId: org.id });
        billedNoJob = new Set([...held.owner.keys()].map(String));
      } catch {
        billedNoJob = new Set();
      }
    }
    const stray = found.filter((f) => f.openStill || !billedNoJob.has(f.entryId));

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
          .eq("absorbed", false) // the job's own segments carry an absorbed visit's dates (0237)
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
      // Nort switched off (0352): plain My Day, whose Needs You list names the same gaps. The
      // ?debrief=1 opener lives on Nort's button, which isn't drawn then.
      url: featureOn(getOrgSettings(org.settings).features, "nort") ? "/planner?debrief=1" : "/planner",
    });
    counts.pushed++;
  }

  return counts;
}
