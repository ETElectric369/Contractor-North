"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2, Receipt, StickyNote, FileText, Briefcase, Check, AlertCircle, Archive, RotateCcw, Pencil, ListTodo } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Tabs } from "@/components/tabs";
import { useToast } from "@/components/toast";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  fileItem,
  deleteOrganizedItem,
  updateOrganizedItem,
  archiveItem,
  unarchiveItem,
  keepAsNote,
  makeTaskFromPaper,
  undoPaperwork,
} from "./actions";
import { bucketOf } from "@/lib/business-cost-buckets";
import { isShelfTicket } from "@/lib/shelf-plan";
import { jobLabel } from "@/lib/schedule-options";
import { PaperworkList, type PaperRowItem } from "@/components/paperwork-row";
import { proposalOf, type NumberMatch } from "@/lib/paperwork";

// The categories Claude assigns during extraction — offered so the owner can
// correct a mis-classified item to any valid kind. Mirrors what the paper reader writes.
const ITEM_CATEGORIES = ["Receipt", "Bill", "Invoice", "Photo", "Plan", "Permit", "Note", "Other"];

export interface OrganizedItemRow extends PaperRowItem {
  id: string;
  kind: string;
  title: string;
  summary: string | null;
  vendor: string | null;
  amount: number | null;
  item_date: string | null;
  category: string | null;
  confidence: string;
  status: string;
  job_id: string | null;
  bill_id: string | null;
  created_at: string;
  signedUrl: string | null;
  jobs: { job_number: string; name: string } | null;
  tied_bill_id?: string | null;
  /** Which door it came in by: organize, bills_drop, or job (a receipt recorded as a cost on the job page). */
  source?: string | null;
}

interface JobOption {
  id: string;
  job_number: string;
  name: string;
  /** complete: a finished job, offered under Completed Jobs (PR1). */
  status?: string | null;
}

const KIND_META: Record<string, { label: string; icon: any; tone: "green" | "amber" | "blue" }> = {
  receipt: { label: "Receipt", icon: Receipt, tone: "green" },
  note: { label: "Note", icon: StickyNote, tone: "amber" },
  job_document: { label: "Job doc", icon: FileText, tone: "blue" },
};

/**
 * ORGANIZE: where papers wait until someone files them (Needs Attention), and what was filed or set
 * aside (Archive). Papers come in through Snap Or Note (the page header's button, or + anywhere);
 * this page no longer has a capture card of its own (W1-30: one paper door).
 */
