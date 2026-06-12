"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Camera, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { prepareImageForUpload } from "@/lib/image-prep";
import { updateJobNotes, addDocument } from "../actions";

export function JobNotes({
  jobId,
  orgId,
  notes,
}: {
  jobId: string;
  orgId?: string;
  notes: string | null;
}) {
  const router = useRouter();
  const [value, setValue] = useState(notes ?? "");
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoMsg, setPhotoMsg] = useState<string | null>(null);
  const captureRef = useRef<HTMLInputElement>(null);

  function save() {
    setDone(false);
    start(async () => {
      await updateJobNotes(jobId, value);
      setDone(true);
      setTimeout(() => setDone(false), 2000);
    });
  }

  // Snap a photo right from the notes — files to the job's documents as a Photo.
  async function onPhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const raw = e.target.files?.[0];
    if (captureRef.current) captureRef.current.value = "";
    if (!raw || !orgId) return;
    setPhotoBusy(true);
    setPhotoMsg(null);
    try {
      const file = await prepareImageForUpload(raw);
      const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `${orgId}/${jobId}/${Date.now()}-${safe}`;
      const supabase = createClient();
      const { error: upErr } = await supabase.storage.from("documents").upload(path, file, { upsert: false });
      if (upErr) throw upErr;
      const res = await addDocument({
        job_id: jobId,
        name: file.name,
        category: "Photo",
        file_url: path,
        size_bytes: file.size,
      });
      if (!res.ok) throw new Error(res.error);
      setPhotoMsg("Photo saved to this job (Costs → Receipts & documents).");
      router.refresh();
    } catch (err: any) {
      setPhotoMsg(err?.message ?? "Photo upload failed.");
    } finally {
      setPhotoBusy(false);
      setTimeout(() => setPhotoMsg(null), 5000);
    }
  }

  return (
    <div>
      <Textarea
        rows={4}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Running notes for this job — site details, access, customer preferences, follow-ups…"
      />
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button size="sm" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save notes"}
        </Button>
        {orgId && (
          <>
            <Button size="sm" variant="outline" onClick={() => captureRef.current?.click()} disabled={photoBusy}>
              {photoBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
              Take photo
            </Button>
            <input
              ref={captureRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={onPhoto}
            />
          </>
        )}
        {done && (
          <span className="flex items-center gap-1 text-sm text-green-600">
            <Check className="h-4 w-4" /> Saved
          </span>
        )}
        {photoMsg && <span className="text-xs text-slate-500">{photoMsg}</span>}
      </div>
    </div>
  );
}
