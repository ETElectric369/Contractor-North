"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Camera, Upload, Trash2, Loader2, ImageOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MediaLightbox } from "@/components/media-lightbox";
import { useToast } from "@/components/toast";
import { deleteDocument } from "../actions";
import { uploadJobPhotos } from "./upload-job-photos";

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

function onPhone() {
  return (
    typeof navigator !== "undefined" &&
    (navigator.maxTouchPoints > 0 || /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent))
  );
}

/** Photos tab: every job photo as a tappable thumbnail grid. */
export function JobPhotos({ orgId, jobId, docs }: { orgId: string; jobId: string; docs: Doc[] }) {
  const router = useRouter();
  const toast = useToast();
  const photos = docs.filter(isImage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [viewing, setViewing] = useState<Doc | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<HTMLInputElement>(null);

  async function upload(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    setError(null);
    try {
      // The one shared pipeline (also used by the action dock's quick Photo button).
      await uploadJobPhotos(orgId, jobId, files);
      router.refresh();
    } catch (e: any) {
      setError(e?.message ?? "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    upload(Array.from(e.target.files ?? []));
    if (fileRef.current) fileRef.current.value = "";
    if (captureRef.current) captureRef.current.value = "";
  }

  function remove(d: Doc) {
    if (!confirm("Delete this photo?")) return;
    start(async () => {
      const res = await deleteDocument(d.id, d.file_url, jobId);
      if (!res?.ok) { toast(res?.error ?? "Couldn't delete photo — try again.", "error"); return; }
      toast("Photo deleted", "success");
      router.refresh();
    });
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input ref={fileRef} type="file" multiple accept="image/*" className="hidden" onChange={onFiles} />
        <input ref={captureRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFiles} />
        <Button onClick={() => (onPhone() ? captureRef.current?.click() : fileRef.current?.click())} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
          Take photo
        </Button>
        <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
          <Upload className="h-4 w-4" /> Upload
        </Button>
      </div>
      {error && <p className="mb-2 text-sm text-red-600">{error}</p>}

      {viewing?.signedUrl && (
        <MediaLightbox url={viewing.signedUrl} name={viewing.name} onClose={() => setViewing(null)} />
      )}

      {photos.length === 0 ? (
        <div className="py-10 text-center text-sm text-slate-400">
          <ImageOff className="mx-auto mb-2 h-8 w-8 text-slate-300" />
          No photos yet — snap progress shots, panel labels, or the finished work.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {photos.map((d) => (
            <div key={d.id} className="group relative aspect-square overflow-hidden rounded-lg bg-slate-100">
              <button onClick={() => setViewing(d)} className="h-full w-full">
                {d.signedUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={d.signedUrl} alt={d.name} className="h-full w-full object-cover" />
                )}
              </button>
              <button
                onClick={() => remove(d)}
                disabled={pending}
                className="absolute right-1 top-1 rounded-md bg-black/50 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
                title="Delete"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
