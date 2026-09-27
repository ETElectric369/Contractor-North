"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { useToast } from "@/components/toast";
import { toggleTask, type ToggleTaskResult } from "../tasks/actions";

/**
 * THE CLOCKED-IN JOB'S TASKS, inside My Day's Now block (0358). A tech on the clock at J-055 sees
 * "Tasks: 3 left", the next three to check off with his thumb, and All Tasks for the job's whole list
 * (the job's Tasks tab). Off the clock there is no Now block and so none of this: a job's list is
 * worked from the job, never piled into anyone's six. Every row is a 44px target.
 */
export function NowTasks({ jobId, left, next }: { jobId: string; left: number; next: { id: string; title: string }[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [checked, setChecked] = useState<Set<string>>(new Set());

  function check(t: { id: string; title: string }) {
    const nowDone = !checked.has(t.id);
    setChecked((s) => {
      const n = new Set(s);
      if (nowDone) n.add(t.id);
      else n.delete(t.id);
      return n;
    });
    const revert = () =>
      setChecked((s) => {
        const n = new Set(s);
        if (nowDone) n.delete(t.id);
        else n.add(t.id);
        return n;
      });
    start(async () => {
      let res: ToggleTaskResult = await toggleTask(t.id, nowDone, { jobId });
      // The toggleTask cascade contract (the job's list does the same): a task with open steps asks
      // first, then checks them off with it. Never a question toasted with no way to answer it.
      if (!res.ok && res.needsCascade && nowDone) {
        const n = res.openChildren ?? 0;
        if (!confirm(`"${t.title}" has ${n} open step${n === 1 ? "" : "s"}. Mark ${n === 1 ? "it" : "them"} done too?`)) {
          revert();
          return;
        }
        res = await toggleTask(t.id, true, { jobId, cascade: true });
      }
      if (!res.ok) {
        revert();
        toast(res.error ?? "Couldn't update the task. Try again.", "error");
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 pl-3 pr-2">
        <span className="py-2 text-sm font-semibold text-slate-900">Tasks: {left} left</span>
        <Link
          href={`/jobs/${jobId}?tab=tasks`}
          className="inline-flex min-h-[44px] items-center px-1 text-sm font-medium text-brand hover:underline"
        >
          All Tasks
        </Link>
      </div>
      <ul className="divide-y divide-slate-100">
        {next.map((t) => {
          const done = checked.has(t.id);
          return (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => check(t)}
                disabled={pending}
                className="flex min-h-[44px] w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-slate-50"
                aria-label={done ? `Reopen ${t.title}` : `Check off ${t.title}`}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                    done ? "border-brand bg-brand text-white" : "border-slate-300"
                  }`}
                >
                  {done && <Check className="h-3.5 w-3.5" />}
                </span>
                <span className={`min-w-0 flex-1 text-sm ${done ? "text-slate-400 line-through" : "font-medium text-slate-900"}`}>{t.title}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
