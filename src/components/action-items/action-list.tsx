"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarPlus, Clock3, X, ChevronRight, Check, UserPlus, ArrowRightLeft } from "lucide-react";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { MoveToDay } from "@/components/move-to-day";
import { dispatchAction } from "@/lib/action-items/dispatch";
import { KIND_META, KIND_STREAM, STREAM_LABEL, STREAM_ORDER, sortActionItems, type ActionItem, type Affordance } from "@/lib/action-items/types";

function ymd(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Friendly relative day for the "when" line; times for datetime values. */
function prettyWhen(when: string | null | undefined): string | null {
  if (!when) return null;
  const hasTime = when.includes("T");
  const d = new Date(hasTime ? when : `${when}T12:00:00`);
  if (isNaN(d.getTime())) return null;
  const today = new Date();
  const day0 = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((day0(d) - day0(today)) / 86_400_000);
  const rel =
    diffDays < 0 ? `${-diffDays}d overdue` : diffDays === 0 ? "Today" : diffDays === 1 ? "Tomorrow" : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  if (hasTime) {
    const t = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return diffDays === 0 ? t : `${rel} · ${t}`;
  }
  return rel;
}

/**
 * The one "needs action" list — the action-layer twin of <ModalActions>. Renders
 * any ActionItem[] with the universal done-sinks-to-bottom order, and exposes
 * each item's canonical verbs (Do / Schedule / Snooze / Dismiss / Open) routed
 * through the single dispatcher. One source of truth for every actionable list.
 */
export function ActionList({
  items,
  people = [],
  emptyLabel = "All caught up.",
}: {
  items: ActionItem[];
  people?: { id: string; full_name: string | null }[];
  emptyLabel?: string;
}) {
  const router = useRouter();
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState<ActionItem | null>(null);
  const [assigneeVal, setAssigneeVal] = useState("");
  const [savingAssign, setSavingAssign] = useState(false);
  const [converting, setConverting] = useState<ActionItem | null>(null);
  const [dismissing, setDismissing] = useState<ActionItem | null>(null);

  const visible = sortActionItems(
    items.filter((i) => !removedIds.has(i.id)).map((i) => ({ ...i, done: i.done || doneIds.has(i.id) })),
  );

  // The four urgency streams, rendered as titled sections in fixed order —
  // Money / Leads / Today / Waiting — with empty groups hidden. Grouping runs on
  // whatever items arrived (a pre-sliced My Day list groups just its slice) and
  // the universal ordering rule still holds within each group. The KIND_STREAM
  // fallback covers any item that reaches us without a stamped stream.
  const groups = STREAM_ORDER.map((stream) => ({
    stream,
    items: visible.filter((i) => (i.stream ?? KIND_STREAM[i.kind]) === stream),
  })).filter((g) => g.items.length > 0);

  async function run(
    item: ActionItem,
    verb: Affordance,
    payload?: { date?: string; assignee?: string; target?: "inspection" | "customer" | "quote" | "estimate" | "job" },
  ) {
    setError(null);
    setBusyId(item.id);
    const res = await dispatchAction({ kind: item.kind, id: item.id, verb, payload });
    setBusyId(null);
    if (!res.ok) {
      setError(res.error ?? "Couldn't do that.");
      // roll back the optimistic change
      setDoneIds((s) => { const n = new Set(s); n.delete(item.id); return n; });
      setRemovedIds((s) => { const n = new Set(s); n.delete(item.id); return n; });
      return false;
    }
    router.refresh();
    return true;
  }

  function onDo(item: ActionItem) {
    setDoneIds((s) => new Set(s).add(item.id)); // sink it immediately
    run(item, "do");
  }
  // Dismiss is a HARD DELETE for tasks/inquiries (it can't be undone) — confirm first.
  // For appointments/organize it just cancels/archives (reversible), so run it straight.
  const HARD_DELETE_KINDS = new Set(["task", "work_order", "inquiry"]);
  function onDismiss(item: ActionItem) {
    if (HARD_DELETE_KINDS.has(item.kind)) {
      setDismissing(item);
      return;
    }
    setRemovedIds((s) => new Set(s).add(item.id));
    run(item, "dismiss");
  }
  function confirmDismiss() {
    const item = dismissing;
    if (!item) return;
    setDismissing(null);
    setRemovedIds((s) => new Set(s).add(item.id));
    run(item, "dismiss");
  }
  // Schedule/snooze go through the shared MoveToDay sheet — the ONE reschedule
  // idiom app-wide (same dispatchAction payload the old bespoke date modal
  // sent). Returns the result so the sheet shows its own inline error.
  async function pickDate(item: ActionItem, verb: "schedule" | "snooze", dateISO: string | null) {
    if (!dateISO) return { ok: false, error: "Pick a day." };
    setError(null);
    setBusyId(item.id);
    setRemovedIds((s) => new Set(s).add(item.id)); // leaves the inbox once dated
    const res = await dispatchAction({ kind: item.kind, id: item.id, verb, payload: { date: dateISO } });
    setBusyId(null);
    if (!res.ok) {
      // roll back the optimistic removal
      setRemovedIds((s) => { const n = new Set(s); n.delete(item.id); return n; });
      return { ok: false, error: res.error ?? "Couldn't do that." };
    }
    router.refresh();
    return { ok: true };
  }
  function openAssign(item: ActionItem) {
    setAssigneeVal("");
    setAssigning(item);
  }
  async function saveAssign() {
    if (!assigning) return;
    setSavingAssign(true);
    const ok = await run(assigning, "assign", { assignee: assigneeVal || undefined });
    setSavingAssign(false);
    if (ok) setAssigning(null);
  }
  async function doConvert(item: ActionItem, target: "inspection" | "customer" | "quote" | "estimate" | "job") {
    setRemovedIds((s) => new Set(s).add(item.id)); // converted → leaves the inbox
    const ok = await run(item, "convert", { target });
    if (ok) setConverting(null);
  }

  if (visible.length === 0) {
    return <p className="px-1 py-2 text-sm text-slate-400">{emptyLabel}</p>;
  }

  return (
    <div className="space-y-1.5">
      {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {groups.map(({ stream, items: groupItems }) => (
        <div key={stream} className="space-y-1.5">
          <div className="px-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            {STREAM_LABEL[stream]}
          </div>
          {groupItems.map((item) => {
            const can = (v: Affordance) => item.affordances.includes(v);
            const meta = KIND_META[item.kind];
            const when = prettyWhen(item.when);
            const overdue = item.when && !item.when.includes("T") && item.when < ymd(new Date());
            return (
              <div
                key={item.id}
                className={`flex items-center gap-2 rounded-xl border bg-white px-3 py-2 ${
                  item.done ? "border-slate-100 opacity-55" : "border-slate-200"
                }`}
              >
                {can("do") && (
                  <button
                    onClick={() => onDo(item)}
                    disabled={busyId === item.id || item.done}
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${
                      item.done ? "border-brand bg-brand text-white" : "border-slate-300 hover:border-brand"
                    }`}
                    title="Mark done"
                    aria-label="Mark done"
                  >
                    {item.done && <Check className="h-3.5 w-3.5" />}
                  </button>
                )}

                <button onClick={() => router.push(item.href)} className="min-w-0 flex-1 text-left">
                  <div className={`truncate text-sm ${item.done ? "text-slate-400 line-through" : "font-medium text-slate-900"}`}>
                    {item.urgency >= 2 && !item.done && <span className="mr-1 text-red-500">!</span>}
                    {item.title}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-slate-500">
                    <Badge tone={meta.tone}>{meta.label}</Badge>
                    {item.subtitle && <span className="truncate">{item.subtitle}</span>}
                    {when && <span className={overdue ? "font-medium text-red-600" : ""}>· {when}</span>}
                    {item.who && <span className="truncate">· {item.who}</span>}
                  </div>
                </button>

                <div className="flex shrink-0 items-center gap-0.5">
                  {can("schedule") && (
                    <MoveToDay
                      label="Schedule / set a date"
                      triggerClassName="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-brand"
                      onPick={(d) => pickDate(item, "schedule", d)}
                    >
                      <CalendarPlus className="h-4 w-4" />
                    </MoveToDay>
                  )}
                  {can("assign") && (
                    <button onClick={() => openAssign(item)} disabled={busyId === item.id} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-brand" title="Assign to someone">
                      <UserPlus className="h-4 w-4" />
                    </button>
                  )}
                  {can("convert") && (
                    <button onClick={() => setConverting(item)} disabled={busyId === item.id} className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-brand" title="Convert">
                      <ArrowRightLeft className="h-4 w-4" />
                    </button>
                  )}
                  {can("snooze") && (
                    <MoveToDay
                      label="Snooze until"
                      triggerClassName="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                      onPick={(d) => pickDate(item, "snooze", d)}
                    >
                      <Clock3 className="h-4 w-4" />
                    </MoveToDay>
                  )}
                  {can("dismiss") && (
                    <button onClick={() => onDismiss(item)} disabled={busyId === item.id} className="rounded-md p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-600" title="Dismiss">
                      <X className="h-4 w-4" />
                    </button>
                  )}
                  <button onClick={() => router.push(item.href)} className="rounded-md p-1.5 text-slate-300 hover:bg-slate-100 hover:text-slate-600" title="Open">
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ))}

      <Modal
        open={!!assigning}
        onClose={() => setAssigning(null)}
        title="Assign to"
        size="sm"
        footer={
          <ModalActions onCancel={() => setAssigning(null)} onSave={saveAssign} saving={savingAssign} saveLabel="Assign" />
        }
      >
        <div>
          <Label htmlFor="ai-assignee">Person</Label>
          <Select id="ai-assignee" value={assigneeVal} onChange={(e) => setAssigneeVal(e.target.value)}>
            <option value="">— Unassigned —</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>{p.full_name ?? "Unnamed"}</option>
            ))}
          </Select>
        </div>
      </Modal>

      <Modal open={!!converting} onClose={() => setConverting(null)} title="Convert inquiry" size="sm">
        <div className="space-y-3">
          <p className="text-sm text-slate-500">Turn this inquiry into:</p>
          <div className="grid grid-cols-2 gap-2">
            {([
              ["inspection", "Inspection"],
              ["estimate", "Estimate"],
              ["quote", "Quote"],
              ["job", "Job"],
              ["customer", "Customer"],
            ] as const).map(([t, label]) => (
              <Button key={t} type="button" variant="outline" onClick={() => converting && doConvert(converting, t)}>
                {label}
              </Button>
            ))}
          </div>
          <p className="text-xs text-slate-400">
            Inspection books a site visit in ~2 days and keeps the lead open — for big jobs that need a look before a firm price.
          </p>
        </div>
      </Modal>

      <Modal
        open={!!dismissing}
        onClose={() => setDismissing(null)}
        title="Delete this?"
        size="sm"
        footer={
          <ModalActions onCancel={() => setDismissing(null)} onSave={confirmDismiss} saveLabel="Delete" destructive />
        }
      >
        <p className="text-sm text-slate-600">
          This permanently deletes <span className="font-medium text-slate-900">{dismissing?.title}</span>. It can&apos;t be undone.
        </p>
      </Modal>
    </div>
  );
}
