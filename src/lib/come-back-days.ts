/**
 * EVERY WAIT HAS A DAY (NY-hold, 0366). The days a wait can come back on, worked out from the
 * company's today, and the words for them. Pure: no clock of its own, no timezone of its own. Every
 * caller hands in `todayStr`, the company's today (YYYY-MM-DD, todayStrInTz), and gets calendar days
 * back, so a phone in another zone and a server on UTC agree about what "tomorrow" is.
 *
 * Erik, 2026-09-26: "jobs on hold will have a reason and that reason is usually a reminder", then
 * "too quiet gets things lost". So a hold is a reason AND a day (a week out unless someone picks
 * another), and there is no "no date": nothing goes quiet without the day it comes back.
 *
 * The chips (come-back-picker): Tomorrow, Mon (the Monday after today), In A Week (the default), or
 * Pick A Day. A picked day is today or later.
 */

/** The chips' names, as a server action receives them when the page doesn't know the company's today. */
export type ComeBackPick = "tomorrow" | "monday" | "week";

export const COME_BACK_PICKS: readonly ComeBackPick[] = ["tomorrow", "monday", "week"];

/** A hold's day when nobody picks one: a week out (the database's own default, jobs_hold_day). */
export const DEFAULT_COME_BACK: ComeBackPick = "week";

/** What a door hands the server: a day it worked out itself, or a chip's name to work out there. */
export type ComeBackWhen = { date: string } | { pick: ComeBackPick };

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day written YYYY-MM-DD (2026-02-30 is not one). */
export function isYmd(s: unknown): s is string {
  const m = typeof s === "string" ? YMD.exec(s) : null;
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

function utc(ymd: string): Date {
  const m = YMD.exec(ymd)!;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** `n` calendar days after `ymd` (negative walks back). Calendar days, never 86,400,000 ms steps. */
export function addDays(ymd: string, n: number): string {
  const d = utc(ymd);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The Monday AFTER today: tomorrow on a Sunday, a week later on a Monday. */
export function nextMonday(todayStr: string): string {
  const dow = utc(todayStr).getUTCDay(); // 0 Sunday … 6 Saturday
  return addDays(todayStr, ((8 - dow) % 7) || 7);
}

/** The day a chip means, from the company's today. */
export function comeBackDay(todayStr: string, pick: ComeBackPick): string {
  if (pick === "tomorrow") return addDays(todayStr, 1);
  if (pick === "monday") return nextMonday(todayStr);
  return addDays(todayStr, 7);
}

export const PICK_TODAY_OR_LATER = "Pick today or later";

/** A day a person picked: a real day, today or later. The refusal is the words the door shows. */
export function checkComeBackDay(todayStr: string, day: unknown): { ok: true; day: string } | { ok: false; error: string } {
  if (!isYmd(day)) return { ok: false, error: "Pick a day." };
  if (day < todayStr) return { ok: false, error: PICK_TODAY_OR_LATER };
  return { ok: true, day };
}

/** What a door sent (a day, or a chip's name), resolved against the company's today and checked. */
export function resolveComeBack(todayStr: string, when: ComeBackWhen | null | undefined): { ok: true; day: string } | { ok: false; error: string } {
  if (!when || typeof when !== "object") return { ok: false, error: "Pick a day." };
  if ("pick" in when) {
    if (!COME_BACK_PICKS.includes(when.pick)) return { ok: false, error: "Pick a day." };
    return { ok: true, day: comeBackDay(todayStr, when.pick) };
  }
  return checkComeBackDay(todayStr, (when as { date?: unknown }).date);
}

/** "Oct 3": a calendar day in words, no year, read the same in every timezone. */
export function shortDay(ymd: string): string {
  return utc(ymd).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Due: the day has come (or passed), or there is no day at all (a hold from before 0366). */
export function comeBackDue(day: string | null | undefined, todayStr: string): boolean {
  return !isYmd(day) || day <= todayStr;
}

/**
 * The chip on a held card: "Back Oct 3", "Back Today" once the day has come (a day already passed is
 * due today, not "3 days ago": it is waiting on a person now), and "No Day Set" for a hold from before
 * the day existed (its Snooze picks one).
 */
export function backWords(day: string | null | undefined, todayStr: string): string {
  if (!isYmd(day)) return "No Day Set";
  if (day <= todayStr) return "Back Today";
  return `Back ${shortDay(day)}`;
}

/**
 * THE SENTENCE WHEN A HOLD COMES OFF WITHOUT ANYONE CHOOSING TO (NY-hold B4): clocking into a held
 * job, switching onto it, or putting a punch on it takes it off hold (the one promotion clock-in,
 * Switch Job and Which Job share), and that is never silent. "J-048 was on hold (waiting on the
 * permit). It's off hold now."
 */
export function offHoldWords(job: { jobNumber?: string | null; name?: string | null; reason?: string | null }): string {
  const who = (job.jobNumber ?? "").trim() || (job.name ?? "").trim() || "That job";
  const why = (job.reason ?? "").trim();
  return `${who} was on hold${why ? ` (${why.replace(/[.\s]+$/, "")})` : ""}. It's off hold now.`;
}
