"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { DropTarget } from "@/components/drop-target";
import { useRouter } from "next/navigation";
import { Camera, Upload, Trash2, Loader2, ImageOff, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MediaLightbox } from "@/components/media-lightbox";
import { useToast } from "@/components/toast";
import { deleteDocument } from "../actions";
import { uploadJobPhotos } from "./upload-job-photos";
import { setPhotoShared } from "../portal-share-actions";
import { PHOTO_NOT_IN_JOB_FOLDER } from "@/lib/portal/share-input";
import { isJobPhotoPath } from "@/lib/portal/job-view-shape";

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

/** Photos tab: every job photo as a tappable thumbnail grid.
 *
 *  SHOW CUSTOMER (office only; `sharedIds` is null for a tech, or before 0300): under each PHOTO
 *  a switch puts it on the customer's job page, live. Only a document filed as a Photo gets one: a
 *  receipt is an image in the same folder, and the database refuses to share it by name. The
 *  portal picks photos by this switch's row, never by the folder. A Photo filed outside this job's
 *  own folder (Organize files papers under <org>/organize/) can't reach the customer's page, so its
 *  switch says so when pressed instead of pretending to share it. */
export function JobPhotos({
  orgId,
  jobId,
  docs,
  sharedIds = null,
}: {
  orgId: string;
  jobId: string;
  docs: Doc[];
  sharedIds?: string[] | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const photos = docs.filter(isImage);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [viewing, setViewing] = useState<Doc | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState<Set<string>>(() => new Set(sharedIds ?? []));
  const [sharing, setSharing] = useState<string | null>(null);
  // A server refresh (another tab, Undo) brings the database's list: take it.
  const sharedKey = (sharedIds ?? []).join(",");
  useEffect(() => {
    setShown(new Set(sharedKey ? sharedKey.split(",") : []));
  }, [sharedKey]);

  async function share(d: Doc, next: boolean, undoable = true) {
    if (next && !isJobPhotoPath(d.file_url, orgId, jobId)) {
      toast(PHOTO_NOT_IN_JOB_FOLDER, "error");
      return;
    }
    setSharing(d.id);
    setShown((s) => {
      const n = new Set(s);
      if (next) n.add(d.id);
      else n.delete(d.id);
      return n;
    });
    const res = await setPhotoShared(d.id, next);
    setSharing(null);
    if (!res.ok) {
      setShown((s) => {
        const n = new Set(s);
        if (next) n.delete(d.id);
        else n.add(d.id);
        return n;
      });
      toast(res.error ?? "That didn't take. Try again.", "error");
      return;
    }
    const msg = next ? "Shown on the customer's page." : "Taken off the customer's page.";
    if (undoable) toast(msg, "success", { label: "Undo", onClick: () => void share(d, !next, false) });
    else toast(msg, "success");
  }
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
          Take Photo
        </Button>
        <DropTarget onFiles={(files) => void upload(files)} accept="image/*" label="Drop Photos">
          <Button variant="outline" onClick={() => fileRef.current?.click()} disabled={busy}>
            <Upload className="h-4 w-4" /> Upload
          </Button>
        </DropTarget>
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
              {sharedIds && d.category === "Photo" ? (
                // The position lives on a wrapper: .seaglass-btn is unlayered CSS and sets
                // position: relative, which beats Tailwind's layered `absolute` on the same element.
                // The ON state is .seaglass-btn (it carries the white glass base as its last layer),
                // so the dark ink stays readable over a dark or busy photo.
                <div className="absolute inset-x-1 bottom-1">
                  <button
                    type="button"
                    onClick={() => void share(d, !shown.has(d.id))}
                    disabled={sharing === d.id}
                    aria-pressed={shown.has(d.id)}
                    title={shown.has(d.id) ? "The customer sees this photo. Tap to take it off their page." : "Show this photo on the customer's page"}
                    className={`inline-flex h-11 w-full items-center justify-center gap-1.5 rounded-lg px-2 text-xs font-semibold shadow-sm ${
                      shown.has(d.id) ? "seaglass-btn" : "bg-black/55 text-white backdrop-blur"
                    }`}
                  >
                    <span className="relative z-10 inline-flex items-center gap-1.5">
                      {sharing === d.id ? <Loader2 className="h-4 w-4 animate-spin" /> : shown.has(d.id) ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                      {shown.has(d.id) ? "Customer Sees It" : "Show Customer"}
                    </span>
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
