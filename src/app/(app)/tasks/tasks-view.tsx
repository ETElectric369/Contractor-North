"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Trash2, Flag, Briefcase, Pencil, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
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
  assigned_to: string | null;
  notes?: string | null;
  parent_id?: string | null;
  tags?: string[] | null;
  jobs?: { job_number: string; name: string } | null;
  assignee?: { full_name: string | null } | null;
}

interface JobOption {
  id: string;
  job_number: string;
  name: string;
}
interface Person {
  id: string;
  full_name: string | null;
}

const CATEGORIES: { id: TaskCategory; label: string; tone: string }[] = [
  { id: "sales", label: "Sales", tone: "border-indigo-200 bg-indigo-50/60" },
  { id: "operations", label: "Operations", tone: "border-green-200 bg-green-50/60" },
  { id: "office", label: "Office", tone: "border-amber-200 bg-amber-50/60" },
];

const PRIORITIES: { value: number; label: string }[] = [
  { value: 0, label: "Normal" },
  { value: 1, label: "High" },
  { value: 2, label: "Urgent" },
];
const priorityLabel = (p: number) => PRIORITIES.find((x) => x.value === p)?.label ?? "High";

/** ONE entry box for all tasks — category picked from a dropdown. */
export function NewTaskBox({
  jobs,
  people,
  defaultCategory,
}: {
  jobs: JobOption[];
  people: Person[];
  defaultCategory?: TaskCategory;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<TaskCategory>(defaultCategory ?? "office");
  const [jobId, setJobId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [priority, setPriority] = useState(0);
  const [assignedTo, setAssignedTo] = useState("");
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
        priority,
        assigned_to: assignedTo || null,
      });
      if (!res.ok) return setError(res.error ?? "Could not save.");
      setTitle("");
      setJobId("");
      setDueDate("");
      setPriority(0);
      setAssignedTo("");
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
        <div className="flex flex-wrap items-center gap-2">
          <Select value={jobId} onChange={(e) => setJobId(e.target.value)} className="w-48 text-xs" aria-label="Job">
            <option value="">No job</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>{j.job_number} · {j.name}</option>
            ))}
          </Select>
          {people.length > 0 && (
            <Select value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)} className="w-40 text-xs" aria-label="Assigned to">
              <option value="">Unassigned</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>{p.full_name ?? "Unnamed"}</option>
              ))}
            </Select>
          )}
          <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="w-40 text-xs" aria-label="Due date" />
          <Select value={priority} onChange={(e) => setPriority(Number(e.target.value))} className="w-28 text-xs" aria-label="Priority">
            {PRIORITIES.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </Select>
        </div>
      </div>
    </Card>
  );
}

/** Full edit modal: title, due date, priority, and assigned person. */
function TaskEditModal({
  t,
  people,
  category,
  open,
  onClose,
}: {
  t: ViewTask;
  people: Person[];
  category: TaskCategory;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState(t.title);
  const [dueDate, setDueDate] = useState(t.due_date ?? "");
  const [priority, setPriority] = useState(t.priority);
  const [assignedTo, setAssignedTo] = useState(t.assigned_to ?? "");
  const [tags, setTags] = useState((t.tags ?? []).join(", "));
  const [notes, setNotes] = useState(t.notes ?? "");
  const [error, setError] = useState<string | null>(null);

  function save() {
    if (!title.trim()) return setError("Title is required.");
    setError(null);
    start(async () => {
      const res = await updateTask(
        t.id,
        {
          title,
          due_date: dueDate || null,
          priority,
          assigned_to: assignedTo || null,
          tags: tags.split(",").map((s) => s.trim()).filter(Boolean),
          notes: notes || null,
        },
        { category },
      );
      if (!res.ok) return setError(res.error ?? "Could not save.");
      onClose();
      router.refresh();
    });
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Edit task"
      footer={<ModalActions onCancel={onClose} onSave={save} saving={pending} saveLabel="Save changes" />}
    >
      <div className="space-y-4">
        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <div>
          <Label htmlFor="te-title">Title</Label>
          <Input id="te-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="te-due">Due date</Label>
            <Input id="te-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
          <div>
            <Label htmlFor="te-pri">Priority</Label>
            <Select id="te-pri" value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
              {PRIORITIES.map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </Select>
          </div>
        </div>
        <div>
          <Label htmlFor="te-person">Assigned to</Label>
          <Select id="te-person" value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
            <option value="">Unassigned</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>{p.full_name ?? "Unnamed"}</option>
            ))}
          </Select>
        </div>
        <div>
          <Label htmlFor="te-tags">Tags</Label>
          <Input id="te-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="comma, separated, tags" />
        </div>
        <div>
          <Label htmlFor="te-notes">Notes</Label>
          <Textarea id="te-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} placeholder="Add any details or context…" />
        </div>
      </div>
    </Modal>
  );
}

