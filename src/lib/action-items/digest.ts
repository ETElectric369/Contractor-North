import "server-only";
import { todayStrInTz } from "@/lib/tz";
import { getOrgSettings } from "@/lib/org-settings";
import { featureOn } from "@/lib/features";
import { orgStaffIds, pushConfigured } from "@/lib/push";
import { notifyPeople } from "@/lib/notifications";
import { sixForPerson, type DigestTask } from "./digest-six";
import { inquiryDueFilter } from "./due-filters";

/**
 * The morning "day ahead" push digest (run by the daily automations cron) — the
 * pull loop's reach into a CLOSED app: one push per PERSON that LEADS WITH THEIR
 * SIX read back by title ("Today: Garage door button · PUD follow-up · +4"),
 * with the decision items (overdue A/R, fresh leads) riding the body, deep-
 * linking to /planner where the six and the inbox live.
 *
 * EACH PERSON GETS ONLY THEIR OWN (0358, Erik: Reminders are private). The six are
 * Reminders (tasks with no job), and a Reminder is its maker's and its person's
 * alone, so the old "the company's six, pushed to every office member" is gone:
 * each staff member's push carries the six from their own Reminders (digest-six
 * sixForPerson, My Day's cut), and job tasks are nobody's six. The decision items
 * are the company's and ride every staff push as before.
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
 *
 * THE BELL RECORDS IT (notifyPeople, 0366 wave): day_ahead is an opt-in kind, so the line lands
 * only on the bell of someone the push went to. The decisions headline says "Needs You: N", the
 * card's own name on My Day.
 *
 * HOLDS ARE BACK (Wave 1, lane 5): the first decision line counts every job on hold whose day has
 * come or that has no day ("3 Holds Are Back"), the same holds My Day's "Holds Back" pile shows.
 */
export async function sendDayAheadDigests(supabase: any): Promise<{ orgs: number; pushed: number }> {
  const counts = { orgs: 0, pushed: 0 };
  if (!pushConfigured()) return counts; // no VAPID keys → nothing to send

  const { data: orgs } = await supabase.from("organizations").select("id, settings");

  for (const org of orgs ?? []) {
    counts.orgs++;
    const tz = getOrgSettings(org.settings).timezone; // via the settings SSOT — no inline default
    const today = todayStrInTz(tz);

    // Decision head-counts (+2 title rows each), and first THE HOLDS THAT ARE BACK (Wave 1, lane 5):
    // every job on hold whose day is today or earlier, or that has no day at all (a hold from before
    // 0366: it is due now, "No Day Set"), not only the ones that came back today. The service client
    // reads every company, so it is filtered to this one by hand. Before 0366 (no hold_until) it
    // counts 0: the old push never had the line, and it never guesses one.
    const [holdsR, invR, leadR] = await Promise.all([
      supabase
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .eq("org_id", org.id)
        .eq("status", "on_hold")
        .or(`hold_until.is.null,hold_until.lte.${today}`),
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
        // A new lead snoozed to a later day waits for it here too: the rule Needs You and the Sales
        // badge read with, so the push never names a lead My Day has in its Waiting fold.
        .or(inquiryDueFilter(today))
        .order("created_at", { ascending: true })
        .limit(2),
    ]);

    // The six candidates — the same pool the planner ranks: open TOP-LEVEL Reminders (no job) that
    // are pinned today, dated due/overdue, or flagged. Plain undated ones are deliberately absent
    // (they live on the Reminders page, not in anyone's morning), and job tasks never ride it. Who
    // made each one and who it is for ride along, so each person is handed only their own. Bounded
    // fetch (the company's whole pool, then split per person): nulls-first so the cap keeps pins
    // over dated zombies (audit cn-v328).
    const { data: taskRows } = await supabase
      .from("tasks")
      .select("id, title, status, priority, due_date, focus_date, category, job_id, parent_id, created_by, assigned_to")
      .eq("org_id", org.id)
      .eq("status", "open")
      .is("parent_id", null)
      .is("job_id", null)
      .or(`focus_date.eq.${today},due_date.lte.${today},and(due_date.is.null,priority.gte.1)`)
      .order("due_date", { ascending: false, nullsFirst: true })
      .limit(500);
    const pool = (taskRows ?? []) as DigestTask[];

    const holdsBack = holdsBackCount(holdsR);
    // The holds join the decisions: a morning with only holds back still pushes.
    const decisions = holdsBack + (invR.count ?? 0) + (leadR.count ?? 0);
    if (pool.length === 0 && decisions === 0) continue; // nothing needs attention → no push

    // Decision titles: the holds line first ("2 Holds Are Back", the words the pile on My Day uses;
    // it stands for all of them), then stream order (money → leads), "+N more" for the rest.
    const decisionTitles: string[] = [];
    let named = 0;
    if (holdsBack > 0) {
      decisionTitles.push(holdsBackLine(holdsBack));
      named += holdsBack;
    }
    for (const t of [
      ...((invR.data ?? []) as any[]).map((i) => `Invoice ${i.invoice_number} overdue`),
      // Leads switched off (0352): the same people, called what My Day calls them.
      ...((leadR.data ?? []) as any[]).map((l) => `${featureOn(getOrgSettings(org.settings).features, "leads") ? "New lead" : "New request"}: ${l.name}`),
    ]) {
      if (decisionTitles.length >= 2) break;
      decisionTitles.push(t);
      named += 1;
    }
    const moreDecisions = decisions - named;
    const decisionLine = decisionTitles.join(" · ") + (moreDecisions > 0 ? ` · +${moreDecisions} more` : "");

    const staff = await orgStaffIds(org.id);
    if (!staff.length) continue;

    // ONE PUSH PER PERSON, their own six in it. Lead with the six; decisions ride the body.
    // Resilient when someone's six are empty: the decisions-only shape rather than a hollow
    // "Today:" header; nobody with no six and no decisions is pushed at all.
    for (const personId of staff) {
      const six = sixForPerson(pool, personId, today);
      if (six.length === 0 && decisions === 0) continue;
      const sixLine =
        six.slice(0, 2).map((t) => String(t.title)).join(" · ") + (six.length > 2 ? ` · +${six.length - 2}` : "");
      const sixOverflow = six.slice(2).map((t) => String(t.title)).join(" · ");
      await notifyPeople(
        org.id,
        [personId],
        "day_ahead",
        six.length
          ? {
              title: `Today: ${sixLine}`,
              body: decisions > 0 ? decisionLine : sixOverflow || "Nothing waiting on a decision.",
              url: "/planner",
            }
          : {
              title: `Needs You: ${decisions}`,
              body: decisionLine,
              url: "/planner",
            },
      );
      counts.pushed++;
    }
  }

  return counts;
}

/** "1 Hold Is Back", "3 Holds Are Back": the morning push's first decision line. */
export function holdsBackLine(n: number): string {
  return n === 1 ? "1 Hold Is Back" : `${n} Holds Are Back`;
}

/** The holds read's count; a read that failed because 0366 isn't on the database counts 0. */
export function holdsBackCount(r: { count?: number | null; error?: unknown } | null | undefined): number {
  if (!r || r.error) return 0;
  return Math.max(0, Number(r.count ?? 0) || 0);
}
