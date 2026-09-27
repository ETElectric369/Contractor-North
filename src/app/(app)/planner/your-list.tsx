"use client";

// TODAY'S 6 — the six-slot day card on My Day, and since 0358 the ONE place My Day adds anything
// (Erik, 2026-09-26: "fold that into Today's 6 with an add reminder/task up top as that will be the
// most useful"). The Add line leads the card: type the words; pick a job on the chip and it goes on
// that job's Tasks ("Added To J-055's Tasks"), leave the chip and it is a Reminder for today.
//
// The six are the person's own REMINDERS (tasks with no job): job tasks are the job's list, worked
// on the job and in the Now card, never stockpiled here. The server picks the six with THE shared
// rank (lib/six-rank: pins, then overdue / due today / flagged — the same function behind the morning
// digest, so the phone and the card can never disagree) and this card renders them as 44px one-tap
// check rows with subtasks indented under their parent. Subtasks are NEVER counted anywhere —
// checking a parent with open children confirm-cascades (the toggleTask needsCascade contract).
// #7+ never vanishes: it lives at /tasks, the Reminders page (Grab One / All Reminders).

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, Flag, MoreHorizontal, Pin, Plus } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { MoveToDay } from "@/components/move-to-day";
import { useToast } from "@/components/toast";
import { formatDate } from "@/lib/utils";
import { createTask, toggleTask, updateTask, type ToggleTaskResult } from "../tasks/actions";
import { taskHref } from "@/lib/task-href";

