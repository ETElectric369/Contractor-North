import "server-only";
import { OPEN_BUGS_FILTER } from "@/lib/bug-watch-count";
import { notifyPeople } from "@/lib/notifications";
import { platformAdminProfiles } from "@/lib/platform-alert";
import { PLATFORM_TZ } from "@/lib/platform-tz";
import { rateLimited } from "@/lib/rate-limit";
import { todayStrInTz, tzDayOfWeek } from "@/lib/tz";

const DAY_MS = 86_400_000;

/** A culprit and how often the sink has seen it. */
export type Culprit = { culprit: string; event_count: number };

/** The week's numbers, read once, then turned into words (digestWords). */
export type DigestCounts = {
  /** Bug reports with no status or status 'open' (the Bugs page's own rule, bug-watch-count). */
  open: number;
  /** Rows first seen in the last 7 days, by level; traces are not errors and are left out. */
  newByLevel: { error: number; blocker: number };
  /** Blocker rows seen in the last 7 days, whatever their status, by culprit. */
  blockers: Culprit[];
  /** Rows still new or triaged that were first seen more than 30 days ago (traces left out). */
  stale: number;
  /** The three culprits with the highest counts among rows seen in the last 7 days (traces left out). */
  top: Culprit[];
};

export type DigestWords = { title: string; body: string };

/**
 * THE ISO WEEK AN INSTANT FALLS IN, on North's own calendar: "2026-W45". The day is taken in `tz`
 * first (a Sunday 11 PM Pacific is Monday in UTC and must not count as next week), then the ISO
 * rule — the week belongs to the year that holds its Thursday — on that calendar date.
 */
