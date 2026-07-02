import "server-only";
import { todayStrInTz } from "@/lib/tz";
import { orgStaffIds, pushConfigured, sendPushToProfiles } from "@/lib/push";
import { rankSix } from "@/lib/six-rank";
import { daysAgoStr } from "./leak-detectors";

/**
 * The morning "day ahead" push digest (run by the daily automations cron) — the
 * pull loop's reach into a CLOSED app: one push per org that LEADS WITH TODAY'S
 * SIX read back by title ("Today: Garage door button · PUD follow-up · +4"),
 * with the decision items (overdue A/R, fresh leads) riding the body, deep-
 * linking to /planner where the six and the inbox live.
 *
 * getActionItems() can't run here (it builds a cookie-scoped RLS client; the cron
 * has no user), so the digest approximates the decision streams with cheap
 * head-count queries and picks the six with THE shared rank (src/lib/six-rank.ts
 * — the same function the planner ranks with, so phone and app can't disagree).
 * Because the service client BYPASSES RLS, every query filters org_id explicitly.
 *
 * THE BADGE INVARIANT (action-items/types.ts) applies to push numbers too: the
 * old "due OR undated" task arm is GONE — an undated task is not due-now, and no
 * pushed count may be the length of an unbounded or undated set.
 *
 * Per-user opt-in is enforced inside sendPushToProfiles (push_prefs.day_ahead,
 * default OFF) — this never pushes to someone who hasn't turned the trigger on.
 * Guard: an org with no six and no decisions gets no push at all.
 */
export async function sendDayAheadDigests(supabase: any): Promise<{ orgs: number; pushed: number }> {
  const counts = { orgs: 0, pushed: 0 };
  if (!pushConfigured()) return counts; // no VAPID keys → nothing to send

  const { data: orgs } = await supabase.from("organizations").select("id, settings");

  for (const org of orgs ?? []) {
    counts.orgs++;
    const tz = org.settings?.timezone || "America/Los_Angeles";
    const today = todayStrInTz(tz);
    const tomorrow = daysAgoStr(today, -1); // negative offset walks forward

    // Decision head-counts (+2 title rows each) and today's scheduled-job set —
    // the on-site rank needs to know where the truck is going (same ≤1-day tz
    // fuzz as the inbox's materials feeder; jobs + multi-day segments).
    const [invR, leadR, jobR, segR] = await Promise.all([
      supabase
        .from("invoices")
        .select("invoice_number", { count: "exact" })
        .eq("org_id", org.id)
        .in("status", ["sent", "partial", "overdue"])
        .lt("due_date", today)
        .order("due_date", { ascending: true })
        .limit(2),
      supabase
        .from("inquiries")
        .select("name", { count: "exact" })
        .eq("org_id", org.id)
        .eq("status", "new")
        .is("converted_at", null)
        .order("created_at", { ascending: true })
        .limit(2),
      supabase
        .from("jobs")
        .select("id")
        .eq("org_id", org.id)
        .gte("scheduled_start", today)
        .lt("scheduled_start", tomorrow)
        .limit(50),
      supabase
        .from("job_schedule_segments")
        .select("job_id")
        .eq("org_id", org.id)
        .lte("start_date", today)
        .gte("end_date", today)
        .limit(50),
    ]);

    const scheduledJobIds = new Set<string>([
      ...((jobR.data ?? []) as any[]).map((j) => j.id as string),
      ...((segR.data ?? []) as any[]).map((s) => s.job_id as string),
    ]);

    // The six candidates — the same pool the planner ranks: open TOP-LEVEL tasks
    // that are pinned today, dated due/overdue, flagged, or riding today's jobs.
    // Plain undated tasks are deliberately absent (they live behind the
    // Everything-else door, not in anyone's morning). Bounded fetch; the or-arm
    // for today's job set is only added when there ARE jobs today.
    const onSiteArm = scheduledJobIds.size
      ? `,job_id.in.(${[...scheduledJobIds].slice(0, 30).join(",")})`
      : "";
    const { data: taskRows } = await supabase
      .from("tasks")
      .select("id, title, status, priority, due_date, focus_date, category, job_id, parent_id")
      .eq("org_id", org.id)
      .eq("status", "open")
      .is("parent_id", null)
      .or(`focus_date.eq.${today},due_date.lte.${today},priority.gte.1${onSiteArm}`)
      .order("due_date", { ascending: true, nullsFirst: false })
      .limit(60);

    const six = rankSix((taskRows ?? []) as any[], { todayStr: today, scheduledJobIds });

    const decisions = (invR.count ?? 0) + (leadR.count ?? 0);
    if (six.length === 0 && decisions === 0) continue; // nothing needs attention → no push

    // Decision titles in stream order (money → leads), "+N more" for the rest.
    const decisionTitles: string[] = [
      ...((invR.data ?? []) as any[]).map((i) => `Invoice ${i.invoice_number} overdue`),
      ...((leadR.data ?? []) as any[]).map((l) => `New lead: ${l.name}`),
    ].slice(0, 2);
    const moreDecisions = decisions - decisionTitles.length;
    const decisionLine = decisionTitles.join(" · ") + (moreDecisions > 0 ? ` · +${moreDecisions} more` : "");

    const staff = await orgStaffIds(org.id);
    if (!staff.length) continue;

    // Lead with the six; decisions ride the body. Resilient when the six are
    // empty: fall back to the old decisions-only shape rather than pushing a
    // hollow "Today:" header.
    const sixLine =
      six.slice(0, 2).map((t: any) => String(t.title)).join(" · ") +
      (six.length > 2 ? ` · +${six.length - 2}` : "");
    const sixOverflow = six.slice(2).map((t: any) => String(t.title)).join(" · ");

    await sendPushToProfiles(
      staff,
      "day_ahead",
      six.length
        ? {
            title: `Today: ${sixLine}`,
            body: decisions > 0 ? decisionLine : sixOverflow || "Nothing waiting on a decision.",
            url: "/planner",
          }
        : {
            title: `Needs action: ${decisions} item${decisions === 1 ? "" : "s"}`,
            body: decisionLine,
            url: "/planner",
          },
    );
    counts.pushed++;
  }

  return counts;
}
