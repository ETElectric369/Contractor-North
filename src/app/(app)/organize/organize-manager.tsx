"use client";

import { useRef, useState, useTransition } from "react";
import { DropTarget } from "@/components/drop-target";
import { useRouter } from "next/navigation";
import {
  Upload,
  Camera,
  Mic,
  Trash2,
  Loader2,
  Receipt,
  StickyNote,
  FileText,
  Sparkles,
  Briefcase,
  Check,
  AlertCircle,
  Archive,
  RotateCcw,
  Pencil,
  ListTodo,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Tabs } from "@/components/tabs";
import { CameraCapture } from "@/components/camera-capture";
import { useDictation } from "@/lib/use-dictation";
import { useToast } from "@/components/toast";
import { formatCurrency, formatDate } from "@/lib/utils";
import { prepareImageForUpload } from "@/lib/image-prep";
import { sha256Hex } from "@/lib/content-hash";
import {
  analyzeAndFile,
  fileItem,
  deleteOrganizedItem,
  updateOrganizedItem,
  saveVoiceNote,
  archiveItem,
  unarchiveItem,
  aiReviewItem,
  keepAsNote,
  makeTaskFromPaper,
  readPaperworkItem,
  undoPaperwork,
  type OrganizedResult,
} from "./actions";
import { addPaperwork, fingerprintSeen } from "./paperwork-actions";
import { isPdfBytes, readPdfText } from "@/lib/pdf-text";
import { bucketOf } from "@/lib/business-cost-buckets";
import { isShelfTicket } from "@/lib/shelf-plan";
import { jobLabel } from "@/lib/schedule-options";
import { PaperworkList, type PaperRowItem } from "@/components/paperwork-row";
import { proposalOf, type NumberMatch } from "@/lib/paperwork";

// The categories Claude assigns during extraction — offered so the owner can
// correct a mis-classified item to any valid kind. Mirrors analyzeAndFile.
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

type UploadState = { name: string; status: "uploading" | "reading" | "done" | "warn" | "error"; message?: string };

const KIND_META: Record<string, { label: string; icon: any; tone: "green" | "amber" | "blue" }> = {
  receipt: { label: "Receipt", icon: Receipt, tone: "green" },
  note: { label: "Note", icon: StickyNote, tone: "amber" },
  job_document: { label: "Job doc", icon: FileText, tone: "blue" },
};

