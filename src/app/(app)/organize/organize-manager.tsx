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
  Wallet,
  Coins,
  Check,
  AlertCircle,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { CameraCapture } from "@/components/camera-capture";
import { formatCurrency, formatDate } from "@/lib/utils";
import { analyzeAndFile, fileItem, deleteOrganizedItem } from "./actions";
import { OVERHEAD_CATEGORIES } from "./constants";

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
  const [uploads, setUploads] = useState<UploadState[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [showCamera, setShowCamera] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const busy = uploads.some((u) => u.status === "uploading" || u.status === "reading");
  const tray = items.filter((i) => i.status === "needs_review");
  const filed = items.filter((i) => i.status !== "needs_review");

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
        const it = res.item!;
        setState(
          "done",
          it.status === "needs_review"
            ? "Needs your call — see the tray below"
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
  }

  function file(item: OrganizedItemRow, dest: Parameters<typeof fileItem>[1]) {
    start(async () => {
      await fileItem(item.id, dest);
      router.refresh();
    });
  }

  function remove(item: OrganizedItemRow) {
    if (!confirm(`Delete "${item.title}"? This also removes whatever it filed.`)) return;
    start(async () => {
      await deleteOrganizedItem(item.id);
      router.refresh();
    });
  }

  /** Where the item currently lives, as a short badge. */
  function filedBadge(item: OrganizedItemRow) {
    if (item.job_id && item.jobs)
      return <Badge tone="blue">{item.jobs.job_number} · {item.jobs.name}</Badge>;
    if (item.bill_id) return <Badge tone="purple">Overhead · {item.category ?? "Other"}</Badge>;
    if (item.category === "Petty cash") return <Badge tone="indigo">Petty cash</Badge>;
    if (item.kind === "note") return <Badge tone="amber">Note</Badge>;
    return <Badge tone="slate">Unfiled</Badge>;
  }

  function ItemCard({ item, attention = false }: { item: OrganizedItemRow; attention?: boolean }) {
    const meta = KIND_META[item.kind] ?? KIND_META.job_document;
    const Icon = meta.icon;
    return (
      <Card className={attention ? "border-amber-300 bg-amber-50/40" : undefined}>
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
              {!attention && filedBadge(item)}
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

            {/* The four exits: job · overhead · petty cash · delete */}
            <div className="mt-2.5 flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1.5">
                <Briefcase className="h-3.5 w-3.5 text-slate-400" />
                <Select
                  value={item.job_id ?? ""}
                  onChange={(e) =>
                    e.target.value
                      ? file(item, { type: "job", jobId: e.target.value })
                      : file(item, { type: "unfiled" })
                  }
                  disabled={pending}
                  className="h-8 w-48 text-xs"
                >
                  <option value="">{item.job_id ? "Remove from job" : "File to job…"}</option>
                  {jobs.map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.job_number} — {j.name}
                    </option>
                  ))}
                </Select>
              </span>
              {item.kind === "receipt" && (
                <span className="flex items-center gap-1.5">
                  <Wallet className="h-3.5 w-3.5 text-slate-400" />
                  <Select
                    value={item.bill_id ? item.category ?? "" : ""}
                    onChange={(e) => e.target.value && file(item, { type: "overhead", category: e.target.value })}
                    disabled={pending}
                    className="h-8 w-40 text-xs"
                  >
                    <option value="">Overhead…</option>
                    {OVERHEAD_CATEGORIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </Select>
                </span>
              )}
              {item.kind === "receipt" && item.amount != null && item.category !== "Petty cash" && (
                <Button size="sm" variant="outline" onClick={() => file(item, { type: "petty_cash" })} disabled={pending}>
                  <Coins className="h-3.5 w-3.5" /> Petty cash
                </Button>
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
  }

  const shown = filter === "all" ? filed : filed.filter((i) => i.kind === filter);
  const counts = {
    receipt: filed.filter((i) => i.kind === "receipt").length,
    note: filed.filter((i) => i.kind === "note").length,
    job_document: filed.filter((i) => i.kind === "job_document").length,
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
              Receipts, handwritten notes, plans, permits… Job costs file to the job, company
              expenses file to overhead, and anything I&apos;m not sure about waits for your call.
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

      {/* Needs attention tray */}
      {tray.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-amber-600" />
            <h2 className="text-sm font-semibold text-slate-900">
              Needs your call <span className="text-amber-600">({tray.length})</span>
            </h2>
            <span className="text-xs text-slate-400">— pick a destination and it files itself</span>
          </div>
          <ul className="space-y-3">
            {tray.map((item) => (
              <ItemCard key={item.id} item={item} attention />
            ))}
          </ul>
        </div>
      )}

      {/* Filter chips */}
      <div className="flex flex-wrap gap-2">
        {[
          { id: "all", label: `All (${filed.length})` },
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
          {shown.map((item) => (
            <ItemCard key={item.id} item={item} />
          ))}
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
