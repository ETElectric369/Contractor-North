"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Trash2, Flag, Briefcase } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";
import { createTask, toggleTask, deleteTask, type TaskCategory } from "./actions";

export interface ViewTask {
  id: string;
  title: string;
  category: string;
  status: string;
  priority: number;
  due_date: string | null;
  job_id: string | null;
  jobs?: { job_number: string; name: string } | null;
}

interface JobOption {
  id: string;
  job_number: string;
  name: string;
}

const CATEGORIES: { id: TaskCategory; label: string; tone: string }[] = [
  { id: "sales", label: "Sales", tone: "border-indigo-200 bg-indigo-50/60" },
  { id: "operations", label: "Operations", tone: "border-green-200 bg-green-50/60" },
  { id: "office", label: "Office", tone: "border-amber-200 bg-amber-50/60" },
];

function TaskColumn({
  category,
  label,
  tone,
  tasks,
  jobs,
}: {
  category: TaskCategory;
  label: string;
  tone: string;
  tasks: ViewTask[];
  jobs: JobOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState("");
  const [jobId, setJobId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [high, setHigh] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");

  function add() {
    if (!title.trim()) return;
    setError(null);
    start(async () => {
      const res = await createTask({
        title,
        category,
        job_id: jobId || null,
        due_date: dueDate || null,
        priority: high ? 1 : 0,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setTitle("");
      setJobId("");
      setDueDate("");
      setHigh(false);
      router.refresh();
    });
  }

  function row(t: ViewTask) {
    return (
      <li key={t.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
        <input
          type="checkbox"
          checked={t.status === "done"}
          onChange={(e) =>
            start(async () => {
              await toggleTask(t.id, e.target.checked, { category });
              router.refresh();
            })
          }
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand focus:ring-brand"
        />
        <div className="min-w-0 flex-1">
          <div className={t.status === "done" ? "text-slate-400 line-through" : "font-medium text-slate-900"}>
            {t.priority > 0 && t.status !== "done" && (
              <Flag className="mr-1 inline h-3.5 w-3.5 text-red-500" />
            )}
            {t.title}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            {t.due_date && <span>Due {formatDate(t.due_date)}</span>}
            {t.jobs && (
              <Link href={`/jobs/${t.job_id}`} className="flex items-center gap-1 hover:text-brand">
                <Briefcase className="h-3 w-3" /> {t.jobs.name}
              </Link>
            )}
          </div>
        </div>
        <button
          onClick={() =>
            start(async () => {
              await deleteTask(t.id, { category });
              router.refresh();
            })
          }
          className="text-slate-300 hover:text-red-600"
          title="Delete"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </li>
    );
  }

  return (
    <Card className={`overflow-hidden border ${tone}`}>
      <div className="flex items-center justify-between border-b border-slate-200/70 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-900">{label}</h3>
        <span className="text-xs text-slate-500">{open.length} open</span>
      </div>

      <div className="space-y-2 border-b border-slate-200/70 bg-white/70 px-4 py-3">
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex gap-2">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="Add a task…"
          />
          <Button size="sm" onClick={add} disabled={pending || !title.trim()}>
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">Job (optional)</Label>
            <Select value={jobId} onChange={(e) => setJobId(e.target.value)}>
              <option value="">— None —</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.job_number} · {j.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label className="text-xs">Due date</Label>
            <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" checked={high} onChange={(e) => setHigh(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand" />
          High priority
        </label>
      </div>

      <ul className="divide-y divide-slate-100 bg-white">
        {tasks.length === 0 ? (
          <li className="px-4 py-6 text-center text-sm text-slate-400">No {label.toLowerCase()} tasks yet.</li>
        ) : (
          <>
            {open.map(row)}
            {done.map(row)}
          </>
        )}
      </ul>
    </Card>
  );
}

export function TasksView({
  tasks,
  jobs,
  category,
}: {
  tasks: ViewTask[];
  jobs: JobOption[];
  category?: TaskCategory;
}) {
  const cols = category ? CATEGORIES.filter((c) => c.id === category) : CATEGORIES;
  return (
    <div className={category ? "" : "grid gap-4 lg:grid-cols-3"}>
      {cols.map((c) => (
        <TaskColumn
          key={c.id}
          category={c.id}
          label={c.label}
          tone={c.tone}
          tasks={tasks.filter((t) => t.category === c.id)}
          jobs={jobs}
        />
      ))}
    </div>
  );
}