/** A ranked slot (lib/six-rank picks it; planner/page.tsx decorates it). A Reminder: no job. */
export interface SixSlot {
  id: string;
  title: string;
  category: string;
  priority: number;
  due_date: string | null;
  job_id: string | null;
  /** focus_date = today — an explicit "do today" pin (renders the pin glyph). */
  pinned: boolean;
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

const SHEET_ROW =
  "flex min-h-[44px] w-full items-center rounded-lg border border-slate-200 bg-white px-4 text-left text-sm font-medium text-slate-700 hover:border-brand hover:text-brand disabled:opacity-50";

/**
 * THE ADD LINE at the top of Today's 6. One line, one optional chip, one button:
 *   · no job  → a Reminder, pinned to today (focus_date) so it shows in the six it was added to;
 *   · a job   → that job's task, on its list for whoever is on the job ("Added To J-055's Tasks").
 * The toast always says where it went (nothing silent). A pin ranks first (lib/six-rank), so a new
 * Reminder takes a slot unless six pins already hold them all; on a full card the last slot, never a
 * pin, is the one it moves to Reminders, and the toast names it.
 */
export function AddReminderLine({
  jobs,
  todayStr,
  pinsFull,
  bumps,
}: {
  jobs: AddJob[];
  todayStr: string;
  /** Six pins already: a seventh pin can't be sure of a slot. */
  pinsFull: boolean;
  /** The six are full (not all pins): the title of the last slot, which a new pin moves out. */
  bumps: string | null;
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
      const res = await createTask(job ? { title, job_id: job.id } : { title, focus_date: todayStr });
      if (!res.ok) {
        toast(res.error ?? "Couldn't add it. Try again.", "error");
        return;
      }
      if (res.duplicate) toast(res.speak ?? "Already on the list.", "info");
      else if (job) toast(`Added To ${job.number || job.label}'s Tasks`, "success");
      else if (pinsFull) toast("Reminder added and pinned. Today's 6 already holds six pins, so one of them waits on your Reminders list.", "success");
      else if (bumps) toast(`Added To Today's 6. "${bumps}" moved to your Reminders list.`, "success");
      else toast("Added To Today's 6", "success");
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
  six,
  subtasks,
  todayStr,
  doneToday,
  restCount,
  jobs = [],
}: {
  six: SixSlot[];
  subtasks: SixSubtask[];
  todayStr: string;
  /** My Reminders completed today (server head-count) — the durable half of "2/6". */
  doneToday: number;
  /** My open Reminders the six don't show (Grab One when the six are empty, All Reminders otherwise). */
  restCount: number;
  /** The Add line's job chip. Empty: the line adds Reminders only. */
  jobs?: AddJob[];
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  // Optimistic done-state overrides (parents AND subtasks): applied instantly,
  // reverted on server error. The refresh re-picks the six server-side.
  const [override, setOverride] = useState<Map<string, boolean>>(new Map());
  const [sheetFor, setSheetFor] = useState<string | null>(null);

  const kidsByParent = useMemo(() => {
    const m = new Map<string, SixSubtask[]>();
    for (const k of subtasks) {
      if (!m.has(k.parent_id)) m.set(k.parent_id, []);
      m.get(k.parent_id)!.push(k);
    }
    return m;
  }, [subtasks]);

  // Tomorrow in the ORG's day (todayStr is already org-tz; pure date math).
  const tomorrowStr = useMemo(() => {
    const d = new Date(`${todayStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }, [todayStr]);

  const mark = (id: string, done: boolean) =>
    setOverride((prev) => new Map(prev).set(id, done));
  const slotDone = (t: SixSlot) => override.get(t.id) ?? false;
  const kidDone = (k: SixSubtask) => override.get(k.id) ?? k.status === "done";

  const doneCount = doneToday + six.filter((t) => slotDone(t)).length;

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

  const sheetTask = sheetFor ? six.find((t) => t.id === sheetFor) ?? null : null;

  /** Run a sheet verb; close the sheet + refresh on success, toast on failure. */
  function sheetAct(fn: () => Promise<{ ok: boolean; error?: string }>) {
    start(async () => {
      const res = await fn();
      if (!res.ok) {
        toast(res.error ?? "Couldn't update task — try again.", "error");
        return;
      }
      setSheetFor(null);
      router.refresh();
    });
  }

  // Always drawn: the Add line is My Day's one door for a Reminder or a job's task, even on a day
  // with nothing in the six (no dead end, and never a first Reminder with nowhere to type it).
  return (
    <Card className="mb-4 overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
        <h2 className="text-sm font-semibold text-slate-900">Today&rsquo;s 6</h2>
        {/* Plain text, no pill — checkboxes are their own affordance. */}
        <span className="text-xs font-medium text-slate-500">{Math.min(doneCount, 6)}/6</span>
      </div>

      <AddReminderLine
        jobs={jobs}
        todayStr={todayStr}
        pinsFull={six.filter((t) => t.pinned).length >= 6}
        bumps={six.length >= 6 ? six[six.length - 1].title : null}
      />

      {six.length === 0 ? (
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
          {six.map((t) => {
            const done = slotDone(t);
            const chip = dueChip(t.due_date, todayStr);
            const screaming = !!chip && (chip.overdue || chip.label === "Today");
            const kids = kidsByParent.get(t.id) ?? [];
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
                      {t.category === "office" && (
                        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-400">
                          <span className="rounded-full bg-amber-50 px-1.5 py-px text-[10px] font-medium text-amber-700">Office</span>
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
                    {t.pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-brand" fill="currentColor" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSheetFor(t.id)}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-300 hover:bg-slate-100 hover:text-slate-600"
                    aria-label={`More options for ${t.title}`}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                </div>

                {/* Subtasks — indented smaller check rows, never counted, hidden
                    once the parent checks (they cascaded or they'll re-surface
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
                              className="flex min-h-[36px] w-full items-center gap-2.5 py-1 pl-[3.25rem] pr-4 text-left hover:bg-slate-50"
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
      {six.length > 0 && restCount > 0 && (
        <Link
          href="/tasks"
          className="flex min-h-[44px] items-center justify-center border-t border-slate-100 text-sm font-medium text-brand hover:bg-slate-50"
        >
          {/* For you: /tasks also lists the ones you made for someone else, which this doesn't count. */}
          All Reminders · {restCount} More For You
        </Link>
      )}

      {/* Per-row "…" sheet — the swap grammar (amendment 3): every button says
          exactly what it writes, because on an overdue row "tomorrow" destroys
          a stated deadline. */}
      {sheetTask && (
        <Modal open onClose={() => setSheetFor(null)} title={sheetTask.title} size="sm">
          <div className="space-y-2">
            <p className="text-xs text-slate-400">
              {(() => {
                const c = dueChip(sheetTask.due_date, todayStr);
                const due = sheetTask.due_date
                  ? `Due ${formatDate(sheetTask.due_date)}${c?.overdue ? ` · ${c.label}` : ""}`
                  : "No due date";
                return `${due}${sheetTask.pinned ? " · Pinned to today" : ""}`;
              })()}
            </p>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                sheetAct(() =>
                  updateTask(sheetTask.id, { due_date: tomorrowStr }, { category: sheetTask.category, jobId: sheetTask.job_id }),
                )
              }
              className={SHEET_ROW}
            >
              Move Due Date to Tomorrow
            </button>
            <MoveToDay
              label="Pick a Day"
              triggerClassName={SHEET_ROW}
              onPick={async (iso) => {
                if (!iso) return { ok: true };
                const res = await updateTask(sheetTask.id, { due_date: iso }, { category: sheetTask.category, jobId: sheetTask.job_id });
                if (res.ok) {
                  setSheetFor(null);
                  router.refresh();
                }
                return res;
              }}
            >
              Pick a Day…
            </MoveToDay>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                sheetAct(() =>
                  updateTask(sheetTask.id, { due_date: null }, { category: sheetTask.category, jobId: sheetTask.job_id }),
                )
              }
              className={SHEET_ROW}
            >
              Someday (Clear Date)
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                sheetAct(() =>
                  // focus_date is the pin — a DATE so it self-expires at midnight.
                  updateTask(
                    sheetTask.id,
                    { focus_date: sheetTask.pinned ? null : todayStr },
                    { category: sheetTask.category, jobId: sheetTask.job_id },
                  ),
                )
              }
              className={SHEET_ROW}
            >
              {sheetTask.pinned ? "Unpin From Today" : "Pin to Today"}
            </button>
            <Link
              href={taskHref(sheetTask)}
              onClick={() => setSheetFor(null)}
              className={SHEET_ROW}
            >
              Open
            </Link>
          </div>
        </Modal>
      )}
    </Card>
  );
}
