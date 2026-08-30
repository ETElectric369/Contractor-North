"use client";

import { useMemo, useState } from "react";
import { TimeOffButton } from "./time-off-button";
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
 * The crew WEEK grid under the /timeclock panel (staff only — render inside
 * the page's isStaff branch): the org week as columns (week_start honored,
 * arrows page ±1 week), active members as rows, each cell the member's
 * assigned job for that day — a short-label pill in the member's /timecards
 * color, ★ = crew leader. An EMPTY cell means nobody has decided yet — the grid never
 * guesses, because a truthful blank beats a confident suggestion that saves nothing.
 * inference as a muted DASHED pill instead of blank (today = the job a
 * board's best guess (schedule + active jobs — NOT a promise about what a job-less
 * Clock In resolves to: resolveTechJobToday's fallback tiers differ), future days = the
 * schedule) — the old board always showed where everyone was, and a brand-new
 * planner with zero explicit rows must not read as "the assignments vanished".
 * Never time entries — that's /timecards. The header/column look deliberately
 * matches the /timecards TimeGrid; assignments are day-scoped (no hour axis),
 * so this is a sibling, not a TimeGrid reuse.
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
  /** memberId → dayStr → inferred jobId for the current week (see CrewAutoPlan). */
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
        <span className="text-sm font-semibold text-slate-900">Crew</span>
        <span className="hidden text-xs text-slate-400 sm:inline">
          tap a day to put someone on a job · ★ leads
        </span>
        <TimeOffButton members={members} />
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {loading && <Loader2 className="h-4 w-4 animate-spin text-slate-400" />}
          <button
            type="button"
            onClick={() => goWeek(-1)}
            aria-label="Previous week"
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
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
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </span>
      </div>

      {/* The grid — header/column look matching the /timecards TimeGrid. Day
          columns floor at 60px (not TimeGrid's 92 — these pills carry a short
          tag, not time spans) so the whole week FITS the lg left column
          (~520px) without a sideways scroll; narrower containers scroll INSIDE
          this overflow-x wrapper, the /timecards pattern. */}
      <div className="overflow-x-auto">
        <div
          style={{ minWidth: 96 + days.length * 60 }}
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
                  {/* Today = bold brand + the tinted column below. No "today"
                      text tag — it doesn't fit the 60px column floor. */}
                  <span className={isToday ? "font-bold text-brand" : ""}>
                    {dow} {dom}
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
                // NO SUGGESTIONS (cn-v590). An empty cell means nobody has decided — which is
                // TRUE, and a truthful blank beats a confident guess. The board used to draw the
                // schedule's opinion here in a dashed pill that saved nothing and vanished on
                // refresh; it made the grid unreadable ("is that planned or not?") and made
                // plan-vs-actual impossible, because you cannot be wrong about a guess.
                return (
                  <button
                    key={ds}
                    type="button"
                    onClick={() => setSel(isSel ? null : { profileId: m.id, dayStr: ds })}
                    title={
                      row?.kind === "off"
                        ? `${m.full_name ?? "Member"} · ${dayTag(ds)}: off`
                        : row?.job
                          ? `${m.full_name ?? "Member"} · ${dayTag(ds)}: ${assignmentJobLabel(row.job, jobCodesEnabled)}${row.is_crew_lead ? " · crew lead" : ""}`
                          : `Tap to put ${m.full_name ?? "someone"} on a job · ${dayTag(ds)}`
                    }
                    aria-label={`${m.full_name ?? "Member"}, ${dayTag(ds)}`}
                    className={`group min-h-[34px] min-w-0 flex-1 p-0.5 text-left ${colBorder} ${
                      isToday ? "bg-brand-light/15" : ""
                    } ${isSel ? "ring-2 ring-inset ring-brand" : ""} hover:bg-slate-50`}
                  >
                    {row?.kind === "off" ? (
                      // A day somebody is deliberately away. Grey and plain — it is a real
                      // decision, so it must not look like an empty cell, but it isn't work.
                      <span className="flex items-center justify-center rounded-md bg-slate-100 px-1 py-0.5 text-[10px] font-semibold uppercase leading-tight tracking-wide text-slate-500">
                        off
                      </span>
                    ) : row ? (
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
            {/* Two decisions, not one ambiguous blank: forget the plan, or say they're away. */}
            <option value="">— Not set —</option>
            <option value="__off__">— Off (vacation / not working) —</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {assignmentJobLabel(j, jobCodesEnabled)}
              </option>
            ))}
            {/* A pinned job that has since left the active list — say so, rather than letting the
                cell silently read as unset. An OFF row names no job, so it isn't this case. */}
            {selRow?.job_id && !jobsById.has(selRow.job_id) && (
              <option value={selRow.job_id}>
                {selRow.job ? assignmentJobLabel(selRow.job, jobCodesEnabled) : "Job (no longer listed)"}
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
