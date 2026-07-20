"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, Star, X } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { pillColorForPerson } from "@/lib/employee-color";
import { todayStrInTz } from "@/lib/tz";
import {
  assignmentJobLabel,
  dayParts,
  dayTag,
  shortJobTag,
  weekRangeLabel,
  type CrewAssignmentRow,
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
 * The crew WEEK grid under the /timeclock panel (staff only — render inside
 * the page's isStaff branch): the org week as columns (week_start honored,
 * arrows page ±1 week), active members as rows, each cell the member's
 * assigned job for that day — a short-label pill in the member's /timecards
 * color, ★ = crew leader — and quietly blank when nothing is planned. Shows
 * ONLY crew_day_assignments rows (never time entries — that's /timecards).
 * The header/column look deliberately matches the /timecards TimeGrid;
 * assignments are day-scoped (no hour axis), so this is a sibling, not a
 * TimeGrid reuse.
 *
 * Tapping a cell opens an INLINE EDITOR BAR under the grid (job Select + ★
 * lead) — chosen over remote-selecting the board because it keeps the two
 * surfaces decoupled: both save through the same setCrewDayAssignment action
 * and reconcile via router.refresh(). Scrolls horizontally in its own
 * container on phones, like every other week grid.
 */
export function CrewWeekGrid({
  members,
  jobs,
  weekRows,
  tz,
  weekStart,
  jobCodesEnabled = true,
  setCrewDayAssignment,
  listWeekAssignments,
}: {
  members: MemberRow[];
  jobs: CrewJobOpt[];
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
  // The cell being edited in the bar below the grid.
  const [sel, setSel] = useState<{ profileId: string; dayStr: string } | null>(null);

  const byKey = useMemo(() => {
    const m = new Map<string, CrewAssignmentRow>();
    for (const r of rows) m.set(`${r.profile_id}|${r.work_date}`, r);
    return m;
  }, [rows]);

  function goWeek(delta: number) {
    go(delta);
    setSel(null); // the edited cell belongs to the old week
  }

  if (!members.length) return null;

  const colBorder = "border-l border-l-slate-100";
  const selRow = sel ? (byKey.get(`${sel.profileId}|${sel.dayStr}`) ?? null) : null;
  const selMember = sel ? (members.find((m) => m.id === sel.profileId) ?? null) : null;
  const selBusy = sel ? busyKey === `${sel.profileId}|${sel.dayStr}` : false;
  const selPrev: PrevAssignment = selRow
    ? { job_id: selRow.job_id, is_crew_lead: selRow.is_crew_lead, job: selRow.job }
    : null;

  return (
    <Card className="mt-6 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-2.5">
        <span className="text-sm font-semibold text-slate-900">Crew week</span>
        <span className="hidden text-xs text-slate-400 sm:inline">
          who&apos;s planned where · ★ leads
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {loading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
          <button
            type="button"
            onClick={() => goWeek(-1)}
            aria-label="Previous week"
            className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[104px] text-center text-xs font-medium text-slate-600">
            {weekOffset === 0 ? "This week" : weekRangeLabel(days)}
          </span>
          <button
            type="button"
            onClick={() => goWeek(1)}
            aria-label="Next week"
            className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </span>
      </div>

      {/* The grid — header/column look matching the /timecards TimeGrid. */}
      <div className="overflow-x-auto">
        <div
          style={{ minWidth: 96 + days.length * 84 }}
          className={loading ? "pointer-events-none opacity-60" : ""}
        >
          <div className="flex border-b border-slate-100">
            <div className="w-24 shrink-0" />
            {days.map((ds) => {
              const isToday = ds === todayStr;
              const { dow, dom } = dayParts(ds);
              return (
                <div
                  key={ds}
                  className={`min-w-0 flex-1 truncate px-1 py-1.5 text-center text-xs font-medium text-slate-600 ${colBorder}`}
                >
                  <span className={isToday ? "font-bold text-brand" : ""}>
                    {dow} {dom}
                    {isToday && (
                      <span className="ml-1 text-[9px] font-semibold uppercase tracking-wide">
                        today
                      </span>
                    )}
                  </span>
                </div>
              );
            })}
          </div>

          {members.map((m) => (
            <div key={m.id} className="flex border-b border-slate-50 last:border-b-0">
              <div className="flex w-24 shrink-0 items-center px-2 py-1">
                <span className="truncate text-xs font-medium text-slate-700">
                  {m.full_name ?? "—"}
                </span>
              </div>
              {days.map((ds) => {
                const row = byKey.get(`${m.id}|${ds}`);
                const isSel = sel?.profileId === m.id && sel?.dayStr === ds;
                const isToday = ds === todayStr;
                return (
                  <button
                    key={ds}
                    type="button"
                    onClick={() => setSel(isSel ? null : { profileId: m.id, dayStr: ds })}
                    title={
                      row?.job
                        ? `${m.full_name ?? "Member"} · ${dayTag(ds)}: ${assignmentJobLabel(row.job, jobCodesEnabled)}${row.is_crew_lead ? " · crew lead" : ""}`
                        : `Assign ${m.full_name ?? "member"} · ${dayTag(ds)}`
                    }
                    aria-label={`${m.full_name ?? "Member"}, ${dayTag(ds)}`}
                    className={`group min-h-[34px] min-w-0 flex-1 p-0.5 text-left ${colBorder} ${
                      isToday ? "bg-brand-light/15" : ""
                    } ${isSel ? "ring-2 ring-inset ring-brand" : ""} hover:bg-slate-50`}
                  >
                    {row ? (
                      <span
                        className={`flex items-center gap-0.5 rounded-md border px-1 py-0.5 text-[10px] font-medium leading-tight shadow-sm ${pillColorForPerson(m.id).pill}`}
                      >
                        {row.is_crew_lead && (
                          <Star className="h-2.5 w-2.5 shrink-0 fill-amber-400 text-amber-500" />
                        )}
                        <span className="truncate">
                          {shortJobTag(row.job, jobCodesEnabled)}
                        </span>
                      </span>
                    ) : (
                      <span className="block text-center text-sm leading-6 text-slate-300 opacity-0 group-hover:opacity-100">
                        +
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Inline editor bar for the tapped cell — the same Select + ★ lead the
          board uses, saving through the same action. */}
      {sel && (
        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 bg-slate-50/60 px-4 py-2.5">
          <span className="shrink-0 text-xs font-semibold text-slate-700">
            {selMember?.full_name ?? "—"} · {dayTag(sel.dayStr)}
          </span>
          <Select
            value={selRow?.job_id ?? ""}
            onChange={(e) =>
              void save(
                sel.profileId,
                sel.dayStr,
                e.target.value || null,
                selRow?.is_crew_lead ?? false,
                selPrev,
              )
            }
            disabled={selBusy}
            className="h-9 min-w-[160px] flex-1"
            aria-label={`Job for ${selMember?.full_name ?? "member"} on ${sel.dayStr}`}
          >
            <option value="">— No job —</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {assignmentJobLabel(j, jobCodesEnabled)}
              </option>
            ))}
            {selRow && !jobsById.has(selRow.job_id) && (
              <option value={selRow.job_id}>
                {selRow.job ? assignmentJobLabel(selRow.job, jobCodesEnabled) : "Assigned job"}
              </option>
            )}
          </Select>
          <label
            title="Crew leader for this day — files the clock-out daily report."
            className={`flex shrink-0 cursor-pointer items-center gap-1 text-xs text-slate-600 ${!selRow ? "cursor-not-allowed opacity-40" : ""}`}
          >
            <input
              type="checkbox"
              checked={selRow?.is_crew_lead ?? false}
              disabled={!selRow || selBusy}
              onChange={(e) =>
                selRow &&
                void save(sel.profileId, sel.dayStr, selRow.job_id, e.target.checked, selPrev)
              }
              className="h-4 w-4 rounded border-slate-300 text-brand"
              aria-label={`Crew leader: ${selMember?.full_name ?? "member"} on ${sel.dayStr}`}
            />
            <Star
              className={`h-3.5 w-3.5 ${selRow?.is_crew_lead ? "fill-amber-400 text-amber-500" : "text-slate-300"}`}
            />
            Lead
          </label>
          {selBusy && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-slate-400" />}
          <button
            type="button"
            onClick={() => setSel(null)}
            aria-label="Close editor"
            className="ml-auto shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {(error ?? weekError) && (
        <p className="border-t border-slate-100 px-4 py-2 text-xs text-red-600">
          {error ?? weekError}
        </p>
      )}
    </Card>
  );
}
