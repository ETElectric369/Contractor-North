"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Flag, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Modal, ModalActions } from "@/components/ui/modal";
import { formatDate } from "@/lib/utils";
import { useToast } from "@/components/toast";
import { createTask, toggleTask, deleteTask, updateTask, type ToggleTaskResult } from "../../tasks/actions";

interface Task {
  id: string;
  title: string;
  /** Free-form since 0136; null = uncategorized. */
  category: string | null;
  status: string;
  priority: number;
  due_date: string | null;
}

/** Categories already used on THIS job — the datalist for the free-text field
 *  (free-form since 0136; the org-wide vocabulary lives on /tasks). */
function jobCategories(tasks: Task[]): string[] {
  const seen = new Map<string, string>();
  for (const t of tasks) {
    const raw = (t.category ?? "").trim();
    if (raw && !seen.has(raw.toLowerCase())) seen.set(raw.toLowerCase(), raw);
  }
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
}

export function JobTasks({ jobId, tasks }: { jobId: string; tasks: Task[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  // Pre-filled with the old fixed default so a quick add lands exactly where it
  // always did (the staff "Everything else" door) — clear it for "No category".
  const [category, setCategory] = useState("operations");
  const [high, setHigh] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const categories = jobCategories(tasks);

  const open = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");

  function add() {
    if (!title.trim()) return;
    setError(null);
    start(async () => {
      const res = await createTask({
        title,
        category: category.trim() || null,
        job_id: jobId,
        due_date: dueDate || null,
        priority: high ? 1 : 0,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setTitle("");
      setDueDate("");
      setHigh(false);
      router.refresh();
    });
  }

  function row(t: Task) {
    return (
      <li key={t.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
        <input
          type="checkbox"
          checked={t.status === "done"}
          onChange={(e) => {
            const checked = e.target.checked;
            start(async () => {
              // The toggleTask cascade contract (same as /tasks and My Day): completing a parent
              // with open subtasks writes NOTHING and returns needsCascade — confirm, then retry
              // with cascade:true. Without this the checkbox just snapped back under a red toast
              // that asked a question with no way to answer it. The count must come from
              // res.openChildren: the job hub never loads the children (subtasks made on /tasks
              // carry job_id = null, so the card's query can't see them).
              let res: ToggleTaskResult = await toggleTask(t.id, checked, { jobId });
              if (!res?.ok && res?.needsCascade && checked) {
                const n = res.openChildren ?? 0;
                if (!confirm(`"${t.title}" has ${n} open subtask${n === 1 ? "" : "s"} — mark ${n === 1 ? "it" : "them"} done too?`)) return;
                res = await toggleTask(t.id, checked, { jobId, cascade: true });
              }
              if (!res?.ok) { toast(res?.error ?? "Couldn't update task — try again.", "error"); return; }
              router.refresh();
            });
          }}
          className="h-4 w-4 shrink-0 rounded border-slate-300 text-brand focus:ring-brand"
        />
        <div className="min-w-0 flex-1">
          <div className={t.status === "done" ? "text-slate-400 line-through" : "font-medium text-slate-900"}>
            {t.priority > 0 && t.status !== "done" && (
              <Flag className="mr-1 inline h-3.5 w-3.5 text-red-500" />
            )}
            {t.title}
          </div>
          {t.due_date && (
            <div className="text-xs text-slate-400">Due {formatDate(t.due_date)}</div>
          )}
        </div>
        {t.category && <Badge tone="slate">{t.category}</Badge>}
        <button
          onClick={() => setEditTask(t)}
          className="text-slate-400 hover:text-brand"
          title="Edit"
        >
          <Pencil className="h-4 w-4" />
        </button>
        <button
          onClick={() => {
            if (!confirm(`Delete "${t.title}"? This can't be undone.`)) return;
            start(async () => {
              const res = await deleteTask(t.id, { jobId });
              if (!res?.ok) { toast(res?.error ?? "Couldn't delete task — try again.", "error"); return; }
              toast("Task deleted", "success");
              router.refresh();
            });
          }}
          className="text-slate-400 hover:text-red-600"
          title="Delete"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </li>
    );
  }

  return (
    <div>
      <div className="mb-3 space-y-3 rounded-lg border border-slate-200 p-3">
        {error && <p className="text-sm text-red-600">{error}</p>}
        <div>
          <Label htmlFor="t-title">New task</Label>
          <Input
            id="t-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="e.g. Order 200ft of 12/2 Romex"
          />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div>
            <Label htmlFor="t-due">Due date</Label>
            <Input id="t-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="t-cat">Category</Label>
            <Input
              id="t-cat"
              list={categories.length ? "jt-cat-options" : undefined}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Optional"
            />
            {categories.length > 0 && (
              <datalist id="jt-cat-options">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            )}
          </div>
          <label className="flex items-end gap-2 pb-2 text-sm text-slate-600">
            <input type="checkbox" checked={high} onChange={(e) => setHigh(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand" />
            High priority
          </label>
          <div className="flex items-end">
            <Button size="sm" onClick={add} disabled={pending || !title.trim()} className="w-full">
              <Plus className="h-3.5 w-3.5" /> Add
            </Button>
          </div>
        </div>
      </div>

      {tasks.length === 0 ? (
        <p className="py-4 text-center text-sm text-slate-400">No tasks for this job yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {open.map(row)}
          {done.map(row)}
        </ul>
      )}

      {editTask && (
        <JobTaskEditModal key={editTask.id} task={editTask} jobId={jobId} categories={categories} onClose={() => setEditTask(null)} />
      )}
    </div>
  );
}

/** Edit a job task's title / due date / category / priority. Uses updateTask's
 *  partial patch, so it never touches the assignee or tags set elsewhere. */
function JobTaskEditModal({ task, jobId, categories = [], onClose }: { task: Task; jobId: string; categories?: string[]; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState(task.title);
  const [dueDate, setDueDate] = useState(task.due_date ?? "");
  const [category, setCategory] = useState(task.category ?? "");
  const [high, setHigh] = useState(task.priority > 0);
  const [error, setError] = useState<string | null>(null);

  function save() {
    if (!title.trim()) return setError("Title is required.");
    setError(null);
    start(async () => {
      const res = await updateTask(
        task.id,
        { title, due_date: dueDate || null, category: category.trim() || null, priority: high ? 1 : 0 },
        { jobId },
      );
      if (!res.ok) return setError(res.error ?? "Could not save.");
      onClose();
      router.refresh();
    });
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit task"
      footer={<ModalActions onCancel={onClose} onSave={save} saving={pending} saveLabel="Save Changes" />}
    >
      <div className="space-y-4">
        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <div>
          <Label htmlFor="jte-title">Title</Label>
          <Input id="jte-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="jte-due">Due date</Label>
            <Input id="jte-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="jte-cat">Category</Label>
            <Input
              id="jte-cat"
              list={categories.length ? "jte-cat-options" : undefined}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Optional"
            />
            {categories.length > 0 && (
              <datalist id="jte-cat-options">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            )}
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={high} onChange={(e) => setHigh(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand" />
          High priority
        </label>
      </div>
    </Modal>
  );
}