export function OrganizeManager({
  orgId,
  items,
  jobs,
  matches,
}: {
  orgId: string;
  items: OrganizedItemRow[];
  jobs: JobOption[];
  /** "Already on the books" offers per paper, computed on the server (0295). */
  matches: Record<string, NumberMatch[]>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const toast = useToast();
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [showCamera, setShowCamera] = useState(false);
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [aiMsg, setAiMsg] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<OrganizedItemRow | null>(null);
  const [notePick, setNotePick] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<HTMLInputElement>(null);

  function takePhoto() {
    const touchy =
      typeof window !== "undefined" &&
      (window.matchMedia?.("(pointer: coarse)").matches ||
        navigator.maxTouchPoints > 0 ||
        /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent));
    if (touchy) captureRef.current?.click();
    else setShowCamera(true);
  }

  // Voice note: tap to start, tap again to stop; the transcript becomes a note in the
  // needs-attention tray. Ported off webkitSpeechRecognition (Andrew: "the Speak it button
  // does not activate a microphone" — that API simply doesn't exist on iOS/Safari) onto the
  // SAME MediaRecorder → /api/transcribe path the inspector and tour use everywhere.
  const dictation = useDictation((text) =>
    start(async () => {
      const res = await saveVoiceNote(text);
      if (!res?.ok) { toast(res?.error ?? "Couldn't save voice note — try again.", "error"); return; }
      toast("Voice note saved", "success");
      router.refresh();
    }),
  );
  const listening = dictation.recording;
  function voiceNote() {
    if (dictation.recording) dictation.stop();
    else void dictation.start();
  }

  const busy = uploads.some((u) => u.status === "uploading" || u.status === "reading");
  const tray = items.filter((i) => i.status === "needs_review");
  // ONE INBOX, ONE ACTION (0295): every paper in the tray renders the SAME row Drop Paperwork on
  // /bills renders, and files through the same File It. A note keeps its own card, because what
  // matters on a note is the words on it.
  const trayPapers = tray.filter((i) => i.kind !== "note");
  const trayNotes = tray.filter((i) => i.kind === "note");
  const archived = items.filter((i) => i.status === "filed" || i.status === "archived");

  async function processFiles(files: File[]) {
    if (!files.length) return;
    const supabase = createClient();

    for (const raw of files) {
      const label = raw.name;
      setUploads((u) => [...u, { name: label, status: "uploading" }]);
      const setState = (status: UploadState["status"], message?: string) =>
        setUploads((u) => u.map((x) => (x.name === label ? { ...x, status, message } : x)));

      try {
        // THE SAME FILE ONCE (0295): fingerprinted from its ORIGINAL bytes, before any resize, and
        // checked before anything is uploaded.
        const rawBytes = await raw.arrayBuffer();
        let sha: string | null = null;
        try {
          sha = await sha256Hex(rawBytes);
        } catch {
          sha = null; // an old browser: the file still goes in, it just can't be matched
        }
        if (sha) {
          const seen = await fingerprintSeen(sha);
          if (seen.seen) {
            setState("done", `${seen.seen} Nothing was added twice.`);
            continue;
          }
        }
        // A CED PDF IS READ FROM ITS OWN TEXT, HERE AS ON BILLS (audit v994, PR3). Dragged onto
        // Organize, a multi-invoice CED PDF went to the model as one picture and came back as one
        // "bill" with a statement-class total; dropped on Bills, the same file became CED
        // documents from the numbers CED printed. One server door (addPaperwork) decides now.
        const isPdf = raw.type === "application/pdf" || /\.pdf$/i.test(raw.name);
        let pdfText: string | null = null;
        if (isPdf) {
          if (!isPdfBytes(rawBytes)) throw new Error("It is named like a PDF but isn't one inside.");
          const t = await readPdfText(rawBytes, raw.name);
          if (t.ok) pdfText = t.text; // a scan has no text; the reader looks at it as a picture instead
        }
        const file = isPdf ? raw : await prepareImageForUpload(raw);
        if (file.size > 8 * 1024 * 1024) throw new Error("Over 8 MB — try a smaller photo.");
        const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${orgId}/organize/${Date.now()}-${safe}`;
        const { error: upErr } = await supabase.storage.from("documents").upload(path, file, { upsert: false });
        if (upErr) throw upErr;

        let res: OrganizedResult;
        if (sha) {
          const added = await addPaperwork({
            path,
            name: file.name,
            mime: isPdf ? "application/pdf" : file.type,
            size: file.size,
            sha256: sha,
            source: "organize",
            pdfText,
          });
          if (!added.ok || !added.id) {
            // The row didn't land, so the file must not linger in storage with nothing pointing at it.
            await supabase.storage.from("documents").remove([path]);
            if (added.already) {
              setState("done", `${added.already} Nothing was added twice.`);
              continue;
            }
            throw new Error(added.error ?? "Not added.");
          }
          if (!added.needsRead) {
            setState(added.line?.includes("didn't add up") ? "warn" : "done", added.line ?? "CED documents found in it. Waiting in Needs Attention: press Add To CED Documents.");
            continue;
          }
          setState("reading");
          // SAVED IS SAVED (audit v994, SI4): once the row is in, a reader that never answers is a
          // paper waiting for Read Now, never "Not added".
          try {
            res = await readPaperworkItem(added.id);
          } catch {
            setState("warn", "Saved, not read yet: the reader didn't answer. It is waiting in Needs Attention; press Read Now.");
            continue;
          }
          if (!res.ok) {
            setState("warn", `Saved, not read: ${res.error ?? "the reader didn't answer."} It is waiting in Needs Attention.`);
            continue;
          }
        } else {
          setState("reading");
          res = await analyzeAndFile({ path, name: file.name, mime: file.type, size: file.size, sha256: sha });
          if (!res.ok) throw new Error(res.error);
        }
        const it = res.item!;
        // NOTHING IS FILED BY THE READ (Erik, 2026-09-24). The line says what was read and where
        // it is waiting; a person presses File It in Needs Attention.
        // WHERE IT GOES, said the way the row will say it (Erik, 2026-09-24): a job the paper names
        // is picked and says why; anything else is a question, with a model's idea only a guess.
        const total = it.amount != null ? formatCurrency(it.amount) : "no total read";
        const s = it.suggestion;
        const where =
          s?.picked && s.jobLabel
            ? `${s.because ?? "Job picked from the paper"}: ${s.jobLabel}. Waiting in Needs Attention for File It.`
            : s?.picked && s.bucket
              ? `${s.because ?? `Business cost picked from the paper: ${bucketOf(s.bucket)}`}. Waiting in Needs Attention for File It.`
              : `Waiting in Needs Attention: where does this go?${
                s?.jobLabel ? ` (a guess: ${s.jobLabel})` : s?.bucket ? ` (a guess: Business Cost, ${bucketOf(s.bucket)})` : ""
              }`;
        setState(
          "done",
          it.destination === "note"
            ? "Kept as a note"
            : it.picture
              ? `Read: a picture (${it.title}). Waiting in Needs Attention: what is this?`
              : `Read: ${it.vendor ?? it.title}, ${total}. ${where}`,
        );
      } catch (err: any) {
        setState("error", err?.message ?? "Failed.");
      }
    }
    router.refresh();
    setTimeout(() => setUploads((u) => u.filter((x) => x.status === "error" || x.status === "warn")), 6000);
  }

  function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    processFiles(Array.from(e.target.files ?? []));
    if (fileRef.current) fileRef.current.value = "";
    if (captureRef.current) captureRef.current.value = "";
  }

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
    start(async () => {
      const res = await unarchiveItem(item.id);
      if (!res?.ok) { toast(res?.error ?? "Couldn't restore — try again.", "error"); return; }
      toast(res && "message" in res && res.message ? String(res.message) : "Moved back to Needs Attention", "success");
      router.refresh();
    });
  }

  async function aiReview(item: OrganizedItemRow) {
    setAiBusy(item.id);
    const res = await aiReviewItem(item.id);
    setAiBusy(null);
    if (!res?.ok) { toast(res?.message ?? "AI review failed — try again.", "error"); return; }
    // Success: the verdict is informative content, so keep it in the inline panel
    // (it's a read, not a fire-and-forget confirmation) rather than a transient toast.
    setAiMsg((m) => ({ ...m, [item.id]: res.message }));
    router.refresh();
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
    // A bill with no job is a business cost. bucketOf reads an old word ("Fuel") as its bucket, so
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

            {aiMsg[item.id] && (
              <div className="mt-2 rounded-lg bg-brand/5 px-3 py-2 text-xs text-brand-dark">
                <Sparkles className="mr-1 inline h-3 w-3" /> {aiMsg[item.id]}
              </div>
            )}

            <SuggestChips item={item} />
            <NoteDoors item={item} />
          </div>
        </div>
      </Card>
    );
  }

  /**
   * AI SUGGEST'S PROPOSAL, KEPT ON THE NOTE (Erik, audit v994 PR2). It used to make the task and
   * file the note by itself, and its message vanished with the card. Now it is a chip: a person taps
   * Make Task or Keep As Note, the toast says what happened, and Undo takes it back.
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
          <button type="button" className={chip} disabled={pending} onClick={() => act(() => makeTaskFromPaper(item.id), `Made a task: "${task.title}".`)}>
            <ListTodo className="h-4 w-4 shrink-0 text-brand" />
            <span className="min-w-0 break-words">Make Task: {task.title}</span>
          </button>
        )}
        {keep && (
          <button type="button" className={chip} disabled={pending} onClick={() => act(() => keepAsNote(item.id), "Kept as a note.")}>
            <StickyNote className="h-4 w-4 shrink-0 text-brand" /> Keep As Note
          </button>
        )}
        <span className="text-xs text-slate-500">AI Suggest&apos;s idea{p.why ? `: ${p.why}` : ""}. Nothing moves until you tap it.</span>
      </div>
    );
  }

  function NoteDoors({ item }: { item: OrganizedItemRow }) {
    // Held by the manager, not here: this card is re-created on every render of the page, and a
    // pick kept in its own state would reset each time an upload line moved.
    const pick = notePick[item.id] ?? item.job_id ?? "";
    const setPick = (v: string) => setNotePick((m) => ({ ...m, [item.id]: v }));
    return (
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button onClick={() => aiReview(item)} disabled={pending || aiBusy === item.id}>
          {aiBusy === item.id ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {aiBusy === item.id ? "Looking…" : "AI Suggest"}
        </Button>
        <span className="flex min-w-0 items-center gap-1.5">
          <Briefcase className="h-4 w-4 shrink-0 text-slate-400" />
          <Select value={pick} onChange={(e) => setPick(e.target.value)} disabled={pending} className="h-11 w-48" aria-label="Pick a Job">
            <option value="">Pick a Job…</option>
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
      {/* Capture */}
      <Card>
        <div className="flex flex-col items-center gap-3 px-5 py-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand/10">
            <Sparkles className="h-6 w-6 text-brand" />
          </div>
          <div>
            <div className="font-semibold text-slate-900">Snap it, speak it — I&apos;ll sort and file it.</div>
            <p className="mt-1 text-sm text-slate-500">
              Receipts, handwritten notes, plans, permits, or a quick voice memo. I read each one and put it in
              Needs Attention with what I read; nothing becomes a cost until you press File It.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={takePhoto} disabled={busy}>
              <Camera className="h-4 w-4" /> Take Photo
            </Button>
            <DropTarget onFiles={(files) => void processFiles(files)} accept="image/*,application/pdf" label="Drop Receipts">
              <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
                <Upload className="h-4 w-4" /> Upload
              </Button>
            </DropTarget>
            <Button variant={listening ? "destructive" : "outline"} onClick={voiceNote}>
              <Mic className="h-4 w-4" /> {listening ? "Stop & Save" : "Voice Note"}
            </Button>
            <input ref={fileRef} type="file" multiple accept="image/*,application/pdf" className="hidden" onChange={onFiles} />
            <input ref={captureRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFiles} />
          </div>
          {listening && <p className="text-xs font-medium text-red-600">Listening… tap “Stop &amp; save” when done.</p>}
        </div>

        {uploads.length > 0 && (
          <ul className="divide-y divide-slate-100 border-t border-slate-100">
            {uploads.map((u, i) => (
              <li key={i} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                {(u.status === "uploading" || u.status === "reading") && <Loader2 className="h-4 w-4 animate-spin text-brand" />}
                {u.status === "done" && <Check className="h-4 w-4 text-green-600" />}
                {u.status === "warn" && <AlertCircle className="h-4 w-4 text-amber-500" />}
                {u.status === "error" && <Trash2 className="h-4 w-4 text-red-500" />}
                <span className="min-w-0 flex-1 truncate text-slate-700">{u.name}</span>
                <span className={`text-xs ${u.status === "error" ? "text-red-600" : u.status === "warn" ? "text-amber-800" : "text-slate-400"}`}>
                  {u.status === "uploading" && "Uploading…"}
                  {u.status === "reading" && "Reading…"}
                  {(u.status === "done" || u.status === "warn" || u.status === "error") && (u.message ?? "")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

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
                  <PaperworkList items={trayPapers} jobs={jobs} matches={matches} showAiSuggest />
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
            count: archived.length,
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

      {showCamera && (
        <CameraCapture
          onCapture={(file) => {
            setShowCamera(false);
            processFiles([file]);
          }}
          onClose={() => setShowCamera(false)}
        />
      )}

      {editing && <EditModal key={editing.id} item={editing} />}
    </div>
  );
}
