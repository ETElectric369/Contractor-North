"use client";

// The crew planner's shared client machinery: which org week is on screen +
// that week's assignment rows (with optimistic patches), and the
// save-with-per-row-rollback used by BOTH the /timeclock board
// (crew-assignments.tsx) and the CrewWeekGrid. The two surfaces stay
// DECOUPLED — each holds its own week state — and reconcile through the
// SERVER: every save router.refresh()es, and each surface re-seeds its
// current-week rows from the fresh page props.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { useRouter } from "next/navigation";
import {
  orgWeekDayStrs,
  patchWeekRows,
  type CrewAssignmentRow,
  type CrewJobOpt,
  type ListWeekAssignments,
  type SetCrewDayAssignment,
} from "./crew-plan";

/** A row's previous explicit value, for per-row rollback (null = no row). */
export type PrevAssignment = {
  job_id: string;
  is_crew_lead: boolean;
  job?: CrewJobOpt | null;
} | null;

/** Week paging + the viewed week's rows. The CURRENT week (offset 0) always
 *  renders the server-provided `initialRows` (fresh after every
 *  router.refresh()); other weeks load through the listWeekAssignments action
 *  on demand — no client cache, so a revisited week is always fresh. */
export function useCrewWeek({
  initialRows,
  tz,
  weekStart,
  listWeekAssignments,
}: {
  initialRows: CrewAssignmentRow[];
  tz: string;
  weekStart: "sunday" | "monday";
  listWeekAssignments: ListWeekAssignments;
}) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [rows, setRows] = useState<CrewAssignmentRow[]>(initialRows);
  const [loading, setLoading] = useState(false);
  const [weekError, setWeekError] = useState<string | null>(null);

  // Latest values for the async paths — no stale closures.
  const offsetRef = useRef(0);
  const initialRef = useRef(initialRows);
  initialRef.current = initialRows;
  const seq = useRef(0);

  // After any save (from EITHER surface) router.refresh() delivers fresh
  // server rows as new props — re-seed ONLY while the current week is on
  // screen, so a paged-ahead view isn't clobbered with week-0 rows.
  useEffect(() => {
    if (offsetRef.current === 0) setRows(initialRows);
  }, [initialRows]);

  const days = useMemo(
    () => orgWeekDayStrs(weekOffset, tz, weekStart),
    [weekOffset, tz, weekStart],
  );

  /** Page the week by `delta` and return the NEW offset synchronously (the
   *  fetch, if any, continues in the background) — callers can recompute
   *  their selected day against the new week right away. */
  function go(delta: number): number {
    // ±52 sanity clamp — a year of paging either way is plenty.
    const next = Math.max(-52, Math.min(52, offsetRef.current + delta));
    if (next === offsetRef.current) return next;
    offsetRef.current = next;
    setWeekOffset(next);
    setWeekError(null);
    if (next === 0) {
      seq.current++; // invalidate any in-flight fetch
      setLoading(false);
      setRows(initialRef.current);
      return next;
    }
    const token = ++seq.current;
    setLoading(true);
    void (async () => {
      try {
        const res = await listWeekAssignments(next);
        if (seq.current !== token) return;
        if (res.ok) setRows(res.rows ?? []);
        else {
          setRows([]);
          setWeekError(res.error ?? "Could not load that week.");
        }
      } catch {
        if (seq.current !== token) return;
        setRows([]);
        setWeekError("No connection — try again.");
      } finally {
        if (seq.current === token) setLoading(false);
      }
    })();
    return next;
  }

  return { weekOffset, days, rows, setRows, loading, weekError, go };
}

/** Optimistic save with per-row rollback — the board's existing feel (patch
 *  immediately, roll just that row back + inline error on failure, refresh on
 *  success). `prev` is the row's CURRENT explicit value so a failure restores
 *  exactly that one line, never clobbering other in-flight edits. */
export function useAssignmentSaver({
  jobs,
  setRows,
  setCrewDayAssignment,
}: {
  jobs: CrewJobOpt[];
  setRows: Dispatch<SetStateAction<CrewAssignmentRow[]>>;
  setCrewDayAssignment: SetCrewDayAssignment;
}) {
  const router = useRouter();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jobsById = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);

  async function save(
    profileId: string,
    workDate: string,
    jobId: string | null,
    isCrewLead: boolean,
    prev: PrevAssignment,
  ) {
    const key = `${profileId}|${workDate}`;
    setBusyKey(key);
    setError(null);
    setRows((rs) =>
      patchWeekRows(
        rs,
        profileId,
        workDate,
        jobId
          ? { job_id: jobId, is_crew_lead: isCrewLead, job: jobsById.get(jobId) ?? null }
          : null,
      ),
    );
    try {
      const res = await setCrewDayAssignment({ profileId, workDate, jobId, isCrewLead });
      if (!res.ok) {
        setRows((rs) => patchWeekRows(rs, profileId, workDate, prev));
        setError(res.error ?? "Could not update the assignment.");
      } else {
        router.refresh();
      }
    } catch {
      setRows((rs) => patchWeekRows(rs, profileId, workDate, prev));
      setError("No connection — try again.");
    } finally {
      setBusyKey((k) => (k === key ? null : k));
    }
  }

  return { busyKey, error, save, jobsById };
}
