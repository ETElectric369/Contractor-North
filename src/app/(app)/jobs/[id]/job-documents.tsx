"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Upload, Camera, Trash2, Loader2, FileText } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils";
import { addDocument, deleteDocument } from "../actions";

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

function prettySize(n: number | null) {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
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

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    setError(null);
    setBusy(true);
    try {
      const supabase = createClient();
      for (const file of files) {
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
      }
      router.refresh();
    } catch (err: any) {
      setError(err?.message ?? "Upload failed.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function remove(d: Doc) {
    if (!confirm(`Delete "${d.name}"?`)) return;
    start(async () => {
      await deleteDocument(d.id, d.file_url, jobId);
      router.refresh();
    });
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Select value={category} onChange={(e) => setCategory(e.target.value)} className="w-32">
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="image/*,application/pdf"
          className="hidden"
          onChange={onFiles}
        />
        <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          Upload file
        </Button>
        {/* On phones this opens the camera directly. */}
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50">
          <Camera className="h-4 w-4" /> Take photo
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={onFiles}
          />
        </label>
      </div>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

      {docs.length === 0 ? (
        <p className="text-sm text-slate-400">
          No receipts or documents yet. Upload a bill, or snap a photo of a receipt.
        </p>
      ) : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
          {docs.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-4 py-2.5">
              <FileText className="h-4 w-4 shrink-0 text-slate-400" />
              <div className="min-w-0 flex-1">
                {d.signedUrl ? (
                  <a
                    href={d.signedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="truncate text-sm font-medium text-slate-900 hover:text-brand"
                  >
                    {d.name}
                  </a>
                ) : (
                  <span className="truncate text-sm font-medium text-slate-900">{d.name}</span>
                )}
                <div className="text-xs text-slate-400">
                  {formatDate(d.created_at)}
                  {d.size_bytes ? ` · ${prettySize(d.size_bytes)}` : ""}
                </div>
              </div>
              {d.category && <Badge tone="blue">{d.category}</Badge>}
              <button
                onClick={() => remove(d)}
                disabled={pending}
                className="rounded p-1 text-slate-400 hover:bg-red-50 hover:text-red-600"
                title="Delete"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
