"use client";

import { useRef, useState } from "react";
import { Upload, Trash2, Loader2, ChevronLeft, ChevronRight, Check } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { prepareImageForUpload } from "@/lib/image-prep";
import { updateOrgSettings } from "./actions";

type Photo = { url: string; src?: string; path?: string };

/**
 * Manage the public site's portfolio gallery: upload (multi), remove, reorder. Photos go to the
 * PUBLIC branding bucket under the org's own folder (RLS: first path segment must be the org id)
 * and the ordered manifest is saved to settings.portfolio — the exact shape the site reads.
 */
export function PortfolioManager({ orgId, initial }: { orgId: string; initial: Photo[] }) {
  const [photos, setPhotos] = useState<Photo[]>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedTick, setSavedTick] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function persist(next: Photo[]) {
    setPhotos(next);
    const res = await updateOrgSettings({ portfolio: next });
    if (!res.ok) { setError(res.error ?? "Couldn't save order."); return; }
    setSavedTick(true);
    setTimeout(() => setSavedTick(false), 1800);
  }

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    setError(null);
    setBusy(true);
    const supabase = createClient();
    const added: Photo[] = [];
    try {
      for (let i = 0; i < files.length; i++) {
        const file = await prepareImageForUpload(files[i]);
        const ext = file.type === "image/png" ? "png" : "jpg";
        const path = `${orgId}/portfolio-${Date.now()}-${i}.${ext}`;
        const { error: upErr } = await supabase.storage.from("branding").upload(path, file, { upsert: true, cacheControl: "3600" });
        if (upErr) throw upErr;
        const { data } = supabase.storage.from("branding").getPublicUrl(path);
        added.push({ url: data.publicUrl, path, src: files[i].name });
      }
      await persist([...photos, ...added]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function remove(idx: number) {
    const p = photos[idx];
    setBusy(true);
    try {
      if (p.path) await createClient().storage.from("branding").remove([p.path]);
    } catch { /* orphan is harmless — still drop from the manifest */ }
    await persist(photos.filter((_, i) => i !== idx));
    setBusy(false);
  }

  async function move(idx: number, dir: -1 | 1) {
    const j = idx + dir;
    if (j < 0 || j >= photos.length) return;
    const next = [...photos];
    [next[idx], next[j]] = [next[j], next[idx]];
    await persist(next);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <input ref={fileRef} type="file" accept="image/*" multiple className="hidden" onChange={onFiles} />
        <Button type="button" variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          {busy ? "Uploading…" : "Add photos"}
        </Button>
        <span className="text-sm text-slate-400">{photos.length} photo{photos.length === 1 ? "" : "s"}</span>
        {savedTick && <span className="flex items-center gap-1 text-sm font-medium text-green-600"><Check className="h-4 w-4" /> Saved</span>}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}

      {photos.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-400">
          No photos yet. Add your best project shots — they show as the &ldquo;Our recent work&rdquo; gallery on your site.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {photos.map((p, i) => (
            <div key={p.url} className="group relative aspect-square overflow-hidden rounded-lg border border-slate-200 bg-slate-50">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt={`Project ${i + 1}`} loading="lazy" className="h-full w-full object-cover" />
              <div className="absolute inset-0 flex items-end justify-between bg-gradient-to-t from-black/50 to-transparent p-1.5 opacity-0 transition group-hover:opacity-100">
                <button type="button" onClick={() => move(i, -1)} disabled={busy || i === 0} className="rounded bg-white/85 p-1 text-slate-700 disabled:opacity-30" aria-label="Move earlier">
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button type="button" onClick={() => remove(i)} disabled={busy} className="rounded bg-white/85 p-1 text-red-600" aria-label="Remove photo">
                  <Trash2 className="h-4 w-4" />
                </button>
                <button type="button" onClick={() => move(i, 1)} disabled={busy || i === photos.length - 1} className="rounded bg-white/85 p-1 text-slate-700 disabled:opacity-30" aria-label="Move later">
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
