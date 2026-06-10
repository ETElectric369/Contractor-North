"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Upload,
  Camera,
  Trash2,
  Loader2,
  Receipt,
  StickyNote,
  FileText,
  Sparkles,
  Briefcase,
  Check,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { CameraCapture } from "@/components/camera-capture";
import { formatCurrency, formatDate } from "@/lib/utils";
import { analyzeAndFile, refileItem, deleteOrganizedItem } from "./actions";
import { createBill } from "../jobs/actions";

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
  job_id: string | null;
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
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [showCamera, setShowCamera] = useState(false);
  const [billed, setBilled] = useState<Set<string>>(new Set());
  const fileRef = useRef<HTMLInputElement>(null);

  const busy = uploads.some((u) => u.status === "uploading" || u.status === "reading");

  async function processFiles(files: File[]) {
    if (!files.length) return;
    const supabase = createClient();

    for (const file of files) {
      const label = file.name;
      setUploads((u) => [...u, { name: label, status: "uploading" }]);
      const setState = (status: UploadState["status"], message?: string) =>
        setUploads((u) => u.map((x) => (x.name === label ? { ...x, status, message } : x)));

      try {
        if (file.size > 8 * 1024 * 1024) throw new Error("Over 8 MB — try a smaller photo.");
        const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${orgId}/organize/${Date.now()}-${safe}`;
        const { error: upErr } = await supabase.storage.from("documents").upload(path, file, { upsert: false });
        if (upErr) throw upErr;

        setState("reading");
        const res = await analyzeAndFile({ path, name: file.name, mime: file.type, size: file.size });
        if (!res.ok) throw new Error(res.error);
        setState("done", res.item?.job_label ? `Filed to ${res.item.job_label}` : "Filed (no job match — assign below)");
      } catch (err: any) {
        setState("error", err?.message ?? "Failed.");
      }
    }
    router.refresh();
    // Clear finished rows after a beat so the list stays tidy.
    setTimeout(() => setUploads((u) => u.filter((x) => x.status === "error")), 6000);
  }

  function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    processFiles(Array.from(e.target.files ?? []));
    if (fileRef.current) fileRef.current.value = "";
  }

  function refile(item: OrganizedItemRow, jobId: string) {
    start(async () => {
      await refileItem(item.id, jobId || null);
      router.refresh();
    });
  }

  function remove(item: OrganizedItemRow) {
    if (!confirm(`Delete "${item.title}"? This also removes it from the job and storage.`)) return;
    start(async () => {
      await deleteOrganizedItem(item.id);
      router.refresh();
    });
  }

  function addAsBill(item: OrganizedItemRow) {
    if (!item.job_id || item.amount == null) return;
    start(async () => {
      const res = await createBill({
        job_id: item.job_id!,
        supplier: item.vendor ?? "Receipt",
        bill_number: "",
        amount: item.amount!,
        status: "paid",
        bill_date: item.item_date,
        notes: `From Organize My: ${item.title}`,
      });
      if (res.ok) setBilled((b) => new Set(b).add(item.id));
    });
  }

  const shown = filter === "all" ? items : items.filter((i) => i.kind === filter);
  const counts = {
    receipt: items.filter((i) => i.kind === "receipt").length,
    note: items.filter((i) => i.kind === "note").length,
    job_document: items.filter((i) => i.kind === "job_document").length,
  };

  return (
    <div className="space-y-5">
      {/* Drop zone */}
      <Card>
        <div className="flex flex-col items-center gap-3 px-5 py-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand/10">
            <Sparkles className="h-6 w-6 text-brand" />
          </div>
          <div>
            <div className="font-semibold text-slate-900">Snap it — I&apos;ll sort and file it.</div>
            <p className="mt-1 text-sm text-slate-500">
              Receipts, handwritten notes, plans, permits… I read each one, pull out the details,
              and file it to the right job.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => setShowCamera(true)} disabled={busy}>
              <Camera className="h-4 w-4" /> Take photo
            </Button>
            <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
              <Upload className="h-4 w-4" /> Upload
            </Button>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
              className="hidden"
              onChange={onFiles}
            />
          </div>
        </div>

        {uploads.length > 0 && (
          <ul className="divide-y divide-slate-100 border-t border-slate-100">
            {uploads.map((u, i) => (
              <li key={i} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                {(u.status === "uploading" || u.status === "reading") && (
                  <Loader2 className="h-4 w-4 animate-spin text-brand" />
                )}
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

      {/* Filter chips */}
      <div className="flex flex-wrap gap-2">
        {[
          { id: "all", label: `All (${items.length})` },
          { id: "receipt", label: `Receipts (${counts.receipt})` },
          { id: "note", label: `Notes (${counts.note})` },
          { id: "job_document", label: `Job docs (${counts.job_document})` },
        ].map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium ${
              filter === f.id ? "bg-brand text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Filed items */}
      {shown.length === 0 ? (
        <p className="py-10 text-center text-sm text-slate-400">
          Nothing here yet — snap your first receipt or note above.
        </p>
      ) : (
        <ul className="space-y-3">
          {shown.map((item) => {
            const meta = KIND_META[item.kind] ?? KIND_META.job_document;
            const Icon = meta.icon;
            return (
              <Card key={item.id}>
                <div className="flex gap-4 p-4">
                  {item.signedUrl ? (
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
                  ) : (
                    <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-slate-100">
                      <Icon className="h-6 w-6 text-slate-400" />
                    </span>
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-slate-900">{item.title}</span>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                      {item.confidence === "low" && <Badge tone="red">check me</Badge>}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-3 text-xs text-slate-500">
                      {item.vendor && <span>{item.vendor}</span>}
                      {item.amount != null && <span className="font-medium text-slate-700">{formatCurrency(item.amount)}</span>}
                      {item.item_date && <span>{formatDate(item.item_date)}</span>}
                      <span>Added {formatDate(item.created_at)}</span>
                    </div>
                    {item.summary && (
                      <details className="mt-1.5">
                        <summary className="cursor-pointer text-xs font-medium text-brand">
                          {item.kind === "note" ? "Read transcription" : "Details"}
                        </summary>
                        <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">{item.summary}</p>
                      </details>
                    )}

                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                      <Briefcase className="h-3.5 w-3.5 text-slate-400" />
                      <Select
                        value={item.job_id ?? ""}
                        onChange={(e) => refile(item, e.target.value)}
                        disabled={pending}
                        className="h-8 w-56 text-xs"
                      >
                        <option value="">No job (unfiled)</option>
                        {jobs.map((j) => (
                          <option key={j.id} value={j.id}>
                            {j.job_number} — {j.name}
                          </option>
                        ))}
                      </Select>
                      {item.kind === "receipt" && item.job_id && item.amount != null && (
                        billed.has(item.id) ? (
                          <span className="flex items-center gap-1 text-xs font-medium text-green-600">
                            <Check className="h-3.5 w-3.5" /> Added as bill
                          </span>
                        ) : (
                          <Button size="sm" variant="outline" onClick={() => addAsBill(item)} disabled={pending}>
                            <Receipt className="h-3.5 w-3.5" /> Add as job bill
                          </Button>
                        )
                      )}
                      <button
                        onClick={() => remove(item)}
                        disabled={pending}
                        className="ml-auto rounded-md p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </ul>
      )}

      {showCamera && (
        <CameraCapture
          onCapture={(file) => {
            setShowCamera(false);
            processFiles([file]);
          }}
          onClose={() => setShowCamera(false)}
        />
      )}
    </div>
  );
}
