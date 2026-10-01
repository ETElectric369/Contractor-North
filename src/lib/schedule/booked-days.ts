/**
 * WHICH DAYS WERE BOOKED (Wave 2, SV-ghost). A GHOST is a job's past day with clocked time and no
 * booking that day: 17 of 33 worked job-days in 45 days had no block. "Booked" is read from the RAW
 * data, never from what the grid draws (the grid's days are cut by the person filter, and a job hidden
 * by it is not a job nobody booked):
 *
 *   a segment of that job covering the day (a job's days are its segments when it has any);
 *   its listed scheduled_start/_end span, when it has no segments (each end on the company's day);
 *   a visit on that job, not cancelled, starting or spanning that day (its days after the first skip
 *   weekends, as the grid draws them), absorbed ones included (the job took their slot).
 *   A phone call on the job is not a booking of the work (a call is not a stop: it is pinned, never a
 *   block), so a worked day with only a call on it is still worked, not booked.
 *
 * The day rules live here once: the calendar's grid expands a job's days and a visit's days with these
 * same functions, so a day the grid draws is always a day this calls booked.
 */
import { todayStrInTz } from "@/lib/tz";

const isYmd = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const addDay = (ymd: string, n = 1) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekday = (ymd: string) => new Date(`${ymd}T12:00:00Z`).getUTCDay();

/** Every day from `start` to `end` (YYYY-MM-DD, inclusive), at most `cap` of them (a runaway range can't
 *  hang a render). An end before its start is its start. */
export function dayRange(start: string, end: string, cap = 540): string[] {
  if (!isYmd(start)) return [];
  const last = isYmd(end) && end > start ? end : start;
  const out: string[] = [];
  for (let d = start; d <= last && out.length < cap; d = addDay(d)) out.push(d);
  return out;
}

/** A visit's days: its first day always (a visit booked on a Saturday is a Saturday visit), then every
 *  WORKING day through its last (the span was sized in working days), at most 60 more. */
export function visitDays(first: string, last: string | null): string[] {
  if (!isYmd(first)) return [];
  const out = [first];
  if (!isYmd(last) || last <= first) return out;
  let d = first;
  for (let i = 0; i < 60; i++) {
    d = addDay(d);
    if (d > last) break;
    const w = weekday(d);
    if (w === 0 || w === 6) continue;
    out.push(d);
  }
  return out;
}

type Seg = { job_id: string; start_date: string; end_date: string };
type ListedJob = { id: string; scheduled_start: string | null; scheduled_end: string | null };
type Visit = { job_id: string | null; starts_at: string | null; ends_at: string | null; status?: string | null; type?: string | null };

/** "jobId|YYYY-MM-DD" for every day a job was booked (see the header), from the raw rows. */
export function bookedKeys(p: {
  segments: readonly Seg[];
  jobs: readonly ListedJob[];
  appointments: readonly Visit[];
  tz: string;
}): Set<string> {
  const out = new Set<string>();
  const withSegments = new Set<string>();
  for (const s of p.segments ?? []) {
    if (!s?.job_id) continue;
    withSegments.add(s.job_id);
    for (const d of dayRange(s.start_date, s.end_date)) out.add(`${s.job_id}|${d}`);
  }
  for (const j of p.jobs ?? []) {
    if (!j?.id || withSegments.has(j.id) || !j.scheduled_start) continue;
    const first = todayStrInTz(p.tz, new Date(j.scheduled_start));
    const last = j.scheduled_end ? todayStrInTz(p.tz, new Date(j.scheduled_end)) : first;
    for (const d of dayRange(first, last)) out.add(`${j.id}|${d}`);
  }
  for (const a of p.appointments ?? []) {
    if (!a?.job_id || !a.starts_at || a.status === "cancelled" || a.type === "call") continue;
    const first = todayStrInTz(p.tz, new Date(a.starts_at));
    const last = a.ends_at && new Date(a.ends_at).getTime() > new Date(a.starts_at).getTime() ? todayStrInTz(p.tz, new Date(a.ends_at)) : first;
    for (const d of visitDays(first, last)) out.add(`${a.job_id}|${d}`);
  }
  return out;
}
