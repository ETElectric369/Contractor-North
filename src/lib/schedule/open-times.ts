/**
 * OPEN INSPECTION TIMES (cn-v1185): what a website visitor who has just sent a form may pick.
 *
 * The owner: "offer open times" — never "book the first one by itself". A company sets its inspection
 * days (Settings › Crew & Time, org-settings InspectionDays); while the offer is on, each of the next
 * OFFER_LOOKAHEAD_DAYS inspection days (never sooner than today + OFFER_FIRST_DAY_OFFSET in the
 * company's timezone) is laid out as a grid of 90-minute starts from the window's start, and a start
 * is OPEN when it ends by the window's end and overlaps nothing that fills the day, by the schedule's
 * own rule (lib/schedule/day-busy readDayBusy, the one planDayTimes reads). A day that already holds
 * `per_day` inspections offers nothing.
 *
 * NO "LAND IT LATE". The office's fitter (fit-day fitIntoDay) lands a visit after everything when the
 * day is full, because the office can see it ran long. A visitor cannot: a full window offers nothing,
 * so this never calls the fitter.
 *
 * EVERY READ NAMES ITS COMPANY: the public doors run on the service client (no RLS). A FAILED READ
 * THROWS (never "nothing is busy"): callers catch it and offer nothing.
 *
 * Not a "use server" file, and it imports no word catalog: the label is English, built here.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { featureOn } from "@/lib/features";
import { healInspectionDays, workDayWindowHm, type OrgSettings, type Weekday } from "@/lib/org-settings";
import { todayStrInTz, tzDateTimeUtc } from "@/lib/tz";
import { companyDayBounds, readDayBusy } from "./day-busy";
import { hmToMinutes, minutesToHm, NOMINAL_SLOT, type Busy } from "./fit-day";

/** An opening is 90 clear minutes: the day fitter's nominal visit. */
export const INSPECTION_SLOT_MIN = NOMINAL_SLOT;
/** The first day offered is today + 2 in the company's timezone (Book It's own default). */
export const OFFER_FIRST_DAY_OFFSET = 2;
/** Only the next six inspection days are looked at (bounded reads). */
export const OFFER_LOOKAHEAD_DAYS = 6;
/** The offer: the first OFFER_PER_DAY open starts of each of the first OFFER_MAX_DAYS days with any. */
export const OFFER_MAX_DAYS = 3;
export const OFFER_PER_DAY = 2;

/** One open time: `at` is the UTC instant of `ymd` + `hm` on the company's clock. */
export type OpenTime = { at: string; ymd: string; hm: string };

