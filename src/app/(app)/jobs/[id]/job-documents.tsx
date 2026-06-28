"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Upload, Camera, Trash2, Loader2, FileText, DollarSign, Pencil } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Modal, ModalActions } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { CameraCapture } from "@/components/camera-capture";
import { MediaLightbox } from "@/components/media-lightbox";
import { prepareImageForUpload } from "@/lib/image-prep";
import { addDocument, deleteDocument, updateDocument } from "../actions";
import { billJobReceipt } from "../../organize/actions";

const COSTABLE = (c: string | null) => c === "Receipt" || c === "Bill";

const CATEGORIES = ["Receipt", "Bill", "Invoice", "Photo", "Plan", "Permit", "Other"];

interface Doc {
  id: string;
  name: string;
  category: string | null;
  file_url: string;
  size_bytes: number | null;
  created_at: string;
  signedUrl: string | null;
}

const isImage = (d: Doc) => /\.(jpe?g|png|webp|gif|heic)($|\?)/i.test(d.signedUrl ?? d.name);
const isPdf = (d: Doc) => /\.pdf($|\?)/i.test(d.signedUrl ?? d.name);

function prettySize(n: number | null) {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function onPhone() {
  return (
    typeof navigator !== "undefined" &&
    (navigator.maxTouchPoints > 0 || /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent))
  );
}

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
  const [billMsg, setBillMsg] = useState<Record<string, string>>({});

  async function uploadFiles(files: File[]) {
    if (!files.length) return;
    setError(null);
    setBusy(true);
    try {
      const supabase = createClient();
      for (const raw of files) {
        // Normalize: HEIC → JPEG, downscale huge phone shots.
        const file = await prepareImageForUpload(raw);
        if (file.size > 15 * 1024 * 1024) {
          setError(`${file.name} is over 15 MB.`);
          continue;
        }
        const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${orgId}/${jobId}/${Date.now()}-${safe}`;
        const { error: upErr } = await supabase.storage
          .from("documents")
          .upload(path, file, { upsert: false });
        if (upErr) throw upErr;
        const res = await addDocument({
          job_id: jobId,
          name: file.name,
          category,
          file_url: path,
          size_bytes: file.size,
        });
        if (!res.ok) throw new Error(res.error);
        // Receipts & bills become job costs automatically — AI reads the total.
        if (COSTABLE(category) && res.id) {
          const docId = res.id;
          try {
            const billed = await billJobReceipt(docId);
            if (billed.ok && !billed.already) {
              setBillMsg((m) => ({
                ...m,
                [docId]: `Recorded${billed.amount != null ? ` $${billed.amount.toFixed(2)}` : ""} as a job cost.`,
              }));
            } else if (!billed.ok) {
              setBillMsg((m) => ({ ...m, [docId]: billed.error ?? "Saved — add the cost manually." }));
            }
          } catch {
            /* never let a costing hiccup fail the upload */
          }
        }
      }
      router.refresh();
    } catch (err: any) {
      setError(err?.message ?? "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  // Convert an already-uploaded receipt/bill into a job cost on demand.
  async function recordCost(d: Doc) {
    setBilling(d.id);
    setBillMsg((m) => ({ ...m, [d.id]: "" }));
    try {
      const res = await billJobReceipt(d.id);
      if (!res.ok) {
        setBillMsg((m) => ({ ...m, [d.id]: res.error ?? "Couldn't record this as a cost." }));
      } else if (res.already) {
        setBillMsg((m) => ({ ...m, [d.id]: "Already recorded as a job cost." }));
      } else {
        setBillMsg((m) => ({
          ...m,
          [d.id]: `Recorded${res.amount != null ? ` $${res.amount.toFixed(2)}` : ""} as a job cost.`,
        }));
        router.refresh();
      }
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
        <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          Upload file
        </Button>
        <Button variant="outline" type="button" onClick={takePhoto} disabled={busy}>
          <Camera className="h-4 w-4" /> Take photo
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
            const recorded = /^Recorded|^Already/.test(billMsg[d.id] ?? "");
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
                    {d.size_bytes ? ` · ${prettySize(d.size_bytes)}` : ""}
                  </div>
                </button>
                {COSTABLE(d.category) && !recorded && (
                  <button
                    onClick={() => recordCost(d)}
                    disabled={billing === d.id}
                    className="inline-flex shrink-0 items-center gap-1 rounded-md border border-brand/30 bg-brand/5 px-2 py-1 text-xs font-medium text-brand hover:bg-brand/10 disabled:opacity-50"
                    title="AI reads the receipt and adds it to this job's costs"
                  >
                    {billing === d.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <DollarSign className="h-3.5 w-3.5" />
                    )}
                    Record as cost
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
              {billMsg[d.id] && (
                <div className={`pl-15 text-xs ${recorded ? "text-emerald-600" : "text-amber-600"}`}>
                  {billMsg[d.id]}
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