export function TaskRow({
  t,
  people,
  category,
  subtasks = [],
}: {
  t: ViewTask;
  people: Person[];
  category: TaskCategory;
  subtasks?: ViewTask[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [subTitle, setSubTitle] = useState("");

  function addSub() {
    if (!subTitle.trim()) return;
    start(async () => {
      await createTask({ title: subTitle, category, parent_id: t.id });
      setSubTitle("");
      setAdding(false);
      router.refresh();
    });
  }

  return (
    <li className="px-4 py-2.5 text-sm">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={t.status === "done"}
          onChange={(e) => start(async () => { await toggleTask(t.id, e.target.checked, { category }); router.refresh(); })}
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand focus:ring-brand"
        />
        <div className="min-w-0 flex-1">
          <div className={t.status === "done" ? "text-slate-400 line-through" : "font-medium text-slate-900"}>
            {t.priority > 0 && t.status !== "done" && (
              <Flag className={`mr-1 inline h-3.5 w-3.5 ${t.priority >= 2 ? "text-red-600" : "text-amber-500"}`} />
            )}
            {t.title}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            {t.due_date && <span>Due {formatDate(t.due_date)}</span>}
            {t.priority > 0 && <span className={t.priority >= 2 ? "text-red-600" : "text-amber-600"}>{priorityLabel(t.priority)}</span>}
            {t.assignee?.full_name && (
              <span className="flex items-center gap-1"><User className="h-3 w-3" /> {t.assignee.full_name}</span>
            )}
            {t.jobs && (
              <Link href={`/jobs/${t.job_id}`} className="flex items-center gap-1 hover:text-brand">
                <Briefcase className="h-3 w-3" /> {t.jobs.name}
              </Link>
            )}
            {(t.tags ?? []).map((tag) => (
              <span key={tag} className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">#{tag}</span>
            ))}
          </div>
        </div>
        <button onClick={() => setAdding((v) => !v)} className="text-slate-300 hover:text-brand" title="Add subtask">
          <Plus className="h-4 w-4" />
        </button>
        <button onClick={() => setEditing(true)} className="text-slate-300 hover:text-slate-600" title="Edit">
          <Pencil className="h-4 w-4" />
        </button>
        <button
          onClick={() => start(async () => { await deleteTask(t.id, { category }); router.refresh(); })}
          disabled={pending}
          className="text-slate-300 hover:text-red-600"
          title="Delete"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>

      {(subtasks.length > 0 || adding) && (
        <ul className="ml-7 mt-1.5 space-y-1 border-l border-slate-100 pl-3">
          {/* checked items sink to the bottom (stable within each group) */}
          {[...subtasks]
            .sort((a, b) => (a.status === "done" ? 1 : 0) - (b.status === "done" ? 1 : 0))
            .map((st) => (
            <li key={st.id} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={st.status === "done"}
                onChange={(e) => start(async () => { await toggleTask(st.id, e.target.checked, { category }); router.refresh(); })}
                className="h-3.5 w-3.5 rounded border-slate-300 text-brand focus:ring-brand"
              />
              <span className={`flex-1 ${st.status === "done" ? "text-slate-400 line-through" : "text-slate-700"}`}>{st.title}</span>
              <button onClick={() => start(async () => { await deleteTask(st.id, { category }); router.refresh(); })} className="text-slate-300 hover:text-red-600">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
          {adding && (
            <li className="flex items-center gap-2">
              <Input value={subTitle} onChange={(e) => setSubTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addSub()} placeholder="Subtask…" autoFocus className="h-7 text-xs" />
              <Button size="sm" onClick={addSub} disabled={pending || !subTitle.trim()} className="h-7 px-2.5 text-xs">Add</Button>
            </li>
          )}
        </ul>
      )}

      {editing && (
        <TaskEditModal t={t} people={people} category={category} open={editing} onClose={() => setEditing(false)} />
      )}
    </li>
  );
}

function TaskColumn({
  category,
  label,
  tone,
  tasks,
  people,
}: {
  category: TaskCategory;
  label: string;
  tone: string;
  tasks: ViewTask[];
  people: Person[];
}) {
  // Nest subtasks under their parent; only top-level tasks are columns rows.
  const childrenByParent = new Map<string, ViewTask[]>();
  for (const t of tasks) {
    if (t.parent_id) {
      if (!childrenByParent.has(t.parent_id)) childrenByParent.set(t.parent_id, []);
      childrenByParent.get(t.parent_id)!.push(t);
    }
  }
  const top = tasks.filter((t) => !t.parent_id);
  const open = top.filter((t) => t.status !== "done");
  const done = top.filter((t) => t.status === "done");
  const row = (t: ViewTask) => (
    <TaskRow key={t.id} t={t} people={people} category={category} subtasks={childrenByParent.get(t.id) ?? []} />
  );

  return (
    <Card className={`overflow-hidden border ${tone}`}>
      <div className="flex items-center justify-between border-b border-slate-200/70 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-900">{label}</h3>
        <span className="text-xs text-slate-500">{open.length} open</span>
      </div>
      <ul className="divide-y divide-slate-100 bg-white">
        {top.length === 0 ? (
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
  people = [],
  category,
}: {
  tasks: ViewTask[];
  jobs: JobOption[];
  people?: Person[];
  category?: TaskCategory;
}) {
  const cols = category ? CATEGORIES.filter((c) => c.id === category) : CATEGORIES;
  return (
    <div>
      <NewTaskBox jobs={jobs} people={people} defaultCategory={category} />
      <div className={category ? "" : "grid gap-4 lg:grid-cols-3"}>
        {cols.map((c) => (
          <TaskColumn
            key={c.id}
            category={c.id}
            label={c.label}
            tone={c.tone}
            tasks={tasks.filter((t) => t.category === c.id)}
            people={people}
          />
        ))}
      </div>
    </div>
  );
}
