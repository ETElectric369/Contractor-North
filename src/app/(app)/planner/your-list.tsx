"use client";

// TODAY'S 6 — the six-slot day card on My Day. The server picks the six with
// THE shared rank (lib/six-rank: pins first, then overdue/due-today/on-site/
// flagged — the same function behind the morning digest, so the phone and the
// card can never disagree) and this card renders them as 44px one-tap check
// rows with subtasks indented
// under their parent. Subtasks are NEVER counted anywhere — checking a parent
// with open children confirm-cascades (the toggleTask needsCascade contract).
// #7+ never vanishes: the door lines under this card carry the numbers.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, Flag, MoreHorizontal, Pin } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { MoveToDay } from "@/components/move-to-day";
import { useToast } from "@/components/toast";
import { formatDate } from "@/lib/utils";
import { toggleTask, updateTask, type ToggleTaskResult } from "../tasks/actions";
import { jobLabel } from "@/lib/schedule-options";

/** A ranked slot (lib/six-rank picks it; planner/page.tsx decorates it). */
export interface SixSlot {
  id: string;
  title: string;
  category: string;
  priority: number;
  due_date: string | null;
  job_id: string | null;
  jobs?: { job_number: string; name: string } | null;
  /** focus_date = today — an explicit "do today" pin (renders the pin glyph). */
  pinned: boolean;
  /** The task's job is on today's schedule (renders the "on site" chip). */
  onSite: boolean;
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

export function YourList({
  six,
  subtasks,
  todayStr,
  doneToday,
  grabHref,
}: {
  six: SixSlot[];
  subtasks: SixSubtask[];
  todayStr: string;
  /** My tasks completed today (server head-count) — the durable half of "2/6". */
  doneToday: number;
  /** Where "Grab one →" points when the six run dry (null = nothing behind the doors). */
  grabHref: string | null;
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

  if (six.length === 0 && doneToday === 0 && !grabHref) return null;

  return (
    <Card className="mb-4 overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
        <h2 className="text-sm font-semibold text-slate-900">Today&rsquo;s 6</h2>
        {/* Plain text, no pill — checkboxes are their own affordance. */}
        <span className="text-xs font-medium text-slate-500">{Math.min(doneCount, 6)}/6</span>
      </div>

      {six.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-slate-400">
          Nothing urgent today.{" "}
          {grabHref && (
            <Link href={grabHref} className="font-medium text-brand hover:underline">
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
                      {(t.jobs || t.category === "office") && (
                        <span className="mt-0.5 flex items-center gap-1.5 text-xs text-slate-400">
                          {t.category === "office" && (
                            <span className="rounded-full bg-amber-50 px-1.5 py-px text-[10px] font-medium text-amber-700">Office</span>
                          )}
                          {t.jobs && (
                            <span className="truncate">
                              {jobLabel(t.jobs)}
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                    {/* ONE right chip: the due scream wins; else "on site" (the
                        truck's already going there); else a quiet future date. */}
                    {!done &&
                      (screaming ? (
                        <span className="shrink-0 text-xs font-medium text-red-600">{chip!.label}</span>
                      ) : t.onSite ? (
                        <span className="shrink-0 rounded-full bg-brand-light/60 px-2 py-0.5 text-[11px] font-medium text-brand">on site</span>
                      ) : chip ? (
                        <span className="shrink-0 text-xs text-slate-400">{chip.label}</span>
                      ) : null)}
                    {t.pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-brand" fill="currentColor" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSheetFor(t.id)}
                    className="flex h-11 w-9 shrink-0 items-center justify-center rounded-lg text-slate-300 hover:bg-slate-100 hover:text-slate-600"
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
              href={sheetTask.job_id ? `/jobs/${sheetTask.job_id}?tab=tasks` : `/tasks/${sheetTask.category}`}
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
