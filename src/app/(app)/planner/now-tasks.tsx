"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ChevronRight, Package } from "lucide-react";
import { useToast } from "@/components/toast";
import { useLang } from "@/components/lang-provider";
import { fillText, translator } from "@/lib/i18n";
import { checkedOffWords, undoCheckOff } from "@/lib/job-tasks";
import { buyMaterialsTitle } from "@/lib/materials-checklist";
import { toggleTask, type ToggleTaskResult } from "../tasks/actions";

/**
 * THE CLOCKED-IN JOB'S TASKS, inside My Day's Now card (0358). A tech on the clock at J-055 sees
 * "Tasks: 3 left", the next three to check off with his thumb, and All Tasks for the job's whole list
 * (the job's Tasks tab). Off the clock the Now card has no job and so none of this: a job's list is
 * worked from the job, never piled into anyone's six. Every row is a 44px target.
 *
 * While the job's materials list has lines left to buy, the list leads with the one live "Buy
 * Materials · N Open" row (lib/materials-checklist, never a task row), which opens the list, the same
 * door as the Materials button above; `left` already counts it as one task.
 */
export function NowTasks({
  jobId,
  left,
  next,
  materials = null,
}: {
  jobId: string;
  left: number;
  next: { id: string; title: string }[];
  /** Lines left to buy on the job's list, and where the list is. null: nothing to buy. */
  materials?: { open: number; href: string } | null;
}) {
  const router = useRouter();
  const toast = useToast();
  // THE PERSON'S LANGUAGE (cn-v1138): the block's words come through t() and lib/words/myday.
  const lang = useLang();
  const t = translator(lang);
  const [pending, start] = useTransition();
  const [checked, setChecked] = useState<Set<string>>(new Set());

  function check(task: { id: string; title: string }) {
    const nowDone = !checked.has(task.id);
    setChecked((s) => {
      const n = new Set(s);
      if (nowDone) n.add(task.id);
      else n.delete(task.id);
      return n;
    });
    const revert = () =>
      setChecked((s) => {
        const n = new Set(s);
        if (nowDone) n.delete(task.id);
        else n.add(task.id);
        return n;
      });
    start(async () => {
      let res: ToggleTaskResult = await toggleTask(task.id, nowDone, { jobId });
      // The toggleTask cascade contract (the job's list does the same): a task with open steps asks
      // first, then checks them off with it. Never a question toasted with no way to answer it.
      if (!res.ok && res.needsCascade && nowDone) {
        const n = res.openChildren ?? 0;
        const ask = n === 1 ? fillText(t("md_openStepAskOne"), { title: task.title }) : fillText(t("md_openStepsAskMany"), { title: task.title, n: String(n) });
        if (!confirm(ask)) {
          revert();
          return;
        }
        res = await toggleTask(task.id, true, { jobId, cascade: true });
      }
      if (!res.ok) {
        revert();
        toast(res.error ?? t("md_couldNotUpdateTask"), "error");
        return;
      }
      // The block reads open tasks only, so a checked one leaves it on the refresh: an Undo keeps a
      // mis-tap one tap away. A check-off that closed open steps with it says so, and its Undo
      // reopens exactly those steps (closedSteps), never one that was already done.
      if (nowDone) {
        const closed = res.closedSteps ?? [];
        toast(checkedOffWords(task.title, closed.length), "success", {
          label: t("md_undo"),
          onClick: () => {
            setChecked((s) => {
              const n = new Set(s);
              n.delete(task.id);
              return n;
            });
            void undoCheckOff(toggleTask, task, closed, jobId).then((back) => {
              if (back.say) toast(back.say.text, back.say.tone);
              router.refresh();
            });
          },
        });
      }
      router.refresh();
    });
  }

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 pl-3 pr-2">
        <span className="py-2 text-sm font-semibold text-slate-900">{fillText(t("md_tasksLeft"), { n: String(left) })}</span>
        <Link
          href={`/jobs/${jobId}?tab=tasks`}
          className="inline-flex min-h-[44px] items-center px-1 text-sm font-medium text-brand hover:underline"
        >
          {t("md_allTasks")}
        </Link>
      </div>
      <ul className="divide-y divide-slate-100">
        {materials && materials.open > 0 && (
          <li>
            <Link href={materials.href} className="flex min-h-[44px] w-full items-center gap-3 px-3 py-1.5 hover:bg-slate-50">
              <Package className="h-5 w-5 shrink-0 text-brand" aria-hidden />
              <span className="min-w-0 flex-1 text-sm font-medium text-slate-900">{buyMaterialsTitle(materials)}</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
            </Link>
          </li>
        )}
        {next.slice(0, materials && materials.open > 0 ? 2 : 3).map((task) => {
          const done = checked.has(task.id);
          return (
            <li key={task.id}>
              <button
                type="button"
                onClick={() => check(task)}
                disabled={pending}
                className="flex min-h-[44px] w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-slate-50"
                aria-label={fillText(t(done ? "md_reopenTask" : "md_checkOffTask"), { title: task.title })}
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                    done ? "border-brand bg-brand text-white" : "border-slate-300"
                  }`}
                >
                  {done && <Check className="h-3.5 w-3.5" />}
                </span>
                <span className={`min-w-0 flex-1 text-sm ${done ? "text-slate-400 line-through" : "font-medium text-slate-900"}`}>{task.title}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
