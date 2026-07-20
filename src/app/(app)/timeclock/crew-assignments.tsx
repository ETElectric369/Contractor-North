"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Star, Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { todayStrInTz } from "@/lib/tz";
import {
  assignmentJobLabel,
  dayParts,
  orgWeekDayStrs,
  weekRangeLabel,
  type CrewAssignmentRow,
  type CrewAutoPlan,
  type CrewJobOpt,
  type ListWeekAssignments,
  type SetCrewDayAssignment,
} from "./crew-plan";
import { useAssignmentSaver, useCrewWeek, type PrevAssignment } from "./use-crew-week";

interface MemberRow {
  id: string;
  full_name: string | null;
}

/**
 * The office's crew-assignment PLANNER on /timeclock (staff only): a day strip
 * (the org week, week_start honored, arrows page ±1 week) and, for the selected
 * day, every active member on one line — name · job Select · ★ crew-leader
 * checkbox. Each change saves immediately (optimistic, per-row rollback +
 * inline error on failure) through the setCrewDayAssignment action, which
 * upserts crew_day_assignments and notifies the member.
 *
 * PRECEDENCE: a day row WINS over every other surface — the tech's Clock In
 * that day lands on it, My Day shows it, and the CrewWeekGrid mirrors it. When
 * a day has no explicit row, the line falls back to `autoPlan`'s inference for
 * that day — TODAY = the pickMemberCurrentJob pick a job-less Clock In would
 * resolve to, later days of the current week = the schedule — marked with an
 * "auto" chip; clearing a row returns to that inference. Past days and paged
 * weeks show explicit rows only. Multiple leaders per day are fine (different
 * crews) — plain checkboxes.
 */
