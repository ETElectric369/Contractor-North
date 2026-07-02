"use client";

// YOUR LIST — the crew checklist on My Day. Every role gets the same card: the
// open tasks assigned to ME (staff also see their own unassigned captures),
// due-ordered (overdue → today → dated → undated), grouped under tiny job-name
// headers, each row a 44px one-tap check-off. For a tech this IS the work list
// for the day — the boss assigns, the crew checks off, /planner revalidates.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, Flag } from "lucide-react";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/toast";
import { formatDate } from "@/lib/utils";
import { toggleTask } from "../tasks/actions";

export interface MyListTask {
  id: string;
  title: string;
  category: string;
  priority: number;
  due_date: string | null;
  job_id: string | null;
  jobs?: { job_number: string; name: string } | null;
}

const MAX_ROWS = 15;

/** overdue → today → dated → undated (the spec's due-order, coarser than raw dates). */
function bucketOf(due: string | null, todayStr: string): number {
  if (!due) return 3;
  if (due < todayStr) return 0;
  if (due === todayStr) return 1;
  return 2;
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

export function YourList({ tasks, todayStr }: { tasks: MyListTask[]; todayStr: string }) {
  const router = useRouter();
  const toast = useToast();
  const [, start] = useTransition();
  // Optimistic check-offs: checked instantly, reverted on server error. The
  // refresh drops completed rows from the server list, so ids never pile up.
  const [checked, setChecked] = useState<Set<string>>(new Set());

  // Due-order the tasks, then group them under job headers. Groups (including the
  // no-job one) render in order of their most-urgent member so an overdue job task
  // can't sink below someone's undated loose ends.
  const groups = useMemo(() => {
    const sorted = tasks
      .map((t, i) => ({ t, i }))
      .sort((a, b) => {
        const ab = bucketOf(a.t.due_date, todayStr);
        const bb = bucketOf(b.t.due_date, todayStr);
        if (ab !== bb) return ab - bb;
        if (a.t.due_date !== b.t.due_date) return (a.t.due_date ?? "").localeCompare(b.t.due_date ?? "");
        if (a.t.priority !== b.t.priority) return b.t.priority - a.t.priority;
        return a.i - b.i; // stable
      })
      .map(({ t }) => t);
    const byKey = new Map<string, { header: string | null; tasks: MyListTask[] }>();
    for (const t of sorted) {
      const key = t.job_id ?? "";
      if (!byKey.has(key)) {
        byKey.set(key, {
          header: t.jobs ? `${t.jobs.job_number} · ${t.jobs.name}` : null,
          tasks: [],
        });
      }
      byKey.get(key)!.tasks.push(t);
    }
    return [...byKey.values()];
  }, [tasks, todayStr]);

  if (tasks.length === 0) return null;

  // Bound the card at ~15 rows across groups; the rest lives behind "All tasks →".
  let budget = MAX_ROWS;
  const visible: { header: string | null; tasks: MyListTask[] }[] = [];
  for (const g of groups) {
    if (budget <= 0) break;
    const slice = g.tasks.slice(0, budget);
    budget -= slice.length;
    visible.push({ header: g.header, tasks: slice });
  }
  const truncated = tasks.length > MAX_ROWS;
  const hasJobGroups = visible.some((g) => g.header);
  const openCount = tasks.filter((t) => !checked.has(t.id)).length;

  function toggle(t: MyListTask) {
    const nowDone = !checked.has(t.id);
    setChecked((prev) => {
      const n = new Set(prev);
      if (nowDone) n.add(t.id);
      else n.delete(t.id);
      return n;
    });
    start(async () => {
      const res = await toggleTask(t.id, nowDone, { category: t.category, jobId: t.job_id });
      if (!res.ok) {
        // roll back the optimistic check
        setChecked((prev) => {
          const n = new Set(prev);
          if (nowDone) n.delete(t.id);
          else n.add(t.id);
          return n;
        });
        toast(res.error ?? "Couldn't update task — try again.", "error");
        return;
      }
      router.refresh();
    });
  }

  return (
    <Card className="mb-4 overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
        <h2 className="text-sm font-semibold text-slate-900">Your list</h2>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-bold text-slate-600">{openCount}</span>
      </div>
      <ul>
        {visible.map((g, gi) => (
          <li key={g.header ?? `other-${gi}`}>
            {/* Tiny job-name header — the no-job run only gets one ("Other") when it
                has to stand apart from real job groups. */}
            {(g.header || hasJobGroups) && (
              <div className="bg-slate-50/70 px-5 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                {g.header ?? "Other"}
              </div>
            )}
            <ul className="divide-y divide-slate-100">
              {g.tasks.map((t) => {
                const done = checked.has(t.id);
                const chip = dueChip(t.due_date, todayStr);
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      onClick={() => toggle(t)}
                      className="flex min-h-[44px] w-full items-center gap-3 px-5 py-1.5 text-left hover:bg-slate-50"
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
                      </span>
                      {chip && !done && (
                        <span className={`shrink-0 text-xs ${chip.overdue ? "font-medium text-red-600" : "text-slate-400"}`}>
                          {chip.label}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
      {truncated && (
        <Link
          href="/tasks"
          className="block border-t border-slate-100 px-5 py-2.5 text-center text-sm font-medium text-brand hover:bg-slate-50"
        >
          All tasks →
        </Link>
      )}
    </Card>
  );
}
