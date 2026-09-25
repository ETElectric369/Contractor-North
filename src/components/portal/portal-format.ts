/**
 * How the customer's pages say dates, hours and colors. Pure, so it runs the same on the server,
 * in the browser and in the tests.
 *
 * THE DAY IS ALREADY THE ORG'S DAY. The ledger hands over "YYYY-MM-DD" strings that were turned
 * into dates in the org timezone before they got here (stretch-ledger, rule 3). Formatting one
 * must never move it again, so every date here is read at noon UTC and printed in UTC: Sep 18
 * stays Sep 18 on a phone in any timezone.
 */
import type { CSSProperties } from "react";

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

function at(ymd: string): Date | null {
  if (!YMD.test(ymd)) return null;
  const d = new Date(`${ymd}T12:00:00Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** "Jul 14", or "Jul 14, 2025" when the year is not `thisYear`. */
export function fmtDay(ymd: string | null | undefined, thisYear?: string): string {
  const d = ymd ? at(ymd) : null;
  if (!d || !ymd) return "";
  const withYear = !!thisYear && ymd.slice(0, 4) !== thisYear;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
}

/** "Tue, Jul 14" (a day's own heading). */
export function fmtWeekday(ymd: string, thisYear?: string): string {
  const d = at(ymd);
  if (!d) return ymd;
  const withYear = !!thisYear && ymd.slice(0, 4) !== thisYear;
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  });
}

/** "Jul 14 to Aug 10", or one day when the stretch starts and ends on it. */
export function fmtRange(startsOn: string | null, endsOn: string | null, thisYear?: string): string {
  if (!startsOn && !endsOn) return "";
  if (!endsOn || startsOn === endsOn) return fmtDay(startsOn ?? endsOn, thisYear);
  if (!startsOn) return `to ${fmtDay(endsOn, thisYear)}`;
  return `${fmtDay(startsOn, thisYear)} to ${fmtDay(endsOn, thisYear)}`;
}

/** 3.5 → "3.5 hours", 1 → "1 hour", 0.25 → "0.25 hours". Never more than two places. */
export function fmtHours(h: number): string {
  const n = Math.round((Number(h) || 0) * 100) / 100;
  const s = n.toFixed(2).replace(/\.?0+$/, "");
  return `${s} ${n === 1 ? "hour" : "hours"}`;
}

/** A quantity as the bill prints it: 250, 3.5, 0.25. */
export function fmtQty(q: number): string {
  const n = Math.round((Number(q) || 0) * 100) / 100;
  return n.toFixed(2).replace(/\.?0+$/, "");
}

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * The sea-glass skin's CSS variables for an org's own glass color: the same derivation the app
 * layout feeds the dock (--glass-tint as an rgb triplet, --glass-ink at 0.62 of it, which is what
 * accentHex returns), so the customer's page and the office's app wear one color.
 */
export function seaGlassStyle(tintHex: string | null | undefined): CSSProperties {
  const hex = tintHex && HEX.test(tintHex) ? tintHex : "#1b9488";
  const n = parseInt(hex.slice(1), 16);
  const rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const ink = rgb.map((c) => Math.round(c * 0.62));
  return {
    "--glass-tint": rgb.join(" "),
    "--glass-ink": ink.join(" "),
    "--color-brand": `rgb(${ink.join(" ")})`,
  } as CSSProperties;
}

/** "1 Main St Unit 2, Truckee, CA 96161" from the job's site parts. */
export function siteLine(site: { address: string | null; unit: string | null; city: string | null; state: string | null; zip: string | null }): string {
  const street = [site.address, site.unit].filter(Boolean).join(" ");
  const cityState = [site.city, site.state].filter(Boolean).join(", ");
  const tail = [cityState, site.zip].filter(Boolean).join(" ");
  return [street, tail].filter(Boolean).join(", ");
}

const JOB_STATUS: Record<string, string> = {
  to_be_scheduled: "Not Scheduled Yet",
  scheduled: "Scheduled",
  in_progress: "In Progress",
  on_hold: "On Hold",
  complete: "Done",
  invoiced: "Billed",
};
/** A job's status in the customer's words (only the statuses a customer is shown reach here). */
export function portalJobStatus(status: string | null | undefined): string {
  return JOB_STATUS[String(status ?? "")] ?? "In Progress";
}
