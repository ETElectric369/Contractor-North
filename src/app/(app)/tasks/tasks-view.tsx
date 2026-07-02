"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import { Plus, Trash2, Flag, Briefcase, Pencil, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Card } from "@/components/ui/card";
import { useToast } from "@/components/toast";
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

const CATEGORIES: { id: TaskCategory; label: string }[] = [
  { id: "sales", label: "Sales" },
  { id: "operations", label: "Operations" },
  { id: "office", label: "Office" },
];

// Category is a glance-chip on the row now, not the organizing principle —
// the sections answer "what's next", the chip answers "what kind".
const CATEGORY_CHIP: Record<string, string> = {
  sales: "bg-indigo-50 text-indigo-700",
  operations: "bg-green-50 text-green-700",
  office: "bg-amber-50 text-amber-700",
};
const categoryLabel = (id: string) => CATEGORIES.find((c) => c.id === id)?.label ?? id;

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
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<TaskCategory>(defaultCategory ?? "office");
  const [jobId, setJobId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [priority, setPriority] = useState(0);
  const [assignedTo, setAssignedTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Collapsed by default: one "Add a task…" field + Add. The category/job/assignee/
  // due/priority details reveal on focus — the quick capture stays a ~60px row.
  const [expanded, setExpanded] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  // Land ready to type from the quick-add menu's "New task" (/tasks?new=1),
  // then strip the param so a refresh doesn't re-grab focus.
  useEffect(() => {
    if (searchParams.get("new") !== "1") return;
    titleRef.current?.focus();
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    params.delete("new");
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [searchParams, pathname, router]);

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
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onFocus={() => setExpanded(true)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="Add a task…"
            className="min-w-[200px] flex-1"
          />
          {expanded && (
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
          )}
          <Button onClick={add} disabled={pending || !title.trim()}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>
        {expanded && (
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
        )}
      </div>
    </Card>
  );
}

/** Full edit modal: title, job, due date, priority, and assigned person. */
function TaskEditModal({
  t,
  jobs,
  people,
  category,
  open,
  onClose,
}: {
  t: ViewTask;
  jobs: JobOption[];
  people: Person[];
  category: TaskCategory;
  open: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState(t.title);
  const [jobId, setJobId] = useState(t.job_id ?? "");
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
          job_id: jobId || null,
          due_date: dueDate || null,
          priority,
          assigned_to: assignedTo || null,
          tags: tags.split(",").map((s) => s.trim()).filter(Boolean),
          notes: notes || null,
        },
        { category, jobId: t.job_id },
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
        <div>
          <Label htmlFor="te-job">Job</Label>
          <Select id="te-job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
            <option value="">— No job —</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>{j.job_number} · {j.name}</option>
            ))}
          </Select>
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
  jobs,
  people,
  category,
  subtasks = [],
  showCategory = false,
  overdue = false,
}: {
  t: ViewTask;
  jobs: JobOption[];
  people: Person[];
  category: TaskCategory;
  subtasks?: ViewTask[];
  showCategory?: boolean;
  overdue?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [subTitle, setSubTitle] = useState("");

  function addSub() {
    if (!subTitle.trim()) return;
    start(async () => {
      const res = await createTask({ title: subTitle, category, parent_id: t.id });
      if (!res?.ok) { toast(res?.error ?? "Couldn't add subtask — try again.", "error"); return; }
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
          onChange={(e) => start(async () => { const res = await toggleTask(t.id, e.target.checked, { category }); if (!res?.ok) { toast(res?.error ?? "Couldn't update task — try again.", "error"); return; } router.refresh(); })}
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
            {t.due_date && (
              <span className={overdue && t.status !== "done" ? "font-medium text-red-600" : undefined}>
                Due {formatDate(t.due_date)}
              </span>
            )}
            {t.priority > 0 && <span className={t.priority >= 2 ? "text-red-600" : "text-amber-600"}>{priorityLabel(t.priority)}</span>}
            {t.assignee?.full_name && (
              <span className="flex items-center gap-1"><User className="h-3 w-3" /> {t.assignee.full_name}</span>
            )}
            {t.jobs && (
              <Link href={`/jobs/${t.job_id}`} className="flex items-center gap-1 hover:text-brand">
                <Briefcase className="h-3 w-3" /> {t.jobs.name}
              </Link>
            )}
            {showCategory && (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${CATEGORY_CHIP[t.category] ?? "bg-slate-100 text-slate-500"}`}>
                {categoryLabel(t.category)}
              </span>
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
          onClick={() => {
            if (!confirm(`Delete "${t.title}"? This can't be undone.`)) return;
            start(async () => { const res = await deleteTask(t.id, { category }); if (!res?.ok) { toast(res?.error ?? "Couldn't delete task — try again.", "error"); return; } toast("Task deleted", "success"); router.refresh(); });
          }}
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
                onChange={(e) => start(async () => { const res = await toggleTask(st.id, e.target.checked, { category }); if (!res?.ok) { toast(res?.error ?? "Couldn't update subtask — try again.", "error"); return; } router.refresh(); })}
                className="h-3.5 w-3.5 rounded border-slate-300 text-brand focus:ring-brand"
              />
              <span className={`flex-1 ${st.status === "done" ? "text-slate-400 line-through" : "text-slate-700"}`}>{st.title}</span>
              <button
                onClick={() => {
                  if (!confirm(`Delete subtask "${st.title}"? This can't be undone.`)) return;
                  start(async () => { const res = await deleteTask(st.id, { category }); if (!res?.ok) { toast(res?.error ?? "Couldn't delete subtask — try again.", "error"); return; } toast("Subtask deleted", "success"); router.refresh(); });
                }}
                className="text-slate-300 hover:text-red-600"
              >
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
        <TaskEditModal t={t} jobs={jobs} people={people} category={category} open={editing} onClose={() => setEditing(false)} />
      )}
    </li>
  );
}

