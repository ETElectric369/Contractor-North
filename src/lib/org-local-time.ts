/**
 * THE AGENT'S CLOCK DOOR (2026-09-24). Erik to Nort, 13:02 Pacific: "schedule an inspection
 * tomorrow at 10 AM for Tom Goodman". Nort answered "Booked, tomorrow at 10 AM" and the row said
 * 2026-09-25 10:00:00+00, which is 3:00 AM in Homewood. The time verbs (time.*) had converted a
 * model's wall-clock time since audit 7; the appointment verbs handed the model's string straight
 * to a timestamptz column, and Postgres reads a bare "2026-09-25T10:00" as UTC.
 *
 * Two rules, both here so every door uses the same ones:
 *   1. A time a person or a model gives is the COMPANY's wall-clock time. A naive
 *      "YYYY-MM-DDTHH:MM" converts in the org timezone; an explicit offset is honoured as given.
 *   2. What Nort says back comes from the STORED instant, formatted in the org timezone, never
 *      from the words it meant. A wrong store then reads back as the wrong hour and gets caught,
 *      instead of being confirmed as right.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { getOrgSettings } from "@/lib/org-settings";
import { tzDateTimeUtc, tzNaiveIsoToUtc } from "@/lib/tz";

const DEFAULT_TZ = "America/Los_Angeles";

/** The caller's org timezone (RLS scopes the organizations read to their own org). */
export async function orgTimezone(supabase: Pick<SupabaseClient, "from">): Promise<string> {
  const { data } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  return getOrgSettings((data as { settings?: unknown } | null)?.settings).timezone || DEFAULT_TZ;
}

const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * A model- or person-supplied date-time, as the UTC instant to store.
 *   "2026-09-25T10:00"        -> 10:00 in `tz` (the naive, wall-clock case)
 *   "2026-09-25T10:00-07:00"  -> kept: the offset already names the instant
 *   "2026-09-25"              -> `defaultHm` (08:00) in `tz`, the same default the appointment form uses
 * Anything else is an error the caller can speak, never a guess.
 */
export function localToInstant(
  v: string | null | undefined,
  tz: string,
  defaultHm = "08:00",
): { iso: string } | { error: string } {
  const t = String(v ?? "").trim();
  if (!t) return { error: "I need a date and time." };
  const bad = { error: `I couldn't read "${t}" as a date and time. Pass YYYY-MM-DDTHH:MM in the company's local time.` };
  // The digits must name a real calendar day and a real clock time. A shape check alone let
  // "2026-09-31T10:00" roll into Oct 1 and "2026-13-01" throw a RangeError out of Intl (review
  // 2026-09-24): junk is an error, never a guess, and never a throw.
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(t);
  if (!m || !realDay(+m[1], +m[2], +m[3])) return bad;
  if (m[4] !== undefined && (+m[4] > 23 || +m[5] > 59)) return bad;
  let out: string | null | undefined;
  try {
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) out = tzDateTimeUtc(t, defaultHm, tz);
    else if (HAS_OFFSET.test(t)) out = t;
    else if (m[4] !== undefined) out = tzNaiveIsoToUtc(t, tz);
    else out = null;
  } catch {
    return bad;
  }
  const ms = out ? Date.parse(out) : NaN;
  if (!Number.isFinite(ms)) return bad;
  return { iso: new Date(ms).toISOString() };
}

/** Y-M-D names a day that exists (Feb 30 and month 13 do not; Date.UTC would roll them over). */
function realDay(y: number, mo: number, d: number): boolean {
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/** A model-supplied CALENDAR DAY (a payment's paid_at): the YYYY-MM-DD exactly as written. A
 *  calendar-day field never goes through an instant conversion. Models write "last Tuesday" as
 *  "2026-09-15T00:00:00Z"; reading that Z as a real instant moved the payment to Pacific
 *  2026-09-14 (review 2026-09-24). Null when it does not start with a real date. */
export function localDay(v: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v ?? "").trim());
  if (!m || !realDay(+m[1], +m[2], +m[3])) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** A calendar day said the way a person says it: "2026-09-15" -> "Tue Sep 15". */
export function spokenDay(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m || !realDay(+m[1], +m[2], +m[3])) return ymd;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" })
    .format(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)))
    .replace(",", "");
}

/** Free text from the database (a title, a customer name) placed in a WRITE tool's result. Write
 *  results ride outside the read tools' <<TOOL_DATA>> fence, and a stranger can pick a lead's name
 *  on a public intake, so neutralise the fence characters and quote it: it reads as data. */
export function quotedData(v: string | null | undefined): string {
  const t = String(v ?? "").replaceAll("<<", "«").replaceAll(">>", "»").replace(/["\r\n]+/g, " ").trim().slice(0, 120);
  return `"${t}"`;
}

/** A STORED instant read back the way a person says it, in the org timezone:
 *  "Thu Sep 25 at 10:00 AM PDT". The zone label rides along so a shifted store is audible. */
export function spokenWhen(iso: string | Date | null | undefined, tz: string): string {
  if (!iso) return "no time set";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  ) as Record<string, string>;
  return `${p.weekday} ${p.month} ${p.day} at ${p.hour}:${p.minute} ${String(p.dayPeriod ?? "").toUpperCase()} ${p.timeZoneName ?? ""}`.trim();
}
