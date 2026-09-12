"use client";

import { useRef, useState, useTransition } from "react";
import { DropTarget } from "@/components/drop-target";
import { useRouter } from "next/navigation";
import { Upload, Camera, Trash2, Loader2, FileText, DollarSign, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { CameraCapture } from "@/components/camera-capture";
import { MediaLightbox } from "@/components/media-lightbox";
import { captureReceipt, prettyBytes, readReceiptDocument, type ReceiptTone } from "@/lib/receipt-capture";
import { deleteDocument, updateDocument } from "../actions";

const COSTABLE = (c: string | null) => c === "Receipt" || c === "Bill";

const CATEGORIES = ["Receipt", "Bill", "Invoice", "Photo", "Plan", "Permit", "Other"];

interface Doc {
  id: string;
  name: string;
  category: string | null;
  file_url: string | null; // null = Organize note filed to the job (no file)
  size_bytes: number | null;
  created_at: string;
  signedUrl: string | null;
}

const isImage = (d: Doc) => /\.(jpe?g|png|webp|gif|heic)($|\?)/i.test(d.signedUrl ?? d.name);
const isPdf = (d: Doc) => /\.pdf($|\?)/i.test(d.signedUrl ?? d.name);

function onPhone() {
  return (
    typeof navigator !== "undefined" &&
    (navigator.maxTouchPoints > 0 || /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent))
  );
}

/** What the reader said about one document, under its row. `done` = a bill exists for it (created
 *  now, or found already), so the Record as Cost verb goes away — a warning tone can still ride a
 *  done note (the reader's lines didn't add up; the bill is in, the notes carry the warning). */
type BillNote = { text: string; done: boolean; tone: ReceiptTone };

const NOTE_COLOR: Record<ReceiptTone, string> = {
  ok: "text-emerald-600",
  warn: "text-amber-600",
  fail: "text-red-600",
};

/**
 * The job's filing cabinet (plans, permits, every receipt). Uploads run THE receipt pipeline
 * (lib/receipt-capture — the same one the Costs tab's Snap the Bill and the Add Cost sheet
 * run): a Receipt or Bill is filed and then read into a job cost; anything else is only filed.
 * A file the reader can't take is still filed and its row says why; "Record as Cost" is the retry.
 */
