import { readAllPages } from "@/lib/read-all-pages";
import { tzDayOfWeek, tzMinutesOfDay } from "@/lib/tz";
import { errorMessage } from "@/lib/observe";

/**
 * EVERY COMPANY, WHOLE, OR A FAILURE (cn-v1130). The org-wide crons used to read `organizations`
 * with one bare select: a failed read was an EMPTY run (nothing done, nothing said, "checked 0"),
 * and PostgREST's silent 1,000-row cap would have dropped every company past it. This is the one
 * way a cron reads the companies: paged by id through readAllPages (whole only when an empty page
 * comes back), and a read that fails THROWS, so the cron that called files it and answers 500.
 *
 * The service client bypasses RLS: the caller still scopes every per-org statement by hand.
 */
type Client = { from: (t: string) => any };

export type OrgRow = { id: string; settings: unknown };

/** The company's own 7 AM (its weekdays) for the clock-in nudge, and its own 6 PM (every day) for
 *  the end-of-day reminder and the night debrief, each judged in the org's timezone (atLocalHour).
 *  They live here, not in the route files: a route may export only handlers and segment config. */
export const NUDGE_LOCAL_HOUR = 7;
export const EOD_LOCAL_HOUR = 18;

export async function readAllOrgs<T = OrgRow>(supabase: Client, columns = "id, settings"): Promise<T[]> {
  const { rows, error } = await readAllPages<T>((from, to) =>
    supabase.from("organizations").select(columns).order("id").range(from, to),
  );
  // errorMessage, the sink's own reader (cn-v1130, skeptic #34): a plain object with no `message`
  // used to read "[object Object]" here.
  if (error) throw new Error(`organizations could not be read: ${errorMessage(error)}`);
  return rows;
}

/**
 * THE COMPANY'S OWN HOUR. The texting crons run hourly (vercel.json) and each company is handled
 * on the run that falls in ITS `hour` (0–23, local to `tz`), on its own weekdays when `weekdaysOnly`
 * — never a UTC hour tuned to Pacific summer, which moved the 7 AM text to 6 AM the day DST ended.
 */
export function atLocalHour(tz: string, hour: number, nowMs: number, weekdaysOnly = false): boolean {
  const at = new Date(nowMs);
  if (Math.floor(tzMinutesOfDay(at, tz) / 60) !== hour) return false;
  if (!weekdaysOnly) return true;
  const dow = tzDayOfWeek(tz, at);
  return dow >= 1 && dow <= 5;
}
