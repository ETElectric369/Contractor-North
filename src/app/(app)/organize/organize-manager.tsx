"use client";

import { useRef, useState, useTransition } from "react";
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
  Wallet,
  Coins,
  Check,
  AlertCircle,
  Archive,
  RotateCcw,
  Pencil,
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
import { useToast } from "@/components/toast";
import { formatCurrency, formatDate } from "@/lib/utils";
import { prepareImageForUpload } from "@/lib/image-prep";
import {
  analyzeAndFile,
  fileItem,
  deleteOrganizedItem,
  updateOrganizedItem,
  saveVoiceNote,
  archiveItem,
  unarchiveItem,
  aiReviewItem,
} from "./actions";
import { OVERHEAD_CATEGORIES } from "./constants";
import { jobLabel } from "@/lib/schedule-options";

// The categories Claude assigns during extraction — offered so the owner can
// correct a mis-classified item to any valid kind. Mirrors analyzeAndFile.
const ITEM_CATEGORIES = ["Receipt", "Bill", "Invoice", "Photo", "Plan", "Permit", "Note", "Other"];

export interface OrganizedItemRow {
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
}

interface JobOption {
  id: string;
  job_number: string;
  name: string;
}

type UploadState = { name: string; status: "uploading" | "reading" | "done" | "error"; message?: string };

const KIND_META: Record<string, { label: string; icon: any; tone: "green" | "amber" | "blue" }> = {
  receipt: { label: "Receipt", icon: Receipt, tone: "green" },
  note: { label: "Note", icon: StickyNote, tone: "amber" },
  job_document: { label: "Job doc", icon: FileText, tone: "blue" },
};

