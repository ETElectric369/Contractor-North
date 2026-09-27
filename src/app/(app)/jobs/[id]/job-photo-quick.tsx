"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, Loader2 } from "lucide-react";
import { useToast } from "@/components/toast";
import { uploadJobPhotos } from "./upload-job-photos";
import { PhotoTaskSheet } from "./photo-task-sheet";

/**
 * The action dock's one-tap Photo capture: opens the camera (capture=environment)
 * straight from the job header — no need to open the Photos tab first. Files the
 * shot through the exact same pipeline as the tab (uploadJobPhotos), so a dock
 * photo and a tab photo are indistinguishable.
 *
 * MAKE IT A TASK (0358): one photo's toast offers it, so a picture of the thing that needs doing
 * becomes a task on the job's list right there (Erik: "a photo can become a task on the spot"). The
 * photo is filed either way; ignoring the toast is the photo as it always was. `taskDoor` is off on
 * a database without 0358, where a task can't hold a photo yet.
 */
export function JobPhotoQuick({
  orgId,
  jobId,
  className,
  taskDoor = false,
}: {
  orgId: string;
  jobId: string;
  className?: string;
  taskDoor?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<{ path: string; preview: string | null } | null>(null);

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (inputRef.current) inputRef.current.value = "";
    if (!files.length) return;
    setBusy(true);
    try {
      const paths = await uploadJobPhotos(orgId, jobId, files);
      if (taskDoor && files.length === 1 && paths[0]) {
        const path = paths[0];
        const file = files[0];
        toast("Photo added to the job", "success", {
          label: "Make It A Task",
          onClick: () => setSheet({ path, preview: URL.createObjectURL(file) }),
        });
      } else {
        toast(files.length > 1 ? "Photos added to the job" : "Photo added to the job", "success");
      }
      router.refresh();
    } catch (err: any) {
      toast(err?.message ?? "Photo upload failed — try again.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* NO `capture` ATTRIBUTE — that is the whole fix. Erik: "Photo button only for taking
          picture, can only upload from phone from sub menu." capture="environment" forces iOS
          straight into the camera with no way to reach the photo library; without it the OS asks
          "Camera / Photo Library / Choose File", which is BOTH verbs on the button he already
          taps. Desktop behaviour is unchanged (a file picker either way). */}
      <input ref={inputRef} type="file" accept="image/*" multiple className="hidden" onChange={onFiles} />
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
      {sheet && (
        <PhotoTaskSheet
          jobId={jobId}
          photoPath={sheet.path}
          previewUrl={sheet.preview}
          onClose={() => {
            if (sheet.preview) URL.revokeObjectURL(sheet.preview);
            setSheet(null);
          }}
        />
      )}
    </>
  );
}
