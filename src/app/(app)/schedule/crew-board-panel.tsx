import { createClient } from "@/lib/supabase/server";
import { getOrgSettings } from "@/lib/org-settings";
import { getSchedulePickerOptions, jobLabel } from "@/lib/schedule-options";
import { ACTIVE_JOB_STATUSES } from "@/lib/job-status";
import { tzDayStartUtc, todayStrInTz, prettyDay } from "@/lib/tz";
import { CrewBoard, type Lane, type CrewJob, type CrewAppt } from "./crew-board";

/** "Everyone's Day" — the all-crew board: one lane per person for the chosen day, showing every job
 *  and appointment assigned to them (plus an Unassigned lane), so you can see the whole crew's load
 *  side-by-side and spot who has room to take another job. Reads jobs.assigned_to (an array — a job
 *  can have several people) + appointments.assigned_to. Retired back on 2026-06-17; rebuilt here. */

function shiftYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`); // noon avoids any DST edge when stepping days
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export async function CrewBoardPanel({ date }: { date?: string }) {
  const supabase = await createClient();
  const { data: org } = await supabase.from("organizations").select("settings").limit(1).maybeSingle();
  const tz = getOrgSettings((org as any)?.settings).timezone;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ? (date as string) : todayStrInTz(tz);

  const dayStart = tzDayStartUtc(day, tz);
  const dayEnd = tzDayStartUtc(shiftYmd(day, 1), tz);
  const startIso = dayStart.toISOString();
  const endIso = dayEnd.toISOString();

  const [picker, { data: rangeJobs }, { data: segRows }, { data: appts }] = await Promise.all([
    getSchedulePickerOptions(supabase),
    // Jobs whose scheduled range overlaps the day (active only).
    supabase
      .from("jobs")
      .select("id, job_number, name, status, assigned_to, customers(name)")
      .in("status", ACTIVE_JOB_STATUSES as unknown as string[])
      .lte("scheduled_start", endIso)
      .or(`scheduled_end.gte.${startIso},and(scheduled_end.is.null,scheduled_start.gte.${startIso})`),
    // Segments that COVER this calendar day (date-only, tz-clean).
    supabase.from("job_schedule_segments").select("job_id").lte("start_date", day).gte("end_date", day),
    supabase
      .from("appointments")
      .select("id, type, title, starts_at, assigned_to, job_id, jobs(name), customers(name)")
      .gte("starts_at", startIso)
      .lt("starts_at", endIso)
      .neq("status", "cancelled")
      .order("starts_at"),
  ]);

  // SEGMENTS-FIRST (mirror the calendar, calendar-view.tsx): a job with multi-day segments is
  // scheduled ONLY on the days a segment covers. Its base scheduled_start/scheduled_end is stretched
  // min-start→max-end, so a non-contiguous job (Mon + Fri) would otherwise wrongly show on the Wed
  // GAP day and inflate that person's load — wrecking the board's "who has room today". So: a
  // segmented job appears only if a segment covers `day`; an unsegmented job uses the base-range
  // overlap the query already applied.
  const rangeArr = (rangeJobs ?? []) as any[];
  const coverIds = new Set((segRows ?? []).map((s: any) => s.job_id).filter(Boolean));
  const rangeIds = rangeArr.map((j) => j.id);
  let segmentedIds = new Set<string>();
  if (rangeIds.length) {
    const { data: anySeg } = await supabase.from("job_schedule_segments").select("job_id").in("job_id", rangeIds);
    segmentedIds = new Set((anySeg ?? []).map((s: any) => s.job_id));
  }
  const byId = new Map<string, any>();
  for (const j of rangeArr) {
    if (!segmentedIds.has(j.id) || coverIds.has(j.id)) byId.set(j.id, j);
  }
  // Defensive: a covering-segment job whose base range somehow didn't match the query — pull it in.
  const missing = [...coverIds].filter((id) => id && !byId.has(id));
  if (missing.length) {
    const { data: segJobs } = await supabase
      .from("jobs")
      .select("id, job_number, name, status, assigned_to, customers(name)")
      .in("id", missing)
      .in("status", ACTIVE_JOB_STATUSES as unknown as string[]);
    for (const j of segJobs ?? []) byId.set((j as any).id, j);
  }
  const jobs: CrewJob[] = [...byId.values()].map((j: any) => ({
    id: j.id,
    label: jobLabel(j),
    status: j.status,
    customer: j.customers?.name ?? null,
    assigned: (j.assigned_to ?? []).filter(Boolean),
  }));
  const appointments: CrewAppt[] = (appts ?? []).map((a: any) => ({
    id: a.id,
    title: a.title,
    type: a.type,
    time: new Date(a.starts_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }),
    jobId: a.job_id ?? null,
    who: a.jobs?.name ?? a.customers?.name ?? null,
    assigned: a.assigned_to ?? null,
  }));

  const members = (picker.staff ?? []) as { id: string; full_name: string | null }[];
  const memberIds = new Set(members.map((m) => m.id));
  const lanes: Lane[] = members.map((m) => ({
    id: m.id,
    name: m.full_name ?? "Unnamed",
    jobs: jobs.filter((j) => j.assigned.includes(m.id)),
    appts: appointments.filter((a) => a.assigned === m.id),
  }));
  // Unassigned = nobody on the CURRENT roster is on it. Catches empty assignments AND ones left on a
  // former/inactive employee — those must still show here, never silently vanish from the board.
  const unassigned: Lane = {
    id: "__unassigned__",
    name: "Unassigned",
    jobs: jobs.filter((j) => !j.assigned.some((id) => memberIds.has(id))),
    appts: appointments.filter((a) => !a.assigned || !memberIds.has(a.assigned)),
  };

  return (
    <CrewBoard
      dayLabel={prettyDay(day)}
      isToday={day === todayStrInTz(tz)}
      prevHref={`/schedule?view=crew&date=${shiftYmd(day, -1)}`}
      nextHref={`/schedule?view=crew&date=${shiftYmd(day, 1)}`}
      todayHref="/schedule?view=crew"
      lanes={lanes}
      unassigned={unassigned}
    />
  );
}
