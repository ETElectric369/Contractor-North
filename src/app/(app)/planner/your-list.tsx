"use client";

// TASKS & REMINDERS — the day card on My Day, and since 0358 the ONE place My Day adds anything
// (Erik, 2026-09-26: "fold that into Today's 6 with an add reminder/task up top as that will be the
// most useful"). The Add line leads the card: type the words; pick a job on the chip and it goes on
// that job's Tasks ("Added To J-055's Tasks"), leave the chip and it is a Reminder for you.
//
// ERIK NAMED IT (2026-09-30): "instead of todayy's 6 lets not limit it and call it something more
// clear like Tasks & Reminders". So there is no cap on this card and no "6" in its words. The rows
// are the person's own REMINDERS (tasks with no job): job tasks are the job's list, worked on the job
// and in the Now card, never stockpiled here. The server picks them with THE shared rank
// (lib/six-rank: carried pins, today's pins, overdue, due today, flagged undated, then the plain
// ones — the same function behind the morning digest, so the phone and the card can never disagree)
// and this card renders them as 44px one-tap check rows with subtasks indented under their parent.
// Subtasks are NEVER counted anywhere — checking a parent with open children confirm-cascades (the
// toggleTask needsCascade contract).
//
// A PIN IS A PROMISE. It carries past midnight and wears "Carried From <Day>" when it does; it goes
// when he unpins it or checks it off. Whatever the fetch's bound could not carry is counted on the
// All Reminders line — nothing leaves this card without a number.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, Flag, Pin, Plus } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MoveToDay } from "@/components/move-to-day";
import { RowMoreSheet, SheetLink, SHEET_ROW } from "@/components/row-more-sheet";
import { useToast } from "@/components/toast";
import { formatDate } from "@/lib/utils";
import { carriedDay, carriedPin, isPinned, ranksToday } from "@/lib/six-rank";
import { createTask, toggleTask, updateTask, type ToggleTaskResult } from "../tasks/actions";
import { taskHref } from "@/lib/task-href";

/** A ranked row (lib/six-rank picks it). A Reminder: no job. focus_date crosses as-is and the card
 *  asks lib/six-rank what it means — the pin's definition has ONE home, and it used to have three. */
export interface SixSlot {
  id: string;
  title: string;
  category: string;
  priority: number;
  due_date: string | null;
  job_id: string | null;
  /** yyyy-mm-dd. On or before today = a pin that still stands; before today = a CARRIED pin. */
  focus_date: string | null;
}

/** A job the Add line's chip can put a task on (the jobs still being worked, the clocked-in one first). */
export interface AddJob {
  id: string;
  label: string;
  /** J-055: what the toast names. */
  number: string | null;
}

export interface SixSubtask {
  id: string;
  title: string;
  status: string;
  parent_id: string;
}

/**
 * THE REMINDER'S "LATER" ROW (Erik's open question, built as the plan recommends). His rule is
 * "nothing goes quiet without a day". It stays In A Week — due a week from today, in the company's
 * timezone (todayStr is the org's day) — because a stated day is still better than no day: the row
 * comes back on the morning it matters instead of sitting on the card every day until then.
 * (Clearing the date no longer SILENCES a Reminder — lib/six-rank's last rank shows the plain undated
 * ones now, which is what Erik asked for. It just loses its place in the order.)
 * One line to flip back: "someday" draws the old row again.
 */
export const LATER_CHOICE: "in_a_week" | "someday" = "in_a_week";