export function JobDocuments({
  orgId,
  jobId,
  docs,
}: {
  orgId: string;
  jobId: string;
  docs: Doc[];
}) {
  const router = useRouter();
  const [category, setCategory] = useState("Receipt");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<HTMLInputElement>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [viewing, setViewing] = useState<Doc | null>(null);
  // Inline rename / re-categorize editor — null when closed.
  const [editing, setEditing] = useState<Doc | null>(null);
  const [editName, setEditName] = useState("");
  const [editCategory, setEditCategory] = useState("Receipt");
  const [editErr, setEditErr] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  // Per-document "recorded as a job cost" status, keyed by document id.
  const [billing, setBilling] = useState<string | null>(null);
  const [billMsg, setBillMsg] = useState<Record<string, BillNote>>({});

  const note = (docId: string, n: BillNote | null) =>
    setBillMsg((m) => {
      const next = { ...m };
      if (n) next[docId] = n;
      else delete next[docId];
      return next;
    });

  async function uploadFiles(files: File[]) {
    if (!files.length) return;
    setError(null);
    setBusy(true);
    // Every file gets its turn: one that won't upload is reported by name and the rest still
    // go through (the old loop threw on the first failure and quietly abandoned the others).
    const lost: string[] = [];
    let touched = false;
    for (const raw of files) {
      const out = await captureReceipt({ orgId, jobId, file: raw, category, read: COSTABLE(category) });
      if (out.kind === "lost") {
        lost.push(`${raw.name || "File"}: ${out.sentence}`);
        continue;
      }
      touched = true;
      // Paper that isn't a cost (a Plan, a Permit) is simply filed — its row is the confirmation.
      if (out.kind === "filed" && out.why === "not_asked") continue;
      note(out.docId, { text: out.sentence, done: out.kind !== "filed", tone: out.tone });
    }
    if (lost.length) setError(lost.join(" "));
    setBusy(false);
    if (touched) router.refresh();
  }

  // Convert an already-filed receipt/bill into a job cost on demand — the retry for anything
  // the upload-time read refused.
  async function recordCost(d: Doc) {
    setBilling(d.id);
    note(d.id, null);
    try {
      const out = await readReceiptDocument(d.id);
      note(d.id, { text: out.sentence, done: out.kind !== "filed", tone: out.tone });
      if (out.kind === "billed") router.refresh();
    } finally {
      setBilling(null);
    }
  }

  function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    uploadFiles(Array.from(e.target.files ?? []));
    if (fileRef.current) fileRef.current.value = "";
    if (captureRef.current) captureRef.current.value = "";
  }

  // Phones get the real camera app; desktop gets the in-browser capture modal.
  function takePhoto() {
    if (onPhone()) captureRef.current?.click();
    else setShowCamera(true);
  }

  function open(d: Doc) {
    if (d.signedUrl && (isImage(d) || isPdf(d))) setViewing(d);
    else if (d.signedUrl) window.open(d.signedUrl, "_blank");
  }

  function remove(d: Doc) {
    if (!confirm(`Delete "${d.name}"?`)) return;
    start(async () => {
      await deleteDocument(d.id, d.file_url, jobId);
      router.refresh();
    });
  }

  function openEdit(d: Doc) {
    setEditing(d);
    setEditName(d.name);
    setEditCategory(d.category ?? "Other");
    setEditErr(null);
  }

  async function saveEdit() {
    if (!editing) return;
    if (!editName.trim()) {
      setEditErr("Name is required.");
      return;
    }
    setSavingEdit(true);
    setEditErr(null);
    const res = await updateDocument(
      editing.id,
      { name: editName, category: editCategory },
      jobId,
    );
    setSavingEdit(false);
    if (!res.ok) {
      setEditErr(res.error ?? "Couldn't save changes.");
      return;
    }
    setEditing(null);
    router.refresh();
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-32">
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </Select>
        <input ref={fileRef} type="file" multiple accept="image/*,application/pdf" className="hidden" onChange={onFiles} />
        <input ref={captureRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFiles} />
        <DropTarget onFiles={(files) => void uploadFiles(files)} accept="image/*,application/pdf" label="Drop Files">
          <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            Upload File
          </Button>
        </DropTarget>
        <Button variant="outline" type="button" onClick={takePhoto} disabled={busy}>
          <Camera className="h-4 w-4" /> Take Photo
        </Button>
      </div>

      {showCamera && (
        <CameraCapture
          onCapture={(file) => {
            setShowCamera(false);
            uploadFiles([file]);
          }}
          onClose={() => setShowCamera(false)}
        />
      )}
      {viewing?.signedUrl && (
        <MediaLightbox url={viewing.signedUrl} name={viewing.name} onClose={() => setViewing(null)} />
      )}

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title="Edit document"
        size="sm"
        footer={
          <ModalActions
            onCancel={() => setEditing(null)}
            onSave={saveEdit}
            saving={savingEdit}
          />
        }
      >
        <div className="space-y-4">
          <div>
            <Label htmlFor="doc-name">Name</Label>
            <Input
              id="doc-name"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              placeholder="Document name"
            />
          </div>
          <div>
            <Label htmlFor="doc-category">Category</Label>
            <Select
              id="doc-category"
              value={editCategory}
              onChange={(e) => setEditCategory(e.target.value)}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
          </div>
          {editErr && <p className="text-sm text-red-600">{editErr}</p>}
        </div>
      </Modal>

      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

      {docs.length === 0 ? (
        <p className="text-sm text-slate-400">
          No receipts or documents yet. Upload a bill, or snap a photo of a receipt.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {docs.map((d) => {
            const n = billMsg[d.id];
            return (
            <li key={d.id} className="flex flex-col gap-1.5 px-3 py-2.5">
              <div className="flex items-center gap-3">
                <button onClick={() => open(d)} className="shrink-0">
                  {isImage(d) && d.signedUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={d.signedUrl} alt="" className="h-12 w-12 rounded-md object-cover" />
                  ) : (
                    <span className="flex h-12 w-12 items-center justify-center rounded-md bg-slate-100">
                      <FileText className="h-5 w-5 text-slate-400" />
                    </span>
                  )}
                </button>
                <button onClick={() => open(d)} className="min-w-0 flex-1 text-left">
                  <div className="truncate text-sm font-medium text-slate-900 hover:text-brand">{d.name}</div>
                  <div className="text-xs text-slate-400">
                    {formatDate(d.created_at)}
                    {d.size_bytes ? ` · ${prettyBytes(d.size_bytes)}` : ""}
                  </div>
                </button>
                {COSTABLE(d.category) && !n?.done && (
                  <button
                    onClick={() => recordCost(d)}
                    disabled={billing === d.id}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-brand/30 bg-brand/5 px-2 py-1 text-xs font-medium text-brand hover:bg-brand/10 disabled:opacity-50"
                    title="Nort reads the receipt and adds it to this job's costs"
                  >
                    {billing === d.id ? (
                      <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                    ) : (
                      <DollarSign className="h-4 w-4 shrink-0" />
                    )}
                    Record as Cost
                  </button>
                )}
                {d.category && <Badge tone="blue">{d.category}</Badge>}
                <button
                  onClick={() => openEdit(d)}
                  className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  title="Rename or re-categorize"
                >
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => remove(d)}
                  disabled={pending}
                  className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                  title="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
              {n && (
                <div className={`pl-15 text-xs ${NOTE_COLOR[n.tone]}`}>
                  {n.text}
                </div>
              )}
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
