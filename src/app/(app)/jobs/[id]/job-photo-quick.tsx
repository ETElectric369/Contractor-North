"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, Loader2 } from "lucide-react";
import { useToast } from "@/components/toast";
import { uploadJobPhotos } from "./upload-job-photos";

/**
 * The action dock's one-tap Photo capture: opens the camera (capture=environment)
 * straight from the job header — no need to open the Photos tab first. Files the
 * shot through the exact same pipeline as the tab (uploadJobPhotos), so a dock
 * photo and a tab photo are indistinguishable.
 */
export function JobPhotoQuick({
  orgId,
  jobId,
  className,
}: {
  orgId: string;
  jobId: string;
  className?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (inputRef.current) inputRef.current.value = "";
    if (!files.length) return;
    setBusy(true);
    try {
      await uploadJobPhotos(orgId, jobId, files);
      toast(files.length > 1 ? "Photos added to the job" : "Photo added to the job", "success");
      router.refresh();
    } catch (err: any) {
      toast(err?.message ?? "Photo upload failed — try again.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <input ref={inputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFiles} />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        title="Add photo"
        className={className}
      >
        {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : <Camera className="h-4 w-4 shrink-0" />}
        {/* Always visible — the dock's ICON_BTN renders it as a tiny caption under
            the icon on a phone (60mph glanceability), inline at sm+. */}
        <span>Photo</span>
      </button>
    </>
  );
}