/** Saturday closing the Sunday-start week that contains `todayStr` (matches the planner/payroll week). */
function weekEndStr(todayStr: string): string {
  const d = new Date(`${todayStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (6 - d.getUTCDay()));
  return d.toISOString().slice(0, 10);
}

function TimeSection({
  label,
  tone,
  count,
  countClass = "text-slate-500",
  children,
  footer,
}: {
  label: string;
  tone: string;
  count: number;
  countClass?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card className={`overflow-hidden border ${tone}`}>
      <div className="flex items-center justify-between border-b border-slate-200/70 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-900">{label}</h3>
        <span className={`text-xs ${countClass}`}>{count}</span>
      </div>
      <ul className="divide-y divide-slate-100 bg-white">{children}</ul>
      {footer}
    </Card>
  );
}

/**
 * Tasks grouped by WHEN, not what kind — Overdue / Today / This week / Later /
 * Someday, in that order, so "what's next" is a 3-second read. Empty sections
 * stay hidden; completed sinks to the bottom behind a bounded fetch.
 */
export function TasksView({
  tasks,
  jobs,
  people = [],
  category,
  todayStr,
  doneTotal = 0,
  showingAllDone = false,
}: {
  tasks: ViewTask[];
  jobs: JobOption[];
  people?: Person[];
  category?: TaskCategory;
  todayStr: string;
  doneTotal?: number;
  showingAllDone?: boolean;
}) {
  const pathname = usePathname();

  // Nest subtasks under their parent; a subtask whose parent wasn't fetched
  // (e.g. an old completed parent past the done limit) surfaces as its own row.
  const ids = new Set(tasks.map((t) => t.id));
  const childrenByParent = new Map<string, ViewTask[]>();
  const top: ViewTask[] = [];
  for (const t of tasks) {
    if (t.parent_id && ids.has(t.parent_id)) {
      if (!childrenByParent.has(t.parent_id)) childrenByParent.set(t.parent_id, []);
      childrenByParent.get(t.parent_id)!.push(t);
    } else {
      top.push(t);
    }
  }

  const weekEnd = weekEndStr(todayStr);
  const openTop = top.filter((t) => t.status !== "done");
  const doneTop = top.filter((t) => t.status === "done");
  const doneFetched = tasks.filter((t) => t.status === "done").length;

  const row = (t: ViewTask, overdue = false) => (
    <TaskRow
      key={t.id}
      t={t}
      jobs={jobs}
      people={people}
      category={(t.category as TaskCategory) ?? "office"}
      subtasks={childrenByParent.get(t.id) ?? []}
      showCategory={!category}
      overdue={overdue}
    />
  );

  const sections: { key: string; label: string; tone: string; countClass?: string; tasks: ViewTask[]; overdue?: boolean }[] = [
    { key: "overdue", label: "Overdue", tone: "border-red-200 bg-red-50/60", countClass: "font-semibold text-red-600", overdue: true, tasks: openTop.filter((t) => !!t.due_date && t.due_date! < todayStr) },
    { key: "today", label: "Today", tone: "border-sky-200 bg-sky-50/60", tasks: openTop.filter((t) => t.due_date === todayStr) },
    { key: "week", label: "This week", tone: "border-slate-200 bg-slate-50/60", tasks: openTop.filter((t) => !!t.due_date && t.due_date! > todayStr && t.due_date! <= weekEnd) },
    { key: "later", label: "Later", tone: "border-slate-200 bg-slate-50/40", tasks: openTop.filter((t) => !!t.due_date && t.due_date! > weekEnd) },
    { key: "someday", label: "Someday", tone: "border-slate-200 bg-white", tasks: openTop.filter((t) => !t.due_date) },
  ].filter((s) => s.tasks.length > 0);

  return (
    <div>
      <NewTaskBox jobs={jobs} people={people} defaultCategory={category} />
      <div className="space-y-4">
        {sections.length === 0 && (
          <Card>
            <div className="px-4 py-8 text-center text-sm text-slate-400">Nothing open — add a task above.</div>
          </Card>
        )}
        {sections.map((s) => (
          <TimeSection key={s.key} label={s.label} tone={s.tone} count={s.tasks.length} countClass={s.countClass}>
            {s.tasks.map((t) => row(t, s.overdue))}
          </TimeSection>
        ))}
        {doneTop.length > 0 && (
          <TimeSection
            label="Completed"
            tone="border-slate-200 bg-slate-50/40"
            count={doneTotal || doneTop.length}
            countClass="text-slate-400"
            footer={
              !showingAllDone && doneTotal > doneFetched ? (
                <div className="border-t border-slate-200/70 bg-white px-4 py-2.5 text-center">
                  <Link href={`${pathname}?done=all`} className="text-xs font-medium text-brand hover:underline">
                    Show all completed ({doneTotal})
                  </Link>
                </div>
              ) : undefined
            }
          >
            {doneTop.map((t) => row(t))}
          </TimeSection>
        )}
      </div>
    </div>
  );
}
