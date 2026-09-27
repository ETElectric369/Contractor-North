"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  COME_BACK_PICKS,
  DEFAULT_COME_BACK,
  checkComeBackDay,
  comeBackDay,
  shortDay,
  type ComeBackPick,
  type ComeBackWhen,
} from "@/lib/come-back-days";

/**
 * THE COME-BACK PICKER (NY-hold, 0366): why it waits, and the day it comes back. One control for
 * every wait in the app: putting a job on hold here ("Hold It"), and, next wave, a Needs You row's
 * "Snooze" and "Still Waiting" (lane 5). Erik: "too quiet gets things lost", so there is no "No
 * Date": In A Week is picked until someone picks another day.
 *
 *   Why?        "Waiting on the permit". In hold mode (requireWhy) the button waits for words, and the
 *               line under it says why: the reason IS the reminder the job comes back with (setJobHold
 *               refuses a hold with no reason). Snooze and Still Waiting show it only when no reason is
 *               saved yet (askWhy), and never require it.
 *   the chips   Tomorrow · Mon · In A Week (picked) · Pick A Day (a date, today or later).
 *   the button  its words are the caller's: Hold It, Snooze, Still Waiting.
 *
 * WHOSE TODAY. Given `todayStr` (the company's today, from the server) the picker works the day out
 * itself, says it ("Comes back Oct 3"), refuses a past one, and sends the date. Without it, it sends
 * the chip's name and the server works it out in the company's timezone: a phone's own clock never
 * decides the company's day. Every target is 44px.
 */
export const SAY_WHY = "Say why: it's the reminder when the job comes back";

const CHIP: Record<ComeBackPick, string> = { tomorrow: "Tomorrow", monday: "Mon", week: "In A Week" };

type Choice = ComeBackPick | "date";

export type ComeBackSubmit = { why: string; when: ComeBackWhen };

export function ComeBackPicker({
  label,
  onSubmit,
  requireWhy = false,
  askWhy = false,
  initialWhy,
  todayStr,
  pending = false,
  error,
  onCancel,
  autoFocus = false,
}: {
  /** The button's words: "Hold It", "Snooze", "Still Waiting". */
  label: string;
  onSubmit: (v: ComeBackSubmit) => void | Promise<void>;
  /** Hold mode: Why? is shown and the button waits for it. */
  requireWhy?: boolean;
  /** Show Why? without requiring it (a Snooze on a wait with no reason saved yet). */
  askWhy?: boolean;
  initialWhy?: string | null;
  /** The company's today (YYYY-MM-DD). Absent: the chip's name goes to the server. */
  todayStr?: string;
  pending?: boolean;
  /** The caller's refusal, shown here in words. */
  error?: string | null;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [why, setWhy] = useState(initialWhy ?? "");
  const [choice, setChoice] = useState<Choice>(DEFAULT_COME_BACK);
  const [date, setDate] = useState("");
  const showWhy = requireWhy || askWhy;
  const needsWords = requireWhy && !why.trim();

  // The day the choice means, when the company's today is known here.
  const picked =
    choice === "date"
      ? todayStr
        ? date
          ? checkComeBackDay(todayStr, date)
          : null
        : date
          ? ({ ok: true, day: date } as const)
          : null
      : todayStr
        ? ({ ok: true, day: comeBackDay(todayStr, choice) } as const)
        : null;
  const dateRefused = picked && !picked.ok ? picked.error : null;
  const noDateYet = choice === "date" && !date;
  const disabled = pending || needsWords || noDateYet || !!dateRefused;

  function submit() {
    if (disabled) return;
    const when: ComeBackWhen =
      picked && picked.ok ? { date: picked.day } : choice === "date" ? { date } : { pick: choice };
    void onSubmit({ why: why.trim(), when });
  }

  const chip = (on: boolean) =>
    `inline-flex h-11 items-center rounded-lg border px-3 text-sm font-medium transition-colors ${
      on ? "border-brand bg-brand text-white" : "border-slate-300 bg-white text-slate-700 hover:border-brand/60"
    }`;

  return (
    <div className="w-full space-y-2" role="group" aria-label="When it comes back">
      {showWhy && (
        <div>
          <input
            id={`${id}-why`}
            autoFocus={autoFocus}
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
              if (e.key === "Escape" && onCancel) onCancel();
            }}
            placeholder="Waiting on the permit"
            aria-label="Why?"
            className="h-11 w-full rounded-lg border border-slate-300 px-3 text-sm focus-visible:border-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          />
          {needsWords && <p className="mt-1 text-xs text-slate-500">{SAY_WHY}</p>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        {COME_BACK_PICKS.map((p) => (
          <button key={p} type="button" aria-pressed={choice === p} onClick={() => setChoice(p)} className={chip(choice === p)}>
            {CHIP[p]}
          </button>
        ))}
        <button type="button" aria-pressed={choice === "date"} onClick={() => setChoice("date")} className={chip(choice === "date")}>
          Pick A Day
        </button>
      </div>
      {choice === "date" && (
        <input
          type="date"
          value={date}
          min={todayStr}
          onChange={(e) => setDate(e.target.value)}
          aria-label="The day it comes back"
          className="h-11 rounded-lg border border-slate-300 px-3 text-sm"
        />
      )}
      {/* The day, in words, before anything is saved (text to visual: the chip says what it means). */}
      {picked && picked.ok && todayStr && (
        <p className="text-xs text-slate-500">
          {picked.day === todayStr ? "Comes back today" : `Comes back ${shortDay(picked.day)}`}
        </p>
      )}
      {dateRefused && <p className="text-xs font-medium text-red-600">{dateRefused}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={submit} disabled={disabled}>
          {pending ? "Saving…" : label}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
        )}
      </div>
      {error && <p className="text-xs font-medium text-red-600">{error}</p>}
    </div>
  );
}