export function isoWeekKey(nowMs: number, tz: string): string {
  const [y, m, d] = todayStrInTz(tz, new Date(nowMs)).split("-").map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  const weekday = day.getUTCDay() || 7; // Monday 1 … Sunday 7
  day.setUTCDate(day.getUTCDate() + 4 - weekday); // this week's Thursday
  const yearStart = Date.UTC(day.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((day.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${day.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * THE WORDS. The title is the two numbers a Monday needs — open reports and new errors this week —
 * or "All Quiet This Week" only when there are no open reports, nothing new, no blocker was seen AND
 * nothing repeated (the most-seen list is empty, skeptic #42 N3: a week with repeats is not quiet).
 * The body says the blockers first (they are the week's news), then the three loudest culprits —
 * "Most seen overall", because event_count is the row's LIFETIME count, not the week's — then how
 * many rows have sat open past thirty days; a part with nothing to say is left out.
 */
export function digestWords(c: DigestCounts): DigestWords {
  const fresh = c.newByLevel.error + c.newByLevel.blocker;
  const quiet = c.open === 0 && fresh === 0 && c.blockers.length === 0 && c.top.length === 0;
  const title = quiet ? "Bug Watch: All Quiet This Week" : `Bug Watch: ${plural(c.open, "Open Report")} · ${plural(fresh, "New Error")} This Week`;
  const parts: string[] = [];
  if (c.blockers.length) parts.push(`${plural(c.blockers.length, "blocker")}: ${c.blockers.map((b) => b.culprit).join(", ")}`);
  if (c.top.length) parts.push(`Most seen overall: ${c.top.map((t) => `${t.culprit} ×${t.event_count}`).join(", ")}`);
  if (c.stale > 0) parts.push(`${c.stale} open longer than 30 days`);
  return { title, body: parts.length ? parts.join(" · ") : "Nothing new in the sink this week." };
}

type Answer<T> = { data?: T | null; count?: number | null; error: unknown };
// The service client's query builder, typed as loosely as notifications.ts types it: every read
// below is checked for its error, so the shape of the builder is all this module needs.
type DigestClient = { from: (table: string) => any };

async function headCount(q: PromiseLike<Answer<unknown>>, what: string): Promise<number> {
  const { count, error } = await q;
  if (error) throw error;
  if (typeof count !== "number") throw new Error(`${what}: the count did not come back`);
  return count;
}

async function culprits(q: PromiseLike<Answer<Culprit[]>>): Promise<Culprit[]> {
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map((r) => ({ culprit: String(r.culprit ?? ""), event_count: Number(r.event_count ?? 0) }));
}

/** EVERY READ CHECKED: a count that could not be read throws — a digest of zeros would say the
 *  week was quiet when the sink was unreachable, and that is the one lie this page must not tell. */
export async function readDigestCounts(supabase: DigestClient, nowMs: number): Promise<DigestCounts> {
  const since7 = new Date(nowMs - 7 * DAY_MS).toISOString();
  const since30 = new Date(nowMs - 30 * DAY_MS).toISOString();
  const errors = () => supabase.from("error_events");
  const head = { count: "exact" as const, head: true as const };
  const open = await headCount(supabase.from("bug_reports").select("id", head).or(OPEN_BUGS_FILTER), "open bug reports");
  const newErrors = await headCount(errors().select("id", head).eq("level", "error").gte("first_seen", since7), "new errors");
  const newBlockers = await headCount(errors().select("id", head).eq("level", "blocker").gte("first_seen", since7), "new blockers");
  const blockers = await culprits(errors().select("culprit, event_count").eq("level", "blocker").gte("last_seen", since7).order("event_count", { ascending: false }).limit(20));
  const stale = await headCount(errors().select("id", head).in("status", ["new", "triaged"]).neq("level", "trace").lt("first_seen", since30), "rows open past 30 days");
  const top = await culprits(errors().select("culprit, event_count").neq("level", "trace").gte("last_seen", since7).order("event_count", { ascending: false }).limit(3));
  return { open, newByLevel: { error: newErrors, blocker: newBlockers }, blockers, stale, top };
}

/**
 * THE MONDAY DIGEST (cn-v1136): once a week, on North's own Monday morning, every platform admin
 * gets one bell line and one push with the week's numbers, under the bug_watch kind. Runs from the
 * daily cron, which is at every company's own hour — so the gate is Monday in PLATFORM_TZ, and a
 * second run the same Monday is held off by a one-hit claim on the ISO week's key.
 *
 * THE GATE ADMITS MONDAY, TUESDAY AND WEDNESDAY (skeptic #42, N1): a Monday whose counts threw used
 * to lose the week — Tuesday said "not Monday". Now the first run that gets through the counts in
 * those three days sends, and the one-hit weekly claim keeps it to ONE digest; Thursday onward is
 * "not Monday" (the words are the step's, read in the cron's body).
 *
 * THE CLAIM FAILS OPEN on purpose (rateLimited without failClosed): a limiter outage may send the
 * digest twice, never silence it — a doubled Monday note costs a glance; a missing one hides a week.
 * The claim is spent LAST, after the counts and the admins are in hand: a failed count throws
 * without spending it, so a re-run after the fix still sends.
 */
export async function sendBugWatchDigest(
  supabase: DigestClient,
  nowMs: number,
): Promise<{ sent: number; skipped?: "not Monday" | "already sent" | "no admins" }> {
  const dow = tzDayOfWeek(PLATFORM_TZ, new Date(nowMs));
  if (dow < 1 || dow > 3) return { sent: 0, skipped: "not Monday" };
  const counts = await readDigestCounts(supabase, nowMs);
  const admins = (await platformAdminProfiles()).filter((a) => a.org_id);
  if (!admins.length) return { sent: 0, skipped: "no admins" };
  if (await rateLimited(`bug-watch-digest:${isoWeekKey(nowMs, PLATFORM_TZ)}`, 1, 7 * 86_400)) return { sent: 0, skipped: "already sent" };
  const words = digestWords(counts);
  let sent = 0;
  for (const admin of admins) {
    await notifyPeople(admin.org_id, [admin.id], "bug_watch", { title: words.title, body: words.body, url: "/bugs" });
    sent++;
  }
  return { sent };
}