/** `n` days after an org-local yyyy-mm-dd (pure date math: the day is already the company's). */
export function addDaysStr(dayStr: string, n: number): string {
  const d = new Date(`${dayStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The later row as the sheet draws it: its words and the due date it writes (null clears it). */
export function laterRow(choice: typeof LATER_CHOICE, todayStr: string): { label: string; due: string | null } {
  return choice === "someday" ? { label: "Someday (Clear Date)", due: null } : { label: "In A Week", due: addDaysStr(todayStr, 7) };
}

/**
 * NOTHING SILENT: a Reminder whose new due day takes it OFF this card says where it went, and one
 * that stays says nothing (a toast about a row still sitting in front of him is noise).
 *
 * It asks THE RANK (lib/six-rank ranksToday) with the row as it will be after the write, instead of
 * re-deriving the rule here. That is the only way these words can't go stale: when the undated ranks
 * changed, this sentence would have started lying about four different rows.
 */
export function movedWords(
  t: { focus_date: string | null; priority: number | null; category: string | null },
  due: string | null,
  todayStr: string,
): string | null {
  const after = { id: "x", focus_date: t.focus_date, priority: t.priority, category: t.category, due_date: due };
  if (ranksToday(after, todayStr)) return null;
  if (due === null) return "No due date now. It waits on your Reminders list under Someday.";
  const when = due === addDaysStr(todayStr, 1) ? "tomorrow" : formatDate(due);
  return `Due ${when}. It waits on your Reminders list till then.`;
}

/** How many marks a phone can carry beside a heading before they stop reading as progress. The
 *  aria-label always carries the TRUE total, so a long day is never misreported, only abbreviated. */
export const PROGRESS_MARKS = 10;

/** Small marks beside the heading, one filled for each Reminder done today: a progress mark, never a
 *  badge (nothing counts down to zero here, and nothing is owed). There is no "6" left in it — the
 *  total is the day's own: what is done plus what is still open on the card. A day with neither
 *  draws nothing. */
export function DoneMarks({ done, total }: { done: number; total: number }) {
  const all = Math.max(0, total);
  if (all === 0) return null;
  const n = Math.max(0, Math.min(all, done));
  const marks = Math.min(all, PROGRESS_MARKS);
  // Abbreviated days scale the fill so the proportion stays honest (3 of 20 → 2 of 10 filled).
  const filled = all === marks ? n : Math.round((n / all) * marks);
  return (
    <span role="img" aria-label={`${n} of ${all} done today`} className="flex items-center gap-1">
      {Array.from({ length: marks }, (_, i) => (
        <span
          key={i}
          data-mark={i < filled ? "done" : "open"}
          className={`h-2.5 w-2.5 rounded-[3px] border ${i < filled ? "border-brand bg-brand" : "border-slate-300 bg-white"}`}
        />
      ))}
    </span>
  );
}

/** Small relative due chip — computed against the ORG's day, not the phone's. */
function dueChip(due: string | null, todayStr: string): { label: string; overdue: boolean } | null {
  if (!due) return null;
  if (due < todayStr) {
    const days = Math.max(1, Math.round((Date.parse(todayStr) - Date.parse(due)) / 86_400_000));
    return { label: `${days}d overdue`, overdue: true };
  }
  if (due === todayStr) return { label: "Today", overdue: false };
  return { label: formatDate(due), overdue: false };
}

/**
 * THE ADD LINE at the top of Tasks & Reminders. One line, one optional chip, one button:
 *   · no job  → a Reminder of yours, right here on the card;
 *   · a job   → that job's task, on its list for whoever is on the job ("Added To J-055's Tasks").
 *
 * IT NO LONGER STAMPS A PIN. It had to: an undated, unflagged Reminder was not even fetched for this
 * card, so the only way a typed reminder showed up at all was focus_date = today — which then expired
 * at midnight and took the reminder out of the query with it (Erik, 2026-09-30: "the tasks keep
 * disappearing even the pinned ones"). Now the card shows plain undated Reminders (lib/six-rank's
 * last rank), so a typed one is visible WITHOUT a pin, and a pin goes back to meaning what it says:
 * something he chose, that carries until he unpins it. He pins from the row's ⋯ sheet below.
 *
 * The toast always says where it went, and never claims a pin it didn't write (nothing silent).
 */
export function AddReminderLine({
  jobs,
  todayStr,
}: {
  jobs: AddJob[];
  /** The company's day — the dup answer needs it to tell an already-open Reminder it can't see. */
  todayStr: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState("");
  const [jobId, setJobId] = useState("");

  function add() {
    if (!title.trim()) return;
    const job = jobs.find((j) => j.id === jobId) ?? null;
    start(async () => {
      // No focus_date: a typed reminder is not a pin. `today` is only so the duplicate answer can
      // tell whether the Reminder he just re-typed is one he can actually see (tasks/actions).
      const res = await createTask(job ? { title, job_id: job.id } : { title, today: todayStr });
      if (!res.ok) {
        toast(res.error ?? "Couldn't add it. Try again.", "error");
        return;
      }
      if (res.duplicate) toast(res.speak ?? "Already on the list.", "info");
      else if (job) toast(`Added To ${job.number || job.label}'s Tasks`, "success");
      else toast("Added To Tasks & Reminders", "success");
      setTitle("");
      setJobId("");
      router.refresh();
    });
  }

  return (
    <div className="space-y-2 border-b border-slate-100 px-3 py-3">
      <div className="flex items-center gap-2">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="Add A Reminder Or Task…"
          aria-label="Add A Reminder Or Task"
          className="h-11 min-w-0 flex-1"
        />
        <Button onClick={add} disabled={pending || !title.trim()} className="shrink-0 px-3">
          <Plus /> Add
        </Button>
      </div>
      {jobs.length > 0 && (
        // The optional job chip: a native select, so the phone's own picker lists the jobs.
        <select
          value={jobId}
          onChange={(e) => setJobId(e.target.value)}
          aria-label="Job (optional)"
          className={`h-11 max-w-full truncate rounded-full border px-3 text-sm ${
            jobId ? "border-brand bg-brand-light/40 font-medium text-brand" : "border-slate-300 bg-white text-slate-600"
          }`}
        >
          <option value="">No Job: A Reminder For Me</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              On {j.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

export function YourList({
  rows,
  subtasks,
  todayStr,
  doneToday,
  restCount,
  jobs = [],
}: {
  /** The day's Reminders, already in rank order. No cap — Erik: "lets not limit it". */
  rows: SixSlot[];
  subtasks: SixSubtask[];
  todayStr: string;
  /** My Reminders completed today (server head-count) — the durable half of the progress marks. */
  doneToday: number;
  /** My open Reminders this card doesn't show — the ones a rank doesn't claim (a future due date, an
   *  undated office task) plus anything past the fetch's bound. Never dropped in silence: it is the
   *  All Reminders line's number, and the Grab One gate on an empty day. */
  restCount: number;
  /** The Add line's job chip. Empty: the line adds Reminders only. */
  jobs?: AddJob[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  // Optimistic done-state overrides (parents AND subtasks): applied instantly,
  // reverted on server error. The refresh re-ranks the rows server-side.
  const [override, setOverride] = useState<Map<string, boolean>>(new Map());

  const kidsByParent = useMemo(() => {
    const m = new Map<string, SixSubtask[]>();
    for (const k of subtasks) {
      if (!m.has(k.parent_id)) m.set(k.parent_id, []);
      m.get(k.parent_id)!.push(k);
    }
    return m;
  }, [subtasks]);

  // Tomorrow in the ORG's day (todayStr is already org-tz; pure date math).
  const tomorrowStr = useMemo(() => addDaysStr(todayStr, 1), [todayStr]);
  const later = useMemo(() => laterRow(LATER_CHOICE, todayStr), [todayStr]);

  const mark = (id: string, done: boolean) =>
    setOverride((prev) => new Map(prev).set(id, done));
  const slotDone = (t: SixSlot) => override.get(t.id) ?? false;
  const kidDone = (k: SixSubtask) => override.get(k.id) ?? k.status === "done";

  const doneCount = doneToday + rows.filter((t) => slotDone(t)).length;

  function toggleSlot(t: SixSlot) {
    const nowDone = !slotDone(t);
    const openKids = (kidsByParent.get(t.id) ?? []).filter((k) => !kidDone(k));
    mark(t.id, nowDone);
    start(async () => {
      const opts = { category: t.category, jobId: t.job_id };
      // The toggleTask cascade contract: completing a parent with open subtasks
      // returns needsCascade (nothing written) — confirm, then retry cascade:true.
      let res: ToggleTaskResult = await toggleTask(t.id, nowDone, opts);
      if (!res.ok && res.needsCascade && nowDone) {
        const n = res.openChildren ?? openKids.length;
        if (confirm(`"${t.title}" has ${n} open subtask${n === 1 ? "" : "s"} — mark ${n === 1 ? "it" : "them"} done too?`)) {
          res = await toggleTask(t.id, nowDone, { ...opts, cascade: true });
          if (res.ok) for (const k of openKids) mark(k.id, true);
        } else {
          mark(t.id, false); // declined — leave the parent open
          return;
        }
      }
      if (!res.ok) {
        mark(t.id, !nowDone); // roll back the optimistic check
        toast(res.error ?? "Couldn't update task — try again.", "error");
        return;
      }
      router.refresh();
    });
  }

  function toggleKid(parent: SixSlot, k: SixSubtask) {
    const nowDone = !kidDone(k);
    mark(k.id, nowDone);
    start(async () => {
      const res = await toggleTask(k.id, nowDone, { category: parent.category, jobId: parent.job_id });
      if (!res.ok) {
        mark(k.id, !nowDone);
        toast(res.error ?? "Couldn't update subtask — try again.", "error");
        return;
      }
      router.refresh();
    });
  }

  /** Run a sheet verb: on success close the row's sheet, say where the Reminder went if it left the
   *  card, and refresh; on failure a toast, and the sheet stays. */
  function sheetAct(close: () => void, fn: () => Promise<{ ok: boolean; error?: string }>, said: string | null = null) {
    start(async () => {
      const res = await fn();
      if (!res.ok) {
        toast(res.error ?? "Couldn't update task — try again.", "error");
        return;
      }
      close();
      if (said) toast(said, "success");
      router.refresh();
    });
  }

  /** The Reminder's ⋯ sheet: the app's one row sheet, its rows saying exactly what they write
   *  (the swap grammar, amendment 3: on an overdue row "tomorrow" destroys a stated deadline). */
  const sheetFor = (t: SixSlot) => {
    const c = dueChip(t.due_date, todayStr);
    const due = t.due_date ? `Due ${formatDate(t.due_date)}${c?.overdue ? ` · ${c.label}` : ""}` : "No due date";
    const opts = { category: t.category, jobId: t.job_id };
    const pinned = isPinned(t.focus_date, todayStr);
    // The same one function the row's chip asks (lib/six-rank carriedPin), so the sheet's subline and
    // the chip above it can never say different things about the same pin.
    const carried = carriedPin(t, todayStr);
    const pinWords = carried ? ` · Pinned, carried from ${carriedDay(carried, todayStr)}` : pinned ? " · Pinned" : "";
    return (
      <RowMoreSheet title={t.title} subline={`${due}${pinWords}`}>
        {({ close }) => (
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => sheetAct(close, () => updateTask(t.id, { due_date: tomorrowStr }, opts), movedWords(t, tomorrowStr, todayStr))}
              className={SHEET_ROW}
            >
              Move Due Date to Tomorrow
            </button>
            <MoveToDay
              label="Pick a Day"
              triggerClassName={SHEET_ROW}
              onPick={async (iso) => {
                if (!iso) return { ok: true };
                const res = await updateTask(t.id, { due_date: iso }, opts);
                if (res.ok) {
                  close();
                  const said = movedWords(t, iso, todayStr);
                  if (said) toast(said, "success");
                  router.refresh();
                }
                return res;
              }}
            >
              Pick a Day…
            </MoveToDay>
            {/* Nothing goes quiet without a day: In A Week, not Someday (LATER_CHOICE above). */}
            <button
              type="button"
              disabled={pending}
              onClick={() => sheetAct(close, () => updateTask(t.id, { due_date: later.due }, opts), movedWords(t, later.due, todayStr))}
              className={SHEET_ROW}
            >
              {later.label}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                // focus_date is the pin. It no longer expires at midnight: lib/six-rank honours any
                // focus_date on or before today, so this row says what the pin actually does.
                sheetAct(close, () => updateTask(t.id, { focus_date: pinned ? null : todayStr }, opts))
              }
              className={SHEET_ROW}
            >
              {pinned ? "Unpin" : "Pin To Top (Carries Until You Unpin It)"}
            </button>
            {/* Goes to the Reminders page; the page change takes the sheet with it (SheetLink). */}
            <SheetLink href={taskHref(t)}>Open</SheetLink>
          </>
        )}
      </RowMoreSheet>
    );
  };

  // Always drawn: the Add line is My Day's one door for a Reminder or a job's task, even on a day
  // with nothing on it (no dead end, and never a first Reminder with nowhere to type it).
  return (
    <Card className="mb-4 overflow-hidden">
      <div className="flex items-center border-b border-slate-100 px-5 py-3">
        <div className="flex items-center gap-2.5">
          {/* ERIK NAMED IT: "lets not limit it and call it something more clear like Tasks &
              Reminders". No number in the heading, because there is no cap behind it. */}
          <h2 className="text-sm font-semibold text-slate-900">Tasks &amp; Reminders</h2>
          {/* One mark per thing on the day, filled as they get checked off: checkboxes are their own
              affordance, and this is progress, not a count to clear. */}
          <DoneMarks done={doneCount} total={doneToday + rows.length} />
        </div>
      </div>

      <AddReminderLine jobs={jobs} todayStr={todayStr} />

      {rows.length === 0 ? (
        <p className="px-5 py-5 text-center text-sm text-slate-400">
          Nothing urgent today.{" "}
          {restCount > 0 && (
            <Link href="/tasks" className="font-medium text-brand hover:underline">
              Grab One →
            </Link>
          )}
        </p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((t) => {
            const done = slotDone(t);
            const chip = dueChip(t.due_date, todayStr);
            const screaming = !!chip && (chip.overdue || chip.label === "Today");
            const kids = kidsByParent.get(t.id) ?? [];
            // A pin he set on an earlier day: the chip is why the row is still here, in two words.
            // BOTH PIN MARKS GO WHEN THE ROW IS CHECKED, like the flag and the due chip beside them —
            // a struck-through line saying "Carried From Yesterday" is a sentence about finished work
            // (lib/six-rank carriedPin owns that gate for this card and for /tasks both).
            const carried = carriedPin(t, todayStr, done);
            const pinned = isPinned(t.focus_date, todayStr) && !done;
            return (
              <li key={t.id}>
                <div className="flex items-center pr-2">
                  <button
                    type="button"
                    onClick={() => toggleSlot(t)}
                    className="flex min-h-[44px] min-w-0 flex-1 items-center gap-3 px-5 py-1.5 text-left hover:bg-slate-50"
                    aria-label={done ? `Uncheck ${t.title}` : `Mark ${t.title} done`}
                  >
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                        done ? "border-brand bg-brand text-white" : "border-slate-300"
                      }`}
                    >
                      {done && <Check className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate text-sm ${done ? "text-slate-400 line-through" : "font-medium text-slate-900"}`}>
                        {t.priority > 0 && !done && (
                          <Flag className={`mr-1 inline h-3.5 w-3.5 ${t.priority >= 2 ? "text-red-600" : "text-amber-500"}`} />
                        )}
                        {t.title}
                      </span>
                      {(carried || t.category === "office") && (
                        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-slate-400">
                          {carried && (
                            <span className="rounded-full bg-slate-100 px-1.5 py-px text-[10px] font-medium text-slate-600">
                              Carried From {carriedDay(carried, todayStr)}
                            </span>
                          )}
                          {t.category === "office" && (
                            <span className="rounded-full bg-amber-50 px-1.5 py-px text-[10px] font-medium text-amber-700">Office</span>
                          )}
                        </span>
                      )}
                    </span>
                    {/* ONE right chip: the due scream wins; else a quiet future date. */}
                    {!done &&
                      (screaming ? (
                        <span className="shrink-0 text-xs font-medium text-red-600">{chip!.label}</span>
                      ) : chip ? (
                        <span className="shrink-0 text-xs text-slate-400">{chip.label}</span>
                      ) : null)}
                    {pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-brand" fill="currentColor" />}
                  </button>
                  {/* The row's ⋯: the app's one row sheet (components/row-more-sheet). */}
                  {sheetFor(t)}
                </div>

                {/* Subtasks — indented smaller check rows (44px targets all the same), never
                    counted, hidden once the parent checks (they cascaded or they'll re-surface
                    on the next pick if the parent reopens). */}
                {kids.length > 0 && !done && (
                  <ul className="pb-1.5">
                    {[...kids]
                      .sort((a, b) => (kidDone(a) ? 1 : 0) - (kidDone(b) ? 1 : 0))
                      .map((k) => {
                        const kd = kidDone(k);
                        return (
                          <li key={k.id}>
                            <button
                              type="button"
                              onClick={() => toggleKid(t, k)}
                              className="flex min-h-[44px] w-full items-center gap-2.5 py-1 pl-[3.25rem] pr-4 text-left hover:bg-slate-50"
                              aria-label={kd ? `Uncheck ${k.title}` : `Mark ${k.title} done`}
                            >
                              <span
                                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                                  kd ? "border-brand bg-brand text-white" : "border-slate-300"
                                }`}
                              >
                                {kd && <Check className="h-3 w-3" />}
                              </span>
                              <span className={`min-w-0 flex-1 truncate text-xs ${kd ? "text-slate-400 line-through" : "text-slate-600"}`}>
                                {k.title}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {rows.length > 0 && restCount > 0 && (
        <Link
          href="/tasks"
          className="flex min-h-[44px] items-center justify-center border-t border-slate-100 text-sm font-medium text-brand hover:bg-slate-50"
        >
          {/* NOTHING SILENT: this is every open Reminder of mine the card is NOT showing — the ones
              waiting on a later day, the undated office ones, and anything past the fetch's bound.
              "For you": /tasks also lists the ones you made for someone else, which this doesn't
              count. */}
          All Reminders · {restCount} More For You
        </Link>
      )}
    </Card>
  );
}