const WEEK: readonly Weekday[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** The window in minutes, or null when no 90-minute start fits in it. */
function windowMinutes(d: { start: string; end: string }): { startMin: number; endMin: number } | null {
  const startMin = hmToMinutes(d.start);
  const endMin = hmToMinutes(d.end);
  if (startMin == null || endMin == null || endMin - startMin < INSPECTION_SLOT_MIN) return null;
  return { startMin, endMin };
}

/** Is the offer on: switched on, a day ticked, at least one 90-minute start in the window, and the
 *  Leads & Inspections switch on. */
export function offersOpenTimes(s: Pick<OrgSettings, "inspection_days" | "features">): boolean {
  const d = healInspectionDays(s.inspection_days);
  return d.offer && d.days.length > 0 && windowMinutes(d) !== null && featureOn(s.features, "leads");
}

/** The grid from the window's start, stepping `slotMin`; a start is open when it ends by the window's
 *  end and overlaps no busy block (touching ends do not overlap). Pure. */
export function openStartsInWindow(busy: Busy[], w: { startMin: number; endMin: number; slotMin: number }): number[] {
  const out: number[] = [];
  if (!(w.slotMin > 0) || !Number.isFinite(w.startMin) || !Number.isFinite(w.endMin)) return out;
  for (let s = w.startMin; s + w.slotMin <= w.endMin; s += w.slotMin) {
    const e = s + w.slotMin;
    if (!busy.some((b) => b.startMin < e && b.endMin > s)) out.push(s);
  }
  return out;
}

/** The next `count` (default OFFER_LOOKAHEAD_DAYS) calendar days on a ticked weekday, starting at
 *  `todayYmd` + `firstOffset` (default OFFER_FIRST_DAY_OFFSET). Pure (calendar dates, no clock). */
export function inspectionDaysFrom(todayYmd: string, days: Weekday[], opts?: { firstOffset?: number; count?: number }): string[] {
  const out: string[] = [];
  const ticked = new Set(days);
  const count = opts?.count ?? OFFER_LOOKAHEAD_DAYS;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayYmd) || !ticked.size || count <= 0) return out;
  const d = new Date(`${todayYmd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return out;
  d.setUTCDate(d.getUTCDate() + (opts?.firstOffset ?? OFFER_FIRST_DAY_OFFSET));
  for (let i = 0; i < 7 * count && out.length < count; i++) {
    if (ticked.has(WEEK[d.getUTCDay()])) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tue, Nov 24 · 9:00 AM": English, from ymd + hm only (no clock, no timezone). Pure. */
export function openTimeLabel(t: { ymd: string; hm: string }): string {
  const d = new Date(`${t.ymd}T00:00:00Z`);
  const m = /^(\d{1,2}):(\d{2})/.exec(t.hm ?? "");
  const h = m ? Number(m[1]) : 0;
  const time = `${h % 12 === 0 ? 12 : h % 12}:${m ? m[2] : "00"} ${h < 12 ? "AM" : "PM"}`;
  return `${DAY_NAMES[d.getUTCDay()]}, ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()} · ${time}`;
}

/** Every open start of one day already known to be an inspection day in the lookahead. */
async function openOnDay(supabase: SupabaseClient, orgId: string, settings: OrgSettings, ymd: string): Promise<OpenTime[]> {
  const d = healInspectionDays(settings.inspection_days);
  const win = windowMinutes(d);
  if (!win) return [];
  const tz = settings.timezone;
  const { dayStart, dayEnd } = companyDayBounds(ymd, tz);
  const work = workDayWindowHm(settings);
  const [held, busy] = await Promise.all([
    // The day's inspections, this company's only: a day holding per_day offers nothing.
    supabase
      .from("appointments")
      .select("id")
      .eq("org_id", orgId)
      .eq("type", "inspection")
      .eq("status", "scheduled")
      .gte("starts_at", dayStart.toISOString())
      .lt("starts_at", dayEnd.toISOString())
      .limit(d.per_day),
    readDayBusy(supabase, { dateISO: ymd, tz, dayStartHm: work.start, dayEndHm: work.end, orgId }),
  ]);
  if (held.error) throw new Error("openTimesOnDay: the inspections read failed");
  if ((held.data ?? []).length >= d.per_day) return [];
  return openStartsInWindow(busy, { ...win, slotMin: INSPECTION_SLOT_MIN }).flatMap((min) => {
    const hm = minutesToHm(min);
    const at = tzDateTimeUtc(ymd, hm, tz);
    return at ? [{ at, ymd, hm }] : [];
  });
}

/** The inspection days in the lookahead as of `now`, or [] when the offer is off. */
function lookahead(settings: OrgSettings, now: Date): string[] {
  if (!offersOpenTimes(settings)) return [];
  return inspectionDaysFrom(todayStrInTz(settings.timezone, now), healInspectionDays(settings.inspection_days).days);
}

/** EVERY open start on `ymd`; [] when that day is not offerable (weekday not ticked, sooner than
 *  today + 2, not among the next OFFER_LOOKAHEAD_DAYS inspection days, already holding per_day
 *  inspections, or the offer off). Throws on a failed read. */
export async function openTimesOnDay(supabase: SupabaseClient, orgId: string, settings: OrgSettings, ymd: string, now: Date = new Date()): Promise<OpenTime[]> {
  if (!orgId || !lookahead(settings, now).includes(ymd)) return [];
  return openOnDay(supabase, orgId, settings, ymd);
}

/** THE OFFER: the first OFFER_PER_DAY open starts of each of the first OFFER_MAX_DAYS days that have
 *  any, in order. Throws on a failed read. */
export async function openInspectionTimes(supabase: SupabaseClient, orgId: string, settings: OrgSettings, now: Date = new Date()): Promise<OpenTime[]> {
  if (!orgId) return [];
  const days = lookahead(settings, now);
  const perDay = await Promise.all(days.map((ymd) => openOnDay(supabase, orgId, settings, ymd)));
  return perDay.filter((t) => t.length > 0).slice(0, OFFER_MAX_DAYS).flatMap((t) => t.slice(0, OFFER_PER_DAY));
}
