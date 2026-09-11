"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, Camera, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { prepareImageForUpload } from "@/lib/image-prep";
import { updateJobNotes, addDocument } from "../actions";

/** The job's running notes. Staff edit them; a tech READS them (viewerIsStaff=false) —
 *  updateJobNotes is requireStaff and jobs_write is staff-only at the policy, so a
 *  textarea with a Save button was a control a tech could fill and be refused on. The
 *  text stays, the form goes. Take Photo stays for everyone: documents_write (0013) is
 *  any active member on purpose — techs snap the site from the truck. */
export function JobNotes({
  jobId,
  orgId,
  notes,
  viewerIsStaff = true,
}: {
  jobId: string;
  orgId?: string;
  notes: string | null;
  viewerIsStaff?: boolean;
}) {
  const router = useRouter();
  const [value, setValue] = useState(notes ?? "");
  const [done, setDone] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoMsg, setPhotoMsg] = useState<string | null>(null);
  const captureRef = useRef<HTMLInputElement>(null);

  function save() {
    setDone(false);
    setSaveErr(null);
    start(async () => {
      // Don't claim Saved on a failed write (audit v921 NOTHING-SILENT).
      const res = await updateJobNotes(jobId, value);
      if (!res?.ok) {
        setSaveErr(res?.error ?? "That didn't save - try again.");
        return;
      }
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
      // Point at a tab the viewer actually has: Costs is staff-only, so a tech is told
      // where HE will find it.
      setPhotoMsg(
        viewerIsStaff
          ? "Photo saved to this job (Costs → Receipts & documents)."
          : "Photo saved to this job — it's on the Photos tab.",
      );
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
      {viewerIsStaff ? (
        <Textarea
          rows={Math.min(30, Math.max(4, value.split("\n").length + 1))}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Running notes for this job — site details, access, customer preferences, follow-ups…"
        />
      ) : notes?.trim() ? (
        <p className="whitespace-pre-wrap text-sm text-slate-700">{notes}</p>
      ) : (
        // A sentence, not a form — nothing here invites typing.
        <p className="text-sm text-slate-400">No notes from the office yet.</p>
      )}
      {!viewerIsStaff && (
        <p className="mt-2 text-xs text-slate-500">
          The office writes these. Need materials? Add them on the{" "}
          <Link href={`/jobs/${jobId}?tab=materials`} className="font-medium text-brand hover:underline">
            Materials Tab
          </Link>
          .
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-3">
        {viewerIsStaff && (
          <Button size="sm" onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save Notes"}
          </Button>
        )}
        {orgId && (
          <>
            <Button size="sm" variant="outline" onClick={() => captureRef.current?.click()} disabled={photoBusy}>
              {photoBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
              Take Photo
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
        {saveErr && <span className="text-sm text-rose-600">{saveErr}</span>}
        {photoMsg && <span className="text-xs text-slate-500">{photoMsg}</span>}
      </div>
    </div>
  );
}
