"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Camera, Check, FileText, Loader2, Mic, MicOff, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label, Textarea } from "@/components/ui/input";
import { MediaLightbox } from "@/components/media-lightbox";
import { createClient } from "@/lib/supabase/client";
import { prepareImageForUpload } from "@/lib/image-prep";
import { saveAppointmentCapture } from "../actions";

export interface CapturePhoto {
  path: string; // storage path in the private documents bucket
  url: string | null; // signed URL for display (page-provided or client-signed)
}

type Field = "notes" | "measurements" | "materials";

const FIELDS: { key: Field; label: string; placeholder: string }[] = [
  {
    key: "notes",
    label: "Notes",
    placeholder: "Panel is a 100A Zinsco, attic access over the garage, homeowner wants the hot tub circuit…",
  },
  {
    key: "measurements",
    label: "Measurements",
    placeholder: "Run from panel to detached garage ≈ 85 ft, kitchen wall 14 ft, ceiling height 9 ft…",
  },
  {
    key: "materials",
    label: "Materials needed",
    placeholder: "200A panel, 2× 20A AFCI breakers, 250 ft 12/2 NM, weatherhead…",
  },
];

function onPhone() {
  return (
    typeof navigator !== "undefined" &&
    (navigator.maxTouchPoints > 0 || /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent))
  );
}

/**
 * The inspection field-capture form: three dictation-first text areas (the
 * answerer is standing in a crawlspace — same Web Speech pattern as the
 * timeclock debrief) + appointment-scoped photos. Photos upload straight into
 * the private documents bucket at <org>/appointments/<appt>/… and their PATHS
 * persist immediately via saveAppointmentCapture (a dead battery can't lose
 * them); text saves on Save / Start estimate. "Start estimate" saves, then
 * opens /quotes/new with this capture prefilled into the estimator scope.
 */
