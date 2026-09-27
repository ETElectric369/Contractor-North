"use client";

import { useEffect, useId, useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import Link from "next/link";
import { Plus, Trash2, Flag, Pencil, Pin, User, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Card } from "@/components/ui/card";
import { MoveToDay } from "@/components/move-to-day";
import { useToast } from "@/components/toast";
import { formatDate } from "@/lib/utils";
import { createTask, toggleTask, deleteTask, updateTask, type ToggleTaskResult } from "./actions";

/**
 * THE REMINDERS PAGE (/tasks, since 0358). A Reminder is a task with no job, and it is private: the
 * person who made it and the person it is for see it, nobody else (0358's tasks_read; the page's
 * read says the same on a database without it). A job's tasks are the job's one list, on the job
 * (its Tasks chip) and in My Day's Now block, never here. To-Do Extras (priority, steps, tags)
 * reaches Reminders only.
 */
export interface ViewTask {
  id: string;
  title: string;
  /** Free-form since 0136; null = uncategorized ("No category"). */
  category: string | null;
  status: string;
  priority: number;
  due_date: string | null;
  /** = today means pinned into My Day's six (self-expires at midnight). */
  focus_date?: string | null;
  job_id: string | null;
  assigned_to: string | null;
  notes?: string | null;
  parent_id?: string | null;
  tags?: string[] | null;
  assignee?: { full_name: string | null } | null;
}

interface Person {
  id: string;
  full_name: string | null;
}

// Categories are free-form since 0136 — the org's own vocabulary, no fixed
// list. The legacy three keep their pretty labels + chip colors; anything
// else gets a capitalized label and the neutral chip.
const LEGACY_LABELS: Record<string, string> = {
  sales: "Sales",
  operations: "Operations",
  office: "Office",
};

// Category is a glance-chip on the row (default view), not the organizing
// principle — the sections answer "what's next", the chip answers "what kind".
const CATEGORY_CHIP: Record<string, string> = {
  sales: "bg-indigo-50 text-indigo-700",
  operations: "bg-green-50 text-green-700",
  office: "bg-amber-50 text-amber-700",
};
const categoryLabel = (id: string) =>
  LEGACY_LABELS[id.toLowerCase()] ?? id.charAt(0).toUpperCase() + id.slice(1);

/** Datalist-backed free-text category input — autocompletes the org's OWN
 *  existing values (no invented taxonomy), still accepts anything new. */
function CategoryInput({
  value,
  onChange,
  categories = [],
  id,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  categories?: string[];
  id?: string;
  className?: string;
}) {
  const listId = useId();
  return (
    <>
      <Input
        id={id}
        list={categories.length ? listId : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Category (optional)"
        aria-label="Category"
        className={className}
      />
      {categories.length > 0 && (
        <datalist id={listId}>
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      )}
    </>
  );
}

const PRIORITIES: { value: number; label: string }[] = [
  { value: 0, label: "Normal" },
  { value: 1, label: "High" },
  { value: 2, label: "Urgent" },
];
const priorityLabel = (p: number) => PRIORITIES.find((x) => x.value === p)?.label ?? "High";

/**
 * THE ONE-LINE ADD (0358: the 6-field box — category, job, person, due, priority — became this).
 * Type the words, Add: a Reminder for yourself, undated (it waits under Someday here; pin it or date
 * it to put it in Today's 6). Everything else is one tap on the row afterwards. A job's task is added
 * on the job, or from My Day's Add line with a job picked.
 */
export function NewReminderBox() {
  const router = useRouter();
  const toast = useToast();
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);

  // Land ready to type from the quick-add menu's New Reminder (/tasks?new=1),
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
    start(async () => {
      const res = await createTask({ title });
      if (!res.ok) {
        toast(res.error ?? "Couldn't add the reminder. Try again.", "error");
        return;
      }
      toast(res.duplicate ? (res.speak ?? "Already on the list.") : "Reminder added", res.duplicate ? "info" : "success");
      setTitle("");
      router.refresh();
    });
  }

  return (
    <Card className="mb-4">
      <div className="flex items-center gap-2 p-3">
        <Input
          ref={titleRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="Add A Reminder…"
          aria-label="Add A Reminder"
          className="h-11 min-w-0 flex-1"
        />
        <Button onClick={add} disabled={pending || !title.trim()} className="shrink-0 px-3">
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>
    </Card>
  );
}

/** Full edit modal: title, category, due date, priority, who it's for, tags, notes. No job: a
 *  Reminder is not a job's task (0358); a job's list is worked on the job. */
function TaskEditModal({
  t,
  people,
  category,
  categories,
  open,
  onClose,
  extras = true,
}: {
  t: ViewTask;
  people: Person[];
  category: string | null;
  /** Existing category values for the autocomplete datalist. */
  categories?: string[];
  open: boolean;
  onClose: () => void;
  /** To-Do Extras (0352): off, no Priority or Tags fields; the reminder keeps what it has. */
  extras?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [title, setTitle] = useState(t.title);
  const [cat, setCat] = useState(t.category ?? "");
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
          category: cat.trim() || null,
          due_date: dueDate || null,
          priority,
          assigned_to: assignedTo || null,
          // Tags follow To-Do Extras: off, the field isn't drawn and the reminder keeps its tags.
          ...(extras ? { tags: tags.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
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
      title="Edit Reminder"
      footer={<ModalActions onCancel={onClose} onSave={save} saving={pending} saveLabel="Save Changes" />}
    >
      <div className="space-y-4">
        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        <div>
          <Label htmlFor="te-title">Title</Label>
          <Input id="te-title" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </div>
        <div>
          <Label htmlFor="te-cat">Category</Label>
          <CategoryInput id="te-cat" value={cat} onChange={setCat} categories={categories} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Due date</Label>
            {/* The one move-to-day sheet, app-wide idiom — picks into local form
                state here; nothing saves until "Save changes". */}
            <MoveToDay
              label="Due date"
              clearable
              onPick={(iso) => setDueDate(iso ?? "")}
              triggerClassName="flex h-10 w-full items-center rounded-lg border border-slate-300 bg-white px-3 text-left text-sm hover:border-brand"
            >
              {dueDate ? (
                <span className="text-slate-900">{formatDate(dueDate)}</span>
              ) : (
                <span className="text-slate-400">No due date</span>
              )}
            </MoveToDay>
          </div>
          {extras && (
            <div>
              <Label htmlFor="te-pri">Priority</Label>
              <Select id="te-pri" value={priority} onChange={(e) => setPriority(Number(e.target.value))}>
                {PRIORITIES.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </Select>
            </div>
          )}
        </div>
        <div>
          {/* A Reminder is private to its maker and the person it's for (0358): only they see it. */}
          <Label htmlFor="te-person">Who It&rsquo;s For</Label>
          <Select id="te-person" value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
            <option value="">Whoever Made It</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>{p.full_name ?? "Unnamed"}</option>
            ))}
          </Select>
        </div>
        {extras && (
          <div>
            <Label htmlFor="te-tags">Tags</Label>
            <Input id="te-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="comma, separated, tags" />
          </div>
        )}
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
  categories,
  subtasks = [],
  showCategory = false,
  overdue = false,
  todayStr,
  extras = true,
}: {
  t: ViewTask;
  people: Person[];
  category: string | null;
  /** Existing category values — feeds the edit modal's autocomplete. */
  categories?: string[];
  subtasks?: ViewTask[];
  showCategory?: boolean;
  overdue?: boolean;
  /** Org-local today — enables the "Do today" pin (focus_date) affordance. */
  todayStr?: string;
  /** To-Do Extras (0352): off, no Add Subtask; subtasks already there stay listed and tickable. */
  extras?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [subTitle, setSubTitle] = useState("");
  const pinnedToday = !!todayStr && t.focus_date === todayStr;

  function addSub() {
    if (!subTitle.trim()) return;
    start(async () => {
      const res = await createTask({ title: subTitle, category, parent_id: t.id });
      if (!res?.ok) { toast(res?.error ?? "Couldn't add subtask — try again.", "error"); return; }
      if (res.duplicate) toast(res.speak ?? "Already on the list.", "info");
      setSubTitle("");
      setAdding(false);
      router.refresh();
    });
  }

  // Parent check-off honors the toggleTask cascade contract: open subtasks are
  // never silently stranded under a done parent — confirm, then cascade.
  function toggleParent(done: boolean) {
    start(async () => {
      let res: ToggleTaskResult = await toggleTask(t.id, done, { category });
      if (!res?.ok && res?.needsCascade && done) {
        const n = res.openChildren ?? subtasks.filter((s) => s.status !== "done").length;
        if (!confirm(`"${t.title}" has ${n} open subtask${n === 1 ? "" : "s"} — mark ${n === 1 ? "it" : "them"} done too?`)) return;
        res = await toggleTask(t.id, done, { category, cascade: true });
      }
      if (!res?.ok) { toast(res?.error ?? "Couldn't update task — try again.", "error"); return; }
      router.refresh();
    });
  }

  function togglePin() {
    if (!todayStr) return;
    start(async () => {
      // focus_date = the "do today" pin — a date, so it self-expires at midnight.
      const res = await updateTask(t.id, { focus_date: pinnedToday ? null : todayStr }, { category, jobId: t.job_id });
      if (!res?.ok) { toast(res?.error ?? "Couldn't update task — try again.", "error"); return; }
      toast(pinnedToday ? "Unpinned from today" : "Pinned to today's six", "success");
      router.refresh();
    });
  }

  return (
    <li className="px-4 py-2.5 text-sm">
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={t.status === "done"}
          onChange={(e) => toggleParent(e.target.checked)}
          className="mt-0.5 h-4 w-4 shrink-0 rounded border-slate-300 text-brand focus:ring-brand"
        />
        <div className="min-w-0 flex-1">
          {/* The title IS the tap target — tapping the task opens edit (the "can't click on task" fix).
              Kept separate from the meta row below so its job link isn't nested inside this button. */}
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={`flex min-h-[44px] w-full items-center text-left ${t.status === "done" ? "text-slate-400 line-through" : "font-medium text-slate-900"}`}
          >
            {t.priority > 0 && t.status !== "done" && (
              <Flag className={`mr-1 inline h-3.5 w-3.5 shrink-0 ${t.priority >= 2 ? "text-red-600" : "text-amber-500"}`} />
            )}
            {t.title}
          </button>
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
            {showCategory && t.category && (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${CATEGORY_CHIP[t.category.toLowerCase()] ?? "bg-slate-100 text-slate-500"}`}>
                {categoryLabel(t.category)}
              </span>
            )}
            {/* Tags follow To-Do Extras (0358): off, the chips aren't drawn; the tags stay stored. */}
            {extras &&
              (t.tags ?? []).map((tag) => (
                <span key={tag} className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-500">#{tag}</span>
              ))}
          </div>
        </div>
        {/* "Do today" — pin into My Day's six (a date, so it self-expires at
            midnight). Top-level open tasks only; subtasks are never slots. */}
        {todayStr && t.status !== "done" && !t.parent_id && (
          <button
            onClick={togglePin}
            disabled={pending}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md hover:bg-slate-100 ${pinnedToday ? "text-brand" : "text-slate-300 hover:text-brand"}`}
            title={pinnedToday ? "Unpin from today" : "Do today"}
          >
            <Pin className="h-4 w-4" fill={pinnedToday ? "currentColor" : "none"} />
          </button>
        )}
        {extras && (
          <button onClick={() => setAdding((v) => !v)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-300 hover:bg-slate-100 hover:text-brand" title="Add subtask">
            <Plus className="h-4 w-4" />
          </button>
        )}
        <button onClick={() => setEditing(true)} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-300 hover:bg-slate-100 hover:text-slate-600" title="Edit">
          <Pencil className="h-4 w-4" />
        </button>
        <button
          onClick={() => {
            if (!confirm(`Delete "${t.title}"? This can't be undone.`)) return;
            start(async () => { const res = await deleteTask(t.id, { category }); if (!res?.ok) { toast(res?.error ?? "Couldn't delete the reminder. Try again.", "error"); return; } toast("Reminder deleted", "success"); router.refresh(); });
          }}
          disabled={pending}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-slate-300 hover:bg-red-50 hover:text-red-600"
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
        <TaskEditModal t={t} people={people} category={category} categories={categories} open={editing} onClose={() => setEditing(false)} extras={extras} />
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
  collapsible = false,
  defaultExpanded,
}: {
  label: string;
  tone: string;
  count: number;
  countClass?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Collapsed-by-default section (the Completed list, Erik 7/23) — the header is the
   *  toggle, so done items stay one tap away without burying the open work below them. */
  collapsible?: boolean;
  /** Override the initial state — "Show all completed" lands on ?done=all, which must
   *  arrive OPEN or the just-fetched full list hides behind a collapsed header. */
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? !collapsible);
  return (
    <Card className={`overflow-hidden border ${tone}`}>
      {collapsible ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex min-h-[44px] w-full items-center justify-between border-b border-slate-200/70 px-4 py-3 text-left"
        >
          <h3 className="text-sm font-semibold text-slate-900">{label}</h3>
          <span className={`flex items-center gap-1.5 text-xs ${countClass}`}>
            {count}
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
          </span>
        </button>
      ) : (
        <div className="flex items-center justify-between border-b border-slate-200/70 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-900">{label}</h3>
          <span className={`text-xs ${countClass}`}>{count}</span>
        </div>
      )}
      {expanded && <ul className="divide-y divide-slate-100 bg-white">{children}</ul>}
      {expanded && footer}
    </Card>
  );
}

/**
 * Reminders grouped by WHEN by default — Overdue / Today / This week / Later /
 * Someday, in that order, so "what's next" is a 3-second read — with a
 * ?by=category toggle that regroups the same open ones by the org's own
 * category vocabulary (uncategorized last, under "No category"). Empty
 * sections stay hidden; completed sinks to the bottom behind a bounded fetch.
 */
export function TasksView({
  tasks,
  people = [],
  categories = [],
  todayStr,
  doneTotal = 0,
  showingAllDone = false,
  extras = true,
}: {
  tasks: ViewTask[];
  people?: Person[];
  /** The org's existing category values (autocomplete + by-category view). */
  categories?: string[];
  todayStr: string;
  doneTotal?: number;
  showingAllDone?: boolean;
  /** The To-Do Extras switch (0352): priority, step and tag doors. Omitted = on (as before). */
  extras?: boolean;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const byCategory = searchParams.get("by") === "category";

  // Preserve every live filter (?by, ?done) when building links —
  // only the transient ?new focus flag is dropped.
  const hrefWith = (mutate: (p: URLSearchParams) => void) => {
    const p = new URLSearchParams(searchParams.toString());
    p.delete("new");
    mutate(p);
    const qs = p.toString();
    return qs ? `${pathname}?${qs}` : pathname;
  };

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

  // Overdue is a per-task fact (works in both groupings): in the when-view it
  // matches the Overdue section exactly; in the category view it keeps the red
  // due-chip on late tasks inside their category.
  const row = (t: ViewTask) => (
    <TaskRow
      key={t.id}
      t={t}
      people={people}
      category={t.category ?? null}
      categories={categories}
      subtasks={childrenByParent.get(t.id) ?? []}
      showCategory={!byCategory}
      overdue={!!t.due_date && t.due_date < todayStr}
      todayStr={todayStr}
      extras={extras}
    />
  );

  const timeSections: { key: string; label: string; tone: string; countClass?: string; tasks: ViewTask[] }[] = [
    { key: "overdue", label: "Overdue", tone: "border-red-200 bg-red-50/60", countClass: "font-semibold text-red-600", tasks: openTop.filter((t) => !!t.due_date && t.due_date! < todayStr) },
    { key: "today", label: "Today", tone: "border-sky-200 bg-sky-50/60", tasks: openTop.filter((t) => t.due_date === todayStr) },
    { key: "week", label: "This week", tone: "border-slate-200 bg-slate-50/60", tasks: openTop.filter((t) => !!t.due_date && t.due_date! > todayStr && t.due_date! <= weekEnd) },
    { key: "later", label: "Later", tone: "border-slate-200 bg-slate-50/40", tasks: openTop.filter((t) => !!t.due_date && t.due_date! > weekEnd) },
    { key: "someday", label: "Someday", tone: "border-slate-200 bg-white", tasks: openTop.filter((t) => !t.due_date) },
  ].filter((s) => s.tasks.length > 0);

  // Same open tasks regrouped by category — grouped case-insensitively (the
  // datalist steers toward one casing, but "Permits"/"permits" never split),
  // A→Z, uncategorized last under "No category".
  const catMap = new Map<string, { label: string; tasks: ViewTask[] }>();
  const uncategorized: ViewTask[] = [];
  if (byCategory) {
    for (const t of openTop) {
      const raw = (t.category ?? "").trim();
      if (!raw) { uncategorized.push(t); continue; }
      const g = catMap.get(raw.toLowerCase());
      if (g) g.tasks.push(t);
      else catMap.set(raw.toLowerCase(), { label: categoryLabel(raw), tasks: [t] });
    }
  }
  const categorySections = [...catMap.values()]
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((g) => ({ key: `cat-${g.label}`, label: g.label, tone: "border-slate-200 bg-slate-50/60", countClass: undefined as string | undefined, tasks: g.tasks }));
  if (uncategorized.length > 0) {
    categorySections.push({ key: "cat-none", label: "No category", tone: "border-slate-200 bg-white", countClass: undefined, tasks: uncategorized });
  }

  const sections = byCategory ? categorySections : timeSections;

  return (
    <div>
      <NewReminderBox />
      {/* View toggle — link pills (the app's filter idiom), URL-driven so the
          grouping survives reloads and deep links. */}
      <div className="mb-4 flex items-center gap-1.5">
        {([
          { on: false, label: "By When" },
          { on: true, label: "By Category" },
        ] as const).map((p) => (
          <Link
            key={p.label}
            href={hrefWith((q) => (p.on ? q.set("by", "category") : q.delete("by")))}
            aria-current={byCategory === p.on ? "page" : undefined}
            className={`inline-flex min-h-[44px] items-center rounded-full px-3 text-sm font-medium ${
              byCategory === p.on
                ? "bg-brand text-white shadow-sm"
                : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {p.label}
          </Link>
        ))}
      </div>
      <div className="space-y-4">
        {sections.length === 0 && (
          <Card>
            <div className="px-4 py-8 text-center text-sm text-slate-400">Nothing open. Add a reminder above.</div>
          </Card>
        )}
        {sections.map((s) => (
          <TimeSection key={s.key} label={s.label} tone={s.tone} count={s.tasks.length} countClass={s.countClass}>
            {s.tasks.map((t) => row(t))}
          </TimeSection>
        ))}
        {doneTop.length > 0 && (
          <TimeSection
            label="Completed"
            collapsible
            defaultExpanded={showingAllDone}
            tone="border-slate-200 bg-slate-50/40"
            count={doneTotal || doneTop.length}
            countClass="text-slate-400"
            footer={
              !showingAllDone && doneTotal > doneFetched ? (
                <div className="border-t border-slate-200/70 bg-white px-4 py-2.5 text-center">
                  <Link href={hrefWith((q) => q.set("done", "all"))} className="text-xs font-medium text-brand hover:underline">
                    Show All Completed ({doneTotal})
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