export function OrganizeManager({
  items,
  jobs,
  matches,
  shopStock = true,
}: {
  items: OrganizedItemRow[];
  jobs: JobOption[];
  /** "Already on the books" offers per paper, computed on the server (0295). */
  matches: Record<string, NumberMatch[]>;
  /** The Shop Stock switch (0352): off, and no paper offers the shelf. Absent = on. */
  shopStock?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const toast = useToast();
  const [editing, setEditing] = useState<OrganizedItemRow | null>(null);
  const [notePick, setNotePick] = useState<Record<string, string>>({});

  const tray = items.filter((i) => i.status === "needs_review");
  // ONE INBOX, ONE ACTION (0295): every paper in the tray renders the SAME card Snap Or Note and
  // Needs You on /bills render, and files through the same answers. A note keeps its own card,
  // because what matters on a note is the words on it.
  const trayPapers = tray.filter((i) => i.kind !== "note");
  const trayNotes = tray.filter((i) => i.kind === "note");
  const archived = items.filter((i) => i.status === "filed" || i.status === "archived");

  function file(item: OrganizedItemRow, dest: Parameters<typeof fileItem>[1]) {
    start(async () => {
      const res = await fileItem(item.id, dest);
      if (!res?.ok) { toast(res?.error ?? "Couldn't file item — try again.", "error"); return; }
      toast(
        dest.type === "unfiled"
          ? "Moved to unfiled"
          : dest.type === "overhead"
            ? `Filed as a Business Cost: ${dest.category}`
            : "Filed",
        "success",
      );
      router.refresh();
    });
  }

  function archive(item: OrganizedItemRow) {
    start(async () => {
      const res = await archiveItem(item.id);
      if (!res?.ok) { toast(res?.error ?? "Couldn't archive — try again.", "error"); return; }
      toast("Archived", "success");
      router.refresh();
    });
  }

  function restore(item: OrganizedItemRow) {
    // A BANK DOWNLOAD's Back is its whole Undo: everything it wrote comes off. Asked first, as the
    // card's own Undo This Download is.
    const filedHow = proposalOf(item).filed?.how;
    if (filedHow === "bank_download" && !confirm("Undo this whole bank download? Everything it wrote comes off, and every line waits under Needs You on Bills again.")) return;
    start(async () => {
      const res = await unarchiveItem(item.id);
      if (!res?.ok) { toast(res?.error ?? "Couldn't restore — try again.", "error"); return; }
      toast(res && "message" in res && res.message ? String(res.message) : "Moved back to Needs Attention", "success");
      router.refresh();
    });
  }

  function remove(item: OrganizedItemRow) {
    if (!confirm(`Delete "${item.title}"? This also removes whatever it filed.`)) return;
    start(async () => {
      const res = await deleteOrganizedItem(item.id);
      if (!res?.ok) { toast(res?.error ?? "Couldn't delete — try again.", "error"); return; }
      toast(res.message ?? "Deleted", "success");
      router.refresh();
    });
  }

  function filedBadge(item: OrganizedItemRow) {
    if (item.status === "archived") return <Badge tone="slate">Archived</Badge>;
    if (item.job_id && item.jobs) return <Badge tone="blue">{jobLabel(item.jobs)}</Badge>;
    // A bill with no job is a business cost. bucketOf reads an old word ("Vehicle") as its bucket, so
    // the archive and the Bills page name the same cost the same way.
    // A shelf ticket is never a business cost (Shop Stock, Phase 2): its bucket would read "Other".
    if (item.bill_id && !item.job_id && isShelfTicket({ category: item.category })) return <Badge tone="indigo">Shop Stock</Badge>;
    if (item.bill_id && !item.job_id) return <Badge tone="purple">Business Cost · {bucketOf(item.category)}</Badge>;
    if (item.category === "Petty cash") return <Badge tone="indigo">Petty cash</Badge>;
    if (item.category === "Task") return <Badge tone="green">Task</Badge>;
    if (item.kind === "note") return <Badge tone="amber">Note</Badge>;
    return <Badge tone="slate">Filed</Badge>;
  }

  function Thumb({ item }: { item: OrganizedItemRow }) {
    const meta = KIND_META[item.kind] ?? KIND_META.job_document;
    const Icon = meta.icon;
    if (item.signedUrl) {
      return (
        <a href={item.signedUrl} target="_blank" rel="noreferrer" className="shrink-0">
          {/\.pdf($|\?)/i.test(item.signedUrl) ? (
            <span className="flex h-16 w-16 items-center justify-center rounded-lg bg-slate-100">
              <FileText className="h-6 w-6 text-slate-400" />
            </span>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.signedUrl} alt="" className="h-16 w-16 rounded-lg object-cover" />
          )}
        </a>
      );
    }
    return (
      <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-slate-100">
        <Icon className="h-6 w-6 text-slate-400" />
      </span>
    );
  }

  /** A NOTE in the tray: its words, then where it goes. Papers use PaperworkRow instead. Picking a
   *  job only picks; Keep It On The Job is the press (the dropdown used to file the moment it
   *  changed). Archive is the safe inline remove. */
  function AttentionCard({ item }: { item: OrganizedItemRow }) {
    const meta = KIND_META[item.kind] ?? KIND_META.job_document;
    return (
      <Card className="border-amber-300 bg-amber-50/40">
        <div className="flex gap-4 p-4">
          <Thumb item={item} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-slate-900">{item.title}</span>
              <Badge tone={meta.tone}>{meta.label}</Badge>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-slate-500">
              {item.vendor && <span>{item.vendor}</span>}
              {item.amount != null && <span className="font-medium text-slate-700">{formatCurrency(item.amount)}</span>}
              {item.item_date && <span>{formatDate(item.item_date)}</span>}
              <span>Added {formatDate(item.created_at)}</span>
            </div>
            {item.summary && (
              <details className="mt-1.5" open={item.kind === "note"}>
                <summary className="cursor-pointer text-xs font-medium text-brand">
                  {item.kind === "note" ? "Note" : "Details"}
                </summary>
                <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{item.summary}</p>
              </details>
            )}

            <SuggestChips item={item} />
            <NoteDoors item={item} />
          </div>
        </div>
      </Card>
    );
  }

  /**
   * THE SUGGESTION, KEPT ON THE NOTE (Erik, audit v994 PR2). A note typed in Snap Or Note is read
   * once as it is saved (W1-30), and what that look suggests rides here as a chip: a person taps Add
   * A Reminder or Keep As Note, the toast says what happened, and Undo takes it back. Nothing moves
   * until then. (The card's own AI Suggest button is gone: the look happens once, on arrival.)
   */
  function SuggestChips({ item }: { item: OrganizedItemRow }) {
    const p = proposalOf(item);
    const task = p.suggestTask ?? null;
    const keep = p.suggestKeep === true;
    if (!task && !keep) return null;
    const act = (fn: () => Promise<{ ok: boolean; error?: string; message?: string }>, fallback: string) =>
      start(async () => {
        const res = await fn();
        if (!res.ok) {
          toast(res.error ?? "That didn't work. Nothing changed.", "error");
          return;
        }
        toast(res.message ?? fallback, "success", {
          label: "Undo",
          onClick: () => {
            void undoPaperwork(item.id).then((u) => {
              toast(u.ok ? u.message ?? "Undone." : u.error ?? "Couldn't undo.", u.ok ? "success" : "error");
              router.refresh();
            });
          },
        });
        router.refresh();
      });
    const chip =
      "inline-flex min-h-11 items-center gap-1.5 rounded-full border border-dashed border-slate-300 bg-white px-3 text-left text-sm text-slate-700 hover:border-brand hover:text-brand disabled:opacity-50";
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {task && (
          <button type="button" className={chip} disabled={pending} onClick={() => act(() => makeTaskFromPaper(item.id), `Added a Reminder: "${task.title}".`)}>
            <ListTodo className="h-4 w-4 shrink-0 text-brand" />
            <span className="min-w-0 break-words">Add A Reminder: {task.title}</span>
          </button>
        )}
        {keep && (
          <button type="button" className={chip} disabled={pending} onClick={() => act(() => keepAsNote(item.id), "Kept as a note.")}>
            <StickyNote className="h-4 w-4 shrink-0 text-brand" /> Keep As Note
          </button>
        )}
        <span className="text-xs text-slate-500">A suggestion{p.why ? `: ${p.why}` : ""}. Nothing moves until you tap it.</span>
      </div>
    );
  }

  function NoteDoors({ item }: { item: OrganizedItemRow }) {
    // Held by the manager, not here: this card is re-created on every render of the page, and a
    // pick kept in its own state would reset each time the page refreshed.
    const pick = notePick[item.id] ?? item.job_id ?? "";
    const setPick = (v: string) => setNotePick((m) => ({ ...m, [item.id]: v }));
    return (
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <Briefcase className="h-4 w-4 shrink-0 text-slate-400" />
          <Select value={pick} onChange={(e) => setPick(e.target.value)} disabled={pending} className="h-11 w-48" aria-label="Pick A Job">
            <option value="">Pick A Job…</option>
            {jobs.filter((j) => j.status !== "complete").map((j) => (
              <option key={j.id} value={j.id}>{jobLabel(j)}</option>
            ))}
            {jobs.some((j) => j.status === "complete") && (
              <optgroup label="Completed Jobs">
                {jobs.filter((j) => j.status === "complete").map((j) => (
                  <option key={j.id} value={j.id}>{jobLabel(j)}</option>
                ))}
              </optgroup>
            )}
          </Select>
        </span>
        <Button variant="outline" onClick={() => pick && file(item, { type: "job", jobId: pick })} disabled={pending || !pick}>
          <Check /> Keep It On The Job
        </Button>
        <Button variant="outline" onClick={() => setEditing(item)} disabled={pending}>
          <Pencil /> Edit
        </Button>
        <Button variant="outline" onClick={() => archive(item)} disabled={pending}>
          <Archive /> Archive
        </Button>
      </div>
    );
  }

  /** Archive card: compact, with restore + delete. */
  function ArchiveCard({ item }: { item: OrganizedItemRow }) {
    const meta = KIND_META[item.kind] ?? KIND_META.job_document;
    return (
      <Card>
        <div className="flex items-center gap-3 p-3">
          <Thumb item={item} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-sm font-medium text-slate-900">{item.title}</span>
              <Badge tone={meta.tone}>{meta.label}</Badge>
              {filedBadge(item)}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-slate-500">
              {item.amount != null && <span className="font-medium text-slate-700">{formatCurrency(item.amount)}</span>}
              <span>{formatDate(item.created_at)}</span>
            </div>
          </div>
          {/* 44px targets. Back undoes a filing (its bill comes down under the 0278 ceiling), so
              the paper never sits in the tray over a bill that is still live. */}
          <button onClick={() => restore(item)} disabled={pending} className="flex h-11 w-11 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700" title={
              item.source === "job"
                ? "Undo Record As Cost (The Receipt Stays On The Job)"
                : proposalOf(item).filed?.how === "bank_download"
                  ? "Undo This Download (Everything It Wrote Comes Off)"
                  : item.bill_id || item.job_id || item.tied_bill_id
                    ? "Undo Filing (Back To Needs Attention)"
                    : "Back To Needs Attention"
            } aria-label={item.source === "job" ? "Undo Record As Cost" : "Back To Needs Attention"}>
            <RotateCcw className="h-4 w-4" />
          </button>
          <button onClick={() => setEditing(item)} disabled={pending} className="flex h-11 w-11 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Edit Details" aria-label="Edit Details">
            <Pencil className="h-4 w-4" />
          </button>
          <button onClick={() => remove(item)} disabled={pending} className="flex h-11 w-11 items-center justify-center rounded-md text-slate-400 hover:bg-red-50 hover:text-red-600" title="Delete" aria-label="Delete">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </Card>
    );
  }

  /** Edit dialog: correct the AI-extracted fields before/after filing. */
  function EditModal({ item }: { item: OrganizedItemRow }) {
    const [title, setTitle] = useState(item.title ?? "");
    const [vendor, setVendor] = useState(item.vendor ?? "");
    const [amount, setAmount] = useState<number>(item.amount ?? 0);
    const [itemDate, setItemDate] = useState(item.item_date ?? "");
    const [category, setCategory] = useState(item.category ?? "");
    const [summary, setSummary] = useState(item.summary ?? "");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function save() {
      setSaving(true);
      setError(null);
      const res = await updateOrganizedItem(item.id, {
        title,
        vendor: vendor.trim() || null,
        amount: amount || null,
        item_date: itemDate || null,
        category: category || null,
        summary: summary.trim() || null,
      });
      setSaving(false);
      if (!res.ok) {
        setError(res.error ?? "Couldn't save.");
        return;
      }
      setEditing(null);
      router.refresh();
    }

    return (
      <Modal
        open
        onClose={() => setEditing(null)}
        title="Edit details"
        footer={<ModalActions onCancel={() => setEditing(null)} onSave={save} saving={saving} />}
      >
        <div className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}
          <div>
            <Label htmlFor="oi-title">Title</Label>
            <Input id="oi-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Short label" />
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="oi-vendor">Vendor</Label>
              <Input id="oi-vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Store" />
            </div>
            <div>
              <Label htmlFor="oi-amount">Amount</Label>
              <NumberInput id="oi-amount" value={amount} onValueChange={setAmount} placeholder="0.00" />
            </div>
            <div>
              <Label htmlFor="oi-date">Date</Label>
              <Input id="oi-date" type="date" value={itemDate} onChange={(e) => setItemDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="oi-category">Category</Label>
              <Select id="oi-category" value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">None</option>
                {ITEM_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                {category && !ITEM_CATEGORIES.includes(category) && <option value={category}>{category}</option>}
              </Select>
            </div>
          </div>
          <div>
            <Label htmlFor="oi-summary">{item.kind === "note" ? "Note" : "Summary"}</Label>
            <Textarea id="oi-summary" value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What's on it…" />
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <div className="space-y-5">
      <Tabs
        urlSync
        paramKey="view"
        tabs={[
          {
            id: "attention",
            label: "Needs Attention",
            count: tray.length,
            icon: <AlertCircle className="h-4 w-4" />,
            content:
              tray.length === 0 ? (
                <p className="py-10 text-center text-sm text-slate-400">All caught up — nothing needs your attention. 🎉</p>
              ) : (
                <div className="space-y-3">
                  <PaperworkList items={trayPapers} jobs={jobs} matches={matches} shopStock={shopStock} />
                  {trayNotes.length > 0 && (
                    <ul className="space-y-3">
                      {trayNotes.map((item) => <li key={item.id}><AttentionCard item={item} /></li>)}
                    </ul>
                  )}
                </div>
              ),
          },
          {
            id: "archive",
            label: "Archive",
            // No badge: what's been filed is done (Erik, 2026-09-27: "all badges only show whats
            // open"). Needs Attention's count is the open one.
            icon: <Archive className="h-4 w-4" />,
            content:
              archived.length === 0 ? (
                <p className="py-10 text-center text-sm text-slate-400">Nothing filed yet.</p>
              ) : (
                <ul className="space-y-2">
                  {archived.map((item) => <li key={item.id}><ArchiveCard item={item} /></li>)}
                </ul>
              ),
          },
        ]}
      />

      {editing && <EditModal key={editing.id} item={editing} />}
    </div>
  );
}