export function CrewAssignments({
  members,
  jobs,
  autoPlan,
  weekRows,
  tz,
  weekStart,
  jobCodesEnabled = true,
  setCrewDayAssignment,
  listWeekAssignments,
}: {
  members: MemberRow[];
  jobs: CrewJobOpt[];
  /** memberId → dayStr → inferred jobId for the current week (see CrewAutoPlan). */
  autoPlan: CrewAutoPlan;
  /** crew_day_assignments rows for the CURRENT org week (page-fetched; other
   *  weeks load through listWeekAssignments). */
  weekRows: CrewAssignmentRow[];
  tz: string;
  weekStart: "sunday" | "monday";
  /** Org setting timeclock_job_codes — false labels jobs customer · address. */
  jobCodesEnabled?: boolean;
  setCrewDayAssignment: SetCrewDayAssignment;
  listWeekAssignments: ListWeekAssignments;
}) {
  // Computed once per mount — stable across the session (the strip's arrows
  // move the WEEK; "today" itself only moves on a fresh load).
  const [todayStr] = useState(() => todayStrInTz(tz));
  const { weekOffset, days, rows, setRows, loading, weekError, go } = useCrewWeek({
    initialRows: weekRows,
    tz,
    weekStart,
    listWeekAssignments,
  });
  const { busyKey, error, save, jobsById } = useAssignmentSaver({
    jobs,
    setRows,
    setCrewDayAssignment,
  });
  const [selectedDay, setSelectedDay] = useState(todayStr);

  // Keep the selected WEEKDAY while paging weeks (set Monday, page ahead —
  // still on Monday), so "plan the whole week, step to the next" flows.
  function goWeek(delta: number) {
    const idx = Math.max(0, days.indexOf(selectedDay));
    const nextOffset = go(delta);
    const nextDays = orgWeekDayStrs(nextOffset, tz, weekStart);
    setSelectedDay(nextDays[idx] ?? nextDays[0]);
  }

  // The selected day's explicit rows, by member.
  const dayRows = useMemo(() => {
    const m = new Map<string, CrewAssignmentRow>();
    for (const r of rows) if (r.work_date === selectedDay) m.set(r.profile_id, r);
    return m;
  }, [rows, selectedDay]);

  if (!members.length) return null;

  return (
    <Card>
      <CardContent className="py-5">
        <div className="mb-1 flex items-center justify-between gap-2">
          <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold text-slate-900">
            <Users className="h-4 w-4 shrink-0 text-slate-400" /> Crew assignments
          </h3>
          <span className="shrink-0 text-xs font-medium text-slate-500">
            {weekOffset === 0 ? "This week" : weekRangeLabel(days)}
          </span>
        </div>
        <p className="mb-3 text-xs text-slate-500">
          Pick a day, set each member&apos;s job and ★ crew leader. The day&apos;s assignment
          wins — Clock In lands on it automatically.
        </p>

        {/* Day strip: 7 org-week chips + week arrows. */}
        <div className="mb-3 flex items-center gap-1">
          <button
            type="button"
            onClick={() => goWeek(-1)}
            aria-label="Previous week"
            className="shrink-0 rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="flex min-w-0 flex-1 gap-1">
            {days.map((ds) => {
              const { dow, dom } = dayParts(ds);
              const sel = ds === selectedDay;
              const isToday = ds === todayStr;
              return (
                <button
                  key={ds}
                  type="button"
                  onClick={() => setSelectedDay(ds)}
                  aria-pressed={sel}
                  aria-label={`Plan ${ds}`}
                  className={`min-w-0 flex-1 rounded-lg border px-0.5 py-1 text-center leading-tight ${
                    sel
                      ? "border-brand bg-brand text-white"
                      : isToday
                        ? "border-brand/40 text-brand hover:bg-brand-light/20"
                        : "border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  <span className="block truncate text-[9px] font-medium uppercase tracking-wide opacity-80">
                    {dow}
                  </span>
                  <span className="block text-xs font-semibold">{dom}</span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => goWeek(1)}
            aria-label="Next week"
            className="shrink-0 rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>

        {/* One row per member: name · job Select · ★ lead. Dimmed while a
            paged week's rows are still loading (no edits against stale rows).
            @container (the cn-v524 pattern): in a narrow CONTAINER — a phone,
            or the desktop right column — the name takes its own line and the
            controls get the full width below it; viewport breakpoints lie in
            the fine-pointer shell band, so this keys off actual width. */}
        <div
          className={`@container space-y-2 ${loading ? "pointer-events-none opacity-60" : ""}`}
        >
          {members.map((m) => {
            const explicit = dayRows.get(m.id) ?? null;
            // No explicit row → the day's inference (today = clock-in pick,
            // future = schedule; past days and paged weeks have no entries).
            const autoJobId = !explicit ? autoPlan[m.id]?.[selectedDay] : undefined;
            const value = explicit?.job_id ?? autoJobId ?? "";
            const isAuto = !explicit && !!autoJobId;
            const busy = busyKey === `${m.id}|${selectedDay}`;
            const prev: PrevAssignment = explicit
              ? { job_id: explicit.job_id, is_crew_lead: explicit.is_crew_lead, job: explicit.job }
              : null;
            const lead = explicit?.is_crew_lead ?? false;
            return (
              <div key={m.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="w-full shrink-0 truncate text-sm font-medium text-slate-700 @[26rem]:w-24">
                  {m.full_name ?? "—"}
                </span>
                <Select
                  value={value}
                  onChange={(e) =>
                    void save(m.id, selectedDay, e.target.value || null, lead, prev)
                  }
                  disabled={busy}
                  className="h-9 min-w-0 flex-1"
                  aria-label={`Job for ${m.full_name ?? "member"} on ${selectedDay}`}
                >
                  <option value="">— No job —</option>
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {assignmentJobLabel(j, jobCodesEnabled)}
                    </option>
                  ))}
                  {/* A planned job that later left the active list still shows
                      truthfully instead of rendering as "— No job —". */}
                  {value && !jobsById.has(value) && (
                    <option value={value}>
                      {explicit?.job
                        ? assignmentJobLabel(explicit.job, jobCodesEnabled)
                        : "Assigned job"}
                    </option>
                  )}
                </Select>
                {isAuto && (
                  <span
                    title={
                      selectedDay === todayStr
                        ? "No day assignment yet — this is the job a Clock In would infer today. Pick a job (or tap ★) to pin it for the day."
                        : "No day assignment yet — the schedule puts them here. Pick a job (or tap ★) to pin it for the day."
                    }
                    className="shrink-0 rounded border border-dashed border-slate-300 bg-slate-50 px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-slate-500"
                  >
                    auto
                  </span>
                )}
                <label
                  title="Crew leader for this day — files the clock-out daily report. More than one leader is fine (separate crews)."
                  className={`flex shrink-0 cursor-pointer items-center gap-1 ${!value ? "cursor-not-allowed opacity-40" : ""}`}
                >
                  <input
                    type="checkbox"
                    checked={lead}
                    disabled={!value || busy}
                    onChange={(e) =>
                      void save(m.id, selectedDay, value || null, e.target.checked, prev)
                    }
                    className="h-4 w-4 rounded border-slate-300 text-brand"
                    aria-label={`Crew leader: ${m.full_name ?? "member"} on ${selectedDay}`}
                  />
                  <Star
                    className={`h-3.5 w-3.5 ${lead ? "fill-amber-400 text-amber-500" : "text-slate-300"}`}
                  />
                </label>
                {busy && (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-slate-400" />
                )}
              </div>
            );
          })}
        </div>
        {loading && (
          <p className="mt-2 flex items-center gap-1.5 text-xs text-slate-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading week…
          </p>
        )}
        {(error ?? weekError) && (
          <p className="mt-2 text-xs text-red-600">{error ?? weekError}</p>
        )}
      </CardContent>
    </Card>
  );
}
