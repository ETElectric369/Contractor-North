import "server-only";
import { todayStrInTz } from "@/lib/tz";
import { orgStaffIds, pushConfigured, sendPushToProfiles } from "@/lib/push";

/**
 * The morning "day ahead" push digest (run by the daily automations cron) — the
 * pull loop's reach into a CLOSED app: one push per org summarizing what needs
 * action, deep-linking to /planner where the full inbox lives.
 *
 * getActionItems() can't run here (it builds a cookie-scoped RLS client; the cron
 * has no user), so the digest approximates the inbox's three biggest streams with
 * cheap head-count queries on the service client. Because the service client
 * BYPASSES RLS, every query filters org_id explicitly.
 *
 * Per-user opt-in is enforced inside sendPushToProfiles (push_prefs.day_ahead,
 * default OFF) — this never pushes to someone who hasn't turned the trigger on.
 * Guard: an org with nothing needing action gets no push at all.
 */
export async function sendDayAheadDigests(supabase: any): Promise<{ orgs: number; pushed: number }> {
  const counts = { orgs: 0, pushed: 0 };
  if (!pushConfigured()) return counts; // no VAPID keys → nothing to send

  const { data: orgs } = await supabase.from("organizations").select("id, settings");

  for (const org of orgs ?? []) {
    counts.orgs++;
    const tz = org.settings?.timezone || "America/Los_Angeles";
    const today = todayStrInTz(tz);

    // Three cheap counts (+2 title rows each): overdue A/R, fresh leads, due tasks.
    const [invR, leadR, taskR] = await Promise.all([
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
      // Same cut as the inbox: open tasks due today/overdue PLUS undated ones
      // (fast-capture tasks have no due_date and are treated as due-now).
      supabase
        .from("tasks")
        .select("title", { count: "exact" })
        .eq("org_id", org.id)
        .eq("status", "open")
        .or(`due_date.is.null,due_date.lte.${today}`)
        .order("priority", { ascending: false })
        .limit(2),
    ]);

    const total = (invR.count ?? 0) + (leadR.count ?? 0) + (taskR.count ?? 0);
    if (total === 0) continue; // nothing needs action → no push

    // Top 2 titles in stream order (money → leads → today), "+N more" for the rest.
    const titles: string[] = [
      ...((invR.data ?? []) as any[]).map((i) => `Invoice ${i.invoice_number} overdue`),
      ...((leadR.data ?? []) as any[]).map((l) => `New lead: ${l.name}`),
      ...((taskR.data ?? []) as any[]).map((t) => String(t.title)),
    ].slice(0, 2);
    const more = total - titles.length;

    const staff = await orgStaffIds(org.id);
    if (!staff.length) continue;

    await sendPushToProfiles(staff, "day_ahead", {
      title: `Needs action: ${total} item${total === 1 ? "" : "s"}`,
      body: titles.join(" · ") + (more > 0 ? ` · +${more} more` : ""),
      url: "/planner",
    });
    counts.pushed++;
  }

  return counts;
}