export function OrganizeManager({
  orgId,
  items,
  jobs,
}: {
  orgId: string;
  items: OrganizedItemRow[];
  jobs: JobOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const toast = useToast();
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [showCamera, setShowCamera] = useState(false);
  const [listening, setListening] = useState(false);
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [aiMsg, setAiMsg] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<OrganizedItemRow | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<HTMLInputElement>(null);
  const recogRef = useRef<any>(null);

  function takePhoto() {
    const touchy =
      typeof window !== "undefined" &&
      (window.matchMedia?.("(pointer: coarse)").matches ||
        navigator.maxTouchPoints > 0 ||
        /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent));
    if (touchy) captureRef.current?.click();
    else setShowCamera(true);
  }

  // Voice note: tap to start, tap again to stop; the transcript becomes a note
  // in the needs-attention tray (where AI review can file it for you).
  function voiceNote() {
    if (listening) {
      recogRef.current?.stop();
      return;
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      alert("Voice notes need a browser with speech recognition (Chrome, or desktop Safari).");
      return;
    }
    const r = new SR();
    r.continuous = true;
    r.interimResults = false;
    r.lang = "en-US";
    let acc = "";
    r.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) acc += e.results[i][0].transcript;
    };
    r.onerror = () => setListening(false);
    r.onend = () => {
      setListening(false);
      const text = acc.trim();
      if (text)
        start(async () => {
          const res = await saveVoiceNote(text);
          if (!res?.ok) { toast(res?.error ?? "Couldn't save voice note — try again.", "error"); return; }
          toast("Voice note saved", "success");
          router.refresh();
        });
    };
    r.start();
    recogRef.current = r;
    setListening(true);
  }

  const busy = uploads.some((u) => u.status === "uploading" || u.status === "reading");
  const tray = items.filter((i) => i.status === "needs_review");
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
        const file = await prepareImageForUpload(raw);
        if (file.size > 8 * 1024 * 1024) throw new Error("Over 8 MB — try a smaller photo.");
        const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${orgId}/organize/${Date.now()}-${safe}`;
        const { error: upErr } = await supabase.storage.from("documents").upload(path, file, { upsert: false });
        if (upErr) throw upErr;

        setState("reading");
        const res = await analyzeAndFile({ path, name: file.name, mime: file.type, size: file.size });
        if (!res.ok) throw new Error(res.error);
        const it = res.item!;
        setState(
          "done",
          it.status === "needs_review"
            ? "Needs your call — see the tray"
            : it.destination === "job"
              ? `Filed to ${it.job_label}`
              : it.destination === "overhead"
                ? "Filed as overhead"
                : "Filed",
        );
      } catch (err: any) {
        setState("error", err?.message ?? "Failed.");
      }
    }
    router.refresh();
    setTimeout(() => setUploads((u) => u.filter((x) => x.status === "error")), 6000);
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
      toast(dest.type === "unfiled" ? "Moved to unfiled" : "Filed", "success");
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
      toast("Moved back to needs-attention", "success");
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
      toast("Deleted", "success");
      router.refresh();
    });
  }

  function filedBadge(item: OrganizedItemRow) {
    if (item.status === "archived") return <Badge tone="slate">Archived</Badge>;
    if (item.job_id && item.jobs) return <Badge tone="blue">{jobLabel(item.jobs)}</Badge>;
    if (item.bill_id) return <Badge tone="purple">Overhead · {item.category ?? "Other"}</Badge>;
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

  /** Needs-attention card: full filing exits + AI review + archive. Archive is the
   *  safe inline remove — hard Delete lives only on archived (already-triaged) cards. */
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

            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => aiReview(item)} disabled={pending || aiBusy === item.id}>
                {aiBusy === item.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                {aiBusy === item.id ? "Reviewing…" : "AI Review & File"}
              </Button>
              <span className="flex items-center gap-1.5">
                <Briefcase className="h-3.5 w-3.5 text-slate-400" />
                <Select
                  value={item.job_id ?? ""}
                  onChange={(e) =>
                    e.target.value ? file(item, { type: "job", jobId: e.target.value }) : file(item, { type: "unfiled" })
                  }
                  disabled={pending}
                  className="h-8 w-44 text-xs"
                >
                  <option value="">File to job…</option>
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>{j.job_number} — {j.name}</option>
                  ))}
                </Select>
              </span>
              {item.kind === "receipt" && (
                <span className="flex items-center gap-1.5">
                  <Wallet className="h-3.5 w-3.5 text-slate-400" />
                  <Select
                    value=""
                    onChange={(e) => e.target.value && file(item, { type: "overhead", category: e.target.value })}
                    disabled={pending}
                    className="h-8 w-36 text-xs"
                  >
                    <option value="">Overhead…</option>
                    {OVERHEAD_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </Select>
                </span>
              )}
              {item.kind === "receipt" && item.amount != null && (
                <Button size="sm" variant="outline" onClick={() => file(item, { type: "petty_cash" })} disabled={pending}>
                  <Coins className="h-3.5 w-3.5" /> Petty Cash
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setEditing(item)} disabled={pending}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Button>
              <Button size="sm" variant="outline" onClick={() => archive(item)} disabled={pending}>
                <Archive className="h-3.5 w-3.5" /> Archive
              </Button>
            </div>
          </div>
        </div>
      </Card>
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
          <button onClick={() => restore(item)} disabled={pending} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Back to needs-attention">
            <RotateCcw className="h-4 w-4" />
          </button>
          <button onClick={() => setEditing(item)} disabled={pending} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" title="Edit details">
            <Pencil className="h-4 w-4" />
          </button>
          <button onClick={() => remove(item)} disabled={pending} className="rounded-md p-1 text-slate-400 hover:bg-red-50 hover:text-red-600" title="Delete">
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
              Receipts, handwritten notes, plans, permits, or a quick voice memo. I file what I&apos;m sure
              about and leave the rest in your needs-attention list.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={takePhoto} disabled={busy}>
              <Camera className="h-4 w-4" /> Take Photo
            </Button>
            <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
              <Upload className="h-4 w-4" /> Upload
            </Button>
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
                {u.status === "error" && <Trash2 className="h-4 w-4 text-red-500" />}
                <span className="min-w-0 flex-1 truncate text-slate-700">{u.name}</span>
                <span className={`text-xs ${u.status === "error" ? "text-red-600" : "text-slate-400"}`}>
                  {u.status === "uploading" && "Uploading…"}
                  {u.status === "reading" && "Reading & filing…"}
                  {(u.status === "done" || u.status === "error") && (u.message ?? "")}
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
                <ul className="space-y-3">
                  {tray.map((item) => <li key={item.id}><AttentionCard item={item} /></li>)}
                </ul>
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