export function InspectionCapture({
  appointmentId,
  orgId,
  inquiryId,
  initial,
  initialPhotos,
}: {
  appointmentId: string;
  orgId: string;
  inquiryId: string | null;
  initial: Record<Field, string>;
  initialPhotos: CapturePhoto[];
}) {
  const router = useRouter();
  const [form, setForm] = useState<Record<Field, string>>(initial);
  const [photos, setPhotos] = useState<CapturePhoto[]>(initialPhotos);
  const [uploading, setUploading] = useState(false);
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<CapturePhoto | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<HTMLInputElement>(null);

  // Web Speech dictation — one recognizer, pointed at one field at a time
  // (the daily-report-debrief pattern).
  const [listening, setListening] = useState<Field | null>(null);
  const recogRef = useRef<any>(null);
  const speechSupported =
    typeof window !== "undefined" &&
    ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);

  function toggleDictation(field: Field) {
    if (listening) {
      // Detach onend BEFORE stopping — a late onend from the old recognizer would
      // otherwise clear the listening state of the one we're about to start.
      if (recogRef.current) recogRef.current.onend = null;
      recogRef.current?.stop();
      setListening(null);
      if (listening === field) return; // tapped the active mic — just stop
    }
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const r = new SR();
    r.continuous = true;
    r.interimResults = false;
    r.lang = "en-US";
    r.onresult = (e: any) => {
      let text = "";
      for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript;
      setForm((f) => ({ ...f, [field]: (f[field] ? f[field] + " " : "") + text.trim() }));
    };
    r.onend = () => setListening(null);
    r.start();
    recogRef.current = r;
    setListening(field);
  }

  async function persist(nextPhotos?: CapturePhoto[]): Promise<boolean> {
    const res = await saveAppointmentCapture(appointmentId, {
      notes: form.notes,
      measurements: form.measurements,
      materials: form.materials,
      photos: (nextPhotos ?? photos).map((p) => p.path),
    });
    if (!res.ok) {
      setError(res.error ?? "Could not save.");
      return false;
    }
    setError(null);
    return true;
  }

  async function upload(files: File[]) {
    if (!files.length) return;
    setUploading(true);
    setError(null);
    try {
      const supabase = createClient();
      const added: CapturePhoto[] = [];
      for (const raw of files) {
        const file = await prepareImageForUpload(raw);
        const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const path = `${orgId}/appointments/${appointmentId}/${Date.now()}-${safe}`;
        const { error: upErr } = await supabase.storage.from("documents").upload(path, file, { upsert: false });
        if (upErr) throw upErr;
        const { data } = await supabase.storage.from("documents").createSignedUrl(path, 3600);
        added.push({ path, url: data?.signedUrl ?? null });
      }
      const next = [...photos, ...added];
      setPhotos(next);
      // Persist the paths right away so a closed tab can't lose the shots.
      await persist(next);
    } catch (e: any) {
      setError(e?.message ?? "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    upload(Array.from(e.target.files ?? []));
    if (fileRef.current) fileRef.current.value = "";
    if (captureRef.current) captureRef.current.value = "";
  }

  function removePhoto(p: CapturePhoto) {
    if (!confirm("Remove this photo?")) return;
    start(async () => {
      const next = photos.filter((x) => x.path !== p.path);
      setPhotos(next);
      await persist(next);
      // Best-effort storage cleanup — the capture row no longer references it.
      void createClient().storage.from("documents").remove([p.path]);
    });
  }

  function save() {
    start(async () => {
      if (!(await persist())) return;
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      router.refresh();
    });
  }

  function startEstimate() {
    start(async () => {
      if (!(await persist())) return;
      const q = new URLSearchParams({ capture: appointmentId });
      if (inquiryId) q.set("inquiry", inquiryId);
      router.push(`/quotes/new?${q.toString()}`);
    });
  }

  const micButton = (field: Field) =>
    speechSupported ? (
      <button
        type="button"
        onClick={() => toggleDictation(field)}
        className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium ${
          listening === field ? "bg-red-50 text-red-600" : "bg-slate-100 text-slate-600 hover:bg-slate-200"
        }`}
      >
        {listening === field ? (
          <>
            <MicOff className="h-4 w-4 shrink-0" /> Stop
          </>
        ) : (
          <>
            <Mic className="h-4 w-4 shrink-0" /> Dictate
          </>
        )}
      </button>
    ) : null;

  return (
    <Card className="p-4 sm:p-5">
      <div className="space-y-4">
        {FIELDS.map((f) => (
          <div key={f.key}>
            <div className="mb-1.5 flex items-center justify-between">
              <Label className="mb-0" htmlFor={`cap-${f.key}`}>{f.label}</Label>
              {micButton(f.key)}
            </div>
            <Textarea
              id={`cap-${f.key}`}
              rows={3}
              placeholder={f.placeholder}
              value={form[f.key]}
              onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
            />
          </div>
        ))}

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <Label className="mb-0">Photos</Label>
            <div className="flex gap-2">
              <input ref={fileRef} type="file" multiple accept="image/*" className="hidden" onChange={onFiles} />
              <input ref={captureRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFiles} />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => (onPhone() ? captureRef.current?.click() : fileRef.current?.click())}
                disabled={uploading}
              >
                {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
                Take Photo
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={uploading}>
                <Upload className="h-4 w-4" /> Upload
              </Button>
            </div>
          </div>
          {photos.length === 0 ? (
            <p className="rounded-lg bg-slate-50 px-3 py-3 text-center text-xs text-slate-400">
              No photos yet — panel label, attic access, the run path.
            </p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
              {photos.map((p) => (
                <div key={p.path} className="group relative aspect-square overflow-hidden rounded-lg bg-slate-100">
                  <button type="button" onClick={() => p.url && setViewing(p)} className="h-full w-full">
                    {p.url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={p.url} alt="Inspection photo" className="h-full w-full object-cover" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => removePhoto(p)}
                    disabled={pending}
                    className="absolute right-1 top-1 rounded-md bg-black/50 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100"
                    title="Remove"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {viewing?.url && (
          <MediaLightbox url={viewing.url} name="Inspection photo" onClose={() => setViewing(null)} />
        )}

        {error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
          <Button type="button" variant="outline" onClick={save} disabled={pending || uploading}>
            {saved ? <Check className="h-4 w-4 text-green-600" /> : null}
            {saved ? "Saved" : pending ? "Saving…" : "Save"}
          </Button>
          <Button type="button" onClick={startEstimate} disabled={pending || uploading}>
            <FileText className="h-4 w-4" /> Start estimate
          </Button>
          <p className="w-full text-xs text-slate-400 sm:w-auto sm:flex-1">
            Start estimate carries these notes into the estimator scope.
          </p>
        </div>
      </div>
    </Card>
  );
}
