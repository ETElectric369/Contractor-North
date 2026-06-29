"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, Flag, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Modal, ModalActions } from "@/components/ui/modal";
import { formatDate } from "@/lib/utils";
import { createTask, toggleTask, deleteTask, updateTask, type TaskCategory } from "../../tasks/actions";

interface Task {
  id: string;
  title: string;
  category: string;
  status: string;
  priority: number;
  due_date: string | null;
}

export function JobTasks({ jobId, tasks }: { jobId: string; tasks: Task[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [category, setCategory] = useState<TaskCategory>("operations");
  const [high, setHigh] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editTask, setEditTask] = useState<Task | null>(null);

  const open = tasks.filter((t) => t.status !== "done");
  const done = tasks.filter((t) => t.status === "done");

  function add() {
    if (!title.trim()) return;
    setError(null);
    start(async () => {
      const res = await createTask({
        title,
        category,
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
          onChange={(e) =>
            start(async () => {
              await toggleTask(t.id, e.target.checked, { jobId });
              router.refresh();
            })
          }
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
        <Badge tone="slate">{t.category}</Badge>
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
              await deleteTask(t.id, { jobId });
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
            <Label htmlFor="t-cat">Area</Label>
            <Select id="t-cat" value={category} onChange={(e) => setCategory(e.target.value as TaskCategory)}>
              <option value="sales">Sales</option>
              <option value="operations">Operations</option>
              <option value="office">Office</option>
            </Select>
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
        <JobTaskEditModal key={editTask.id} task={editTask} jobId={jobId} onClose={() => setEditTask(null)} />
      )}
    </div>
  );
}

/** Edit a job task's title / due date / area / priority. Uses updateTask's
 *  partial patch, so it never touches the assignee or tags set elsewhere. */
function JobTaskEditModal({ task, jobId, onClose }: { task: Task; jobId: string; onClose: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState(task.title);
  const [dueDate, setDueDate] = useState(task.due_date ?? "");
  const [category, setCategory] = useState<TaskCategory>((task.category as TaskCategory) ?? "operations");
  const [high, setHigh] = useState(task.priority > 0);
  const [error, setError] = useState<string | null>(null);

  function save() {
    if (!title.trim()) return setError("Title is required.");
    setError(null);
    start(async () => {
      const res = await updateTask(
        task.id,
        { title, due_date: dueDate || null, category, priority: high ? 1 : 0 },
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
      footer={<ModalActions onCancel={onClose} onSave={save} saving={pending} saveLabel="Save changes" />}
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
            <Label htmlFor="jte-cat">Area</Label>
            <Select id="jte-cat" value={category} onChange={(e) => setCategory(e.target.value as TaskCategory)}>
              <option value="sales">Sales</option>
              <option value="operations">Operations</option>
              <option value="office">Office</option>
            </Select>
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
