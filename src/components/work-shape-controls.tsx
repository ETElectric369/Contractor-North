"use client";

import { useState } from "react";
import {
  DURATION_BUCKETS,
  durationLabel,
  KIND_LABEL,
  parseDuration,
  WORK_KINDS,
} from "@/lib/schedule/work-shape";

/**
 * KIND? · HOW LONG? — the two questions, one control, every surface.
 *
 * Erik: "what im looking for is the drop down menu on the planner/schedule page for each job
 * saying (Kind?) and (How Long?) this is what needs to be on the lead itself next to the contacted
 * drop down menu, thats the critical path... it carries through to the schedule where it gets done
 * and carries the same dropdown menu designation."
 *
 * "The same" is load-bearing. Two hand-copied versions of these dropdowns is exactly how "Phone
 * call" got offered on one surface and refused by another (the WORK_KINDS lesson) — so the lead
 * row and the schedule rail render THIS component, and a kind or a bucket added here exists
 * everywhere at once.
 */
export function WorkShapeControls({
  workKind,
  plannedMinutes,
  showKind = true,
  disabled,
  onPatch,
}: {
  workKind: string | null;
  plannedMinutes: number | null;
  /** A job is a job — its callers hide the kind select. */
  showKind?: boolean;
  disabled?: boolean;
  onPatch: (patch: { workKind?: string; plannedMinutes?: number | null }) => void;
}) {
  const [custom, setCustom] = useState<string | null>(null); // null = closed

  function saveCustom() {
    const minutes = parseDuration(custom ?? "");
    if (!minutes) return; // the preview already says "can't read that" — no silent round
    setCustom(null);
    onPatch({ plannedMinutes: minutes });
  }

  const offList =
    !!plannedMinutes && !DURATION_BUCKETS.some((b) => b.minutes === plannedMinutes);

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {showKind && (
        <select
          value={workKind ?? ""}
          onChange={(e) => onPatch({ workKind: e.target.value })}
          disabled={disabled}
          className="h-7 rounded-md border border-slate-200 bg-white px-1.5 text-xs disabled:opacity-50"
          aria-label="What kind of work"
        >
          <option value="">Kind?</option>
          {WORK_KINDS.map((k) => (
            <option key={k} value={k}>{KIND_LABEL[k]}</option>
          ))}
        </select>
      )}
      <select
        value={plannedMinutes ? String(plannedMinutes) : ""}
        onChange={(e) => {
          if (e.target.value === "custom") {
            setCustom("");
            return;
          }
          setCustom(null);
          onPatch({ plannedMinutes: Number(e.target.value) || null });
        }}
        disabled={disabled}
        className="h-7 rounded-md border border-slate-200 bg-white px-1.5 text-xs disabled:opacity-50"
        aria-label="How long will it take"
      >
        <option value="">How long?</option>
        {/* A stored size that matches no bucket still shows — a select whose value matches no
            option falls back to the first, and the card would call itself unsized. */}
        {offList && <option value={String(plannedMinutes)}>{durationLabel(plannedMinutes)}</option>}
        {DURATION_BUCKETS.map((b) => (
          <option key={b.minutes} value={String(b.minutes)}>{b.label}</option>
        ))}
        <option value="custom">Custom…</option>
      </select>
      {custom !== null && (
        <>
          <input
            autoFocus
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); saveCustom(); }
              if (e.key === "Escape") setCustom(null);
            }}
            placeholder="45m, 1.5h, 2d"
            aria-label="Type how long it will take"
            className="h-7 w-24 rounded-md border border-brand/60 px-1.5 text-xs"
          />
          <button
            type="button"
            onClick={saveCustom}
            className="h-7 rounded-md bg-brand px-2 text-xs font-semibold text-white"
          >
            Set
          </button>
          <span className="text-xs text-slate-400">
            {custom.trim()
              ? parseDuration(custom)
                ? durationLabel(parseDuration(custom))
                : "can't read that"
              : ""}
          </span>
        </>
      )}
    </span>
  );
}
