"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Trash2, Flag, Briefcase, Pencil, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { formatDate } from "@/lib/utils";
import { createTask, toggleTask, deleteTask, updateTask, type TaskCategory } from "./actions";

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

/** ONE entry box for all tasks — category picked from a dropdown. */
function NewTaskBox({
  jobs,
  defaultCategory,
}: {
  jobs: JobOption[];
  defaultCategory?: TaskCategory;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<TaskCategory>(defaultCategory ?? "office");
  const [jobId, setJobId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [high, setHigh] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <Card className="mb-4">
      <div className="space-y-2 p-4">
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="Add a task…"
            className="min-w-[200px] flex-1"
          />
          <Select
            value={category}
            onChange={(e) => setCategory(e.target.value as TaskCategory)}
            className="w-36"
            aria-label="Category"
          >
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </Select>
          <Button onClick={add} disabled={pending || !title.trim()}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Select value={jobId} onChange={(e) => setJobId(e.target.value)} className="w-52 text-xs" aria-label="Job">
            <option value="">No job</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>{j.job_number} · {j.name}</option>
            ))}
          </Select>
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="w-40 text-xs" aria-label="Due date" />
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            <input type="checkbox" checked={high} onChange={(e) => setHigh(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand" />
            High priority
          </label>
        </div>
      </div>
    </Card>
  );
}

function TaskRow({ t, category }: { t: ViewTask; category: TaskCategory }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(t.title);

  function saveTitle() {
    if (!title.trim() || title.trim() === t.title) {
      setEditing(false);
      setTitle(t.title);
      return;
    }
    start(async () => {
      await updateTask(t.id, { title }, { category });
      setEditing(false);
      router.refresh();
    });
  }

  return (
    <li className="flex items-start gap-3 px-4 py-2.5 text-sm">
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
        {editing ? (
          <div className="flex items-center gap-1.5">
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveTitle();
                if (e.key === "Escape") { setEditing(false); setTitle(t.title); }
              }}
              autoFocus
              className="h-8 text-sm"
            />
            <button onClick={saveTitle} disabled={pending} className="rounded bg-brand p-1 text-white" aria-label="Save">
              <Check className="h-3.5 w-3.5" />
            </button>
            <button onClick={() => { setEditing(false); setTitle(t.title); }} className="rounded p-1 text-slate-400 hover:bg-slate-100" aria-label="Cancel">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div className={t.status === "done" ? "text-slate-400 line-through" : "font-medium text-slate-900"}>
            {t.priority > 0 && t.status !== "done" && (
              <Flag className="mr-1 inline h-3.5 w-3.5 text-red-500" />
            )}
            {t.title}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
          {t.due_date && <span>Due {formatDate(t.due_date)}</span>}
          {t.jobs && (
            <Link href={`/jobs/${t.job_id}`} className="flex items-center gap-1 hover:text-brand">
              <Briefcase className="h-3 w-3" /> {t.jobs.name}
            </Link>
          )}
        </div>
      </div>
      {!editing && (
        <button
          onClick={() => setEditing(true)}
          className="text-slate-300 hover:text-slate-600"
          title="Edit"
        >
          <Pencil className="h-4 w-4" />
        </button>
      )}
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

function TaskColumn({
  category,
  label,
  tone,
  tasks,
}: {
  category: TaskCategory;
  label: string;
  tone: string;
  tasks: ViewTask[];
}) {
  const open = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");

  return (
    <Card className={`overflow-hidden border ${tone}`}>
      <div className="flex items-center justify-between border-b border-slate-200/70 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-900">{label}</h3>
        <span className="text-xs text-slate-500">{open.length} open</span>
      </div>
      <ul className="divide-y divide-slate-100 bg-white">
        {tasks.length === 0 ? (
          <li className="px-4 py-6 text-center text-sm text-slate-400">No {label.toLowerCase()} tasks yet.</li>
        ) : (
          <>
            {open.map((t) => <TaskRow key={t.id} t={t} category={category} />)}
            {done.map((t) => <TaskRow key={t.id} t={t} category={category} />)}
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
    <div>
      <NewTaskBox jobs={jobs} defaultCategory={category} />
      <div className={category ? "" : "grid gap-4 lg:grid-cols-3"}>
        {cols.map((c) => (
          <TaskColumn
            key={c.id}
            category={c.id}
            label={c.label}
            tone={c.tone}
            tasks={tasks.filter((t) => t.category === c.id)}
          />
        ))}
      </div>
    </div>
  );
}
