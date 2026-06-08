"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ListChecks, Flag, ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { toggleTask } from "@/app/(app)/tasks/actions";

export interface WidgetTask {
  id: string;
  title: string;
  category: string;
  priority: number;
  due_date: string | null;
  job_id: string | null;
  jobs?: { name: string } | null;
}

export function TasksWidget({ tasks }: { tasks: WidgetTask[] }) {
  const router = useRouter();
  const [, start] = useTransition();
  // Optimistically hide a task the moment it's checked off.
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());

  function complete(id: string, category: string) {
    setDoneIds((prev) => new Set(prev).add(id));
    start(async () => {
      await toggleTask(id, true, { category });
      router.refresh();
    });
  }

  const visible = tasks.filter((t) => !doneIds.has(t.id));

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <ListChecks className="h-4 w-4 text-brand" /> Today's priorities
        </h3>
        <Link href="/tasks" className="flex items-center gap-1 text-xs text-brand hover:underline">
          All tasks <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <ul className="divide-y divide-slate-100">
        {visible.length === 0 ? (
          <li className="px-5 py-8 text-center text-sm text-slate-400">
            Nothing pressing.{" "}
            <Link href="/tasks" className="text-brand hover:underline">
              Add a task
            </Link>
            .
          </li>
        ) : (
          visible.map((t) => (
            <li key={t.id} className="flex items-center gap-3 px-5 py-3 text-sm">
              <input
                type="checkbox"
                onChange={() => complete(t.id, t.category)}
                className="h-4 w-4 shrink-0 rounded border-slate-300 text-brand focus:ring-brand"
                title="Mark done"
              />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-slate-900">
                  {t.priority > 0 && <Flag className="mr-1 inline h-3.5 w-3.5 text-red-500" />}
                  {t.title}
                </div>
                <div className="text-xs text-slate-400">
                  {t.due_date ? `Due ${formatDate(t.due_date)}` : "No due date"}
                  {t.jobs?.name ? ` · ${t.jobs.name}` : ""}
                </div>
              </div>
              <Badge tone="slate">{t.category}</Badge>
            </li>
          ))
        )}
      </ul>
    </Card>
  );
}
