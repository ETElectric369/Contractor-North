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
import { todayStrInTz, tzDateTimeUtc, tzNaiveIsoToUtc } from "@/lib/tz";

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
  let out: string | null | undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) out = tzDateTimeUtc(t, defaultHm, tz);
  else if (HAS_OFFSET.test(t)) out = t;
  else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t)) out = tzNaiveIsoToUtc(t, tz);
  else out = null;
  const ms = out ? Date.parse(out) : NaN;
  if (!Number.isFinite(ms)) return { error: `I couldn't read "${t}" as a date and time. Pass YYYY-MM-DDTHH:MM in the company's local time.` };
  return { iso: new Date(ms).toISOString() };
}

/** A model-supplied DATE, as the org-local YYYY-MM-DD. A date-time with an explicit offset lands on
 *  the day it is in `tz`; a naive one keeps its own date part. Null when it is not a date at all. */
export function localDay(v: string | null | undefined, tz: string): string | null {
  const t = String(v ?? "").trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(t);
  if (!m) return null;
  if (t.length > 10 && HAS_OFFSET.test(t)) {
    const ms = Date.parse(t);
    return Number.isFinite(ms) ? todayStrInTz(tz, new Date(ms)) : null;
  }
  return m[1];
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
