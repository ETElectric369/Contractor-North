"use client";

import { useMemo, useRef, useState } from "react";
import { AlertTriangle, Camera, FileText, ImageOff, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/toast";
import { cn, formatDate } from "@/lib/utils";
import { PHOTO_CAP_WORDS, PLAN_CAP_WORDS, panelFacts, type HeaderSaid } from "@/lib/panel/readers";
import type { JobCircuit, JobPanel } from "@/lib/types";
import { loadPanelPhotos, readPanelPhoto, readPlanCircuits, savePanel, type PanelPhoto } from "../panel-actions";
import { uploadJobPhotos } from "./upload-job-photos";

// The inspection's panel answer (brand, amps, condition) is read on the inspection itself since cn-v1141.

/**
 * READ A PHOTO (the panel-first wave; Erik: "hone it in"). ONE small card, right above the panel.
 *
 * One button. Read A Photo → take one, or pick one (the panel's own photo first, then the job's,
 * ONE at a time) → the read lands ON THE PANEL: dimmed lines in their spaces to Keep All or tap
 * each one, and where the photo's words differ from a kept line, the photo's words beside it with
 * Use It. The panel draws both; this card only reads. Under the button, one sentence of state.
 * What the photo said about the panel itself (brand, spaces, main, the No Stab spaces) is one line
 * with Use It, only when it differs from the panel. The office reads circuits from the plans from
 * the link at the bottom; a tech never sees it.
 *
 * Nothing silent: every refusal is the sentence under the button, and what a read couldn't read is
 * listed under it. The crew's cap is one sentence, said only when it is hit. 44px targets, 375px
 * wide, Title Case on every clickable.
 */

type Paper = { id: string; name: string | null; created_at: string };
type Status = { text: string; tone: "busy" | "done" | "error"; notes: string[] };

const card = "rounded-xl border border-slate-200 bg-white p-4 shadow-sm";
const select = "h-11 w-full min-w-0 rounded-lg border border-slate-300 bg-white px-2 text-sm";

/** The panel's own photo first, then the job's, newest first. */
export function photoOrder(photos: PanelPhoto[], panelPhotoId: string | null | undefined): PanelPhoto[] {
  const own = panelPhotoId ? photos.filter((p) => p.id === panelPhotoId) : [];
  const rest = photos.filter((p) => p.id !== panelPhotoId).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return [...own, ...rest];
}

export function PanelReaders({
  jobId,
  orgId,
  staff,
  photos: initialPhotos,
  plans,
  photoReadsLeft = null,
  planReadsLeft = null,
  panel,
  onRows,
  onPanel,
  onAdopted,
}: {
  jobId: string;
  orgId: string;
  staff: boolean;
  photos: PanelPhoto[];
  plans: (Paper & { onCustomer: boolean })[];
  photoReadsLeft?: number | null;
  planReadsLeft?: number | null;
  panel: JobPanel | null;
  onRows: (rows: JobCircuit[]) => void;
  onPanel: (row: JobPanel, placed?: { adopted: JobCircuit[]; notAdopted: string[] }) => void;
  /** The loose circuits a read moved onto the panel (they are drawn there already; the tab's rows
   *  learn their panel too). */
  onAdopted?: (ids: string[], panelId: string) => void;
}) {
  const toast = useToast();
  const [photos, setPhotos] = useState<PanelPhoto[]>(initialPhotos);
  const ordered = useMemo(() => photoOrder(photos, panel?.photo_document_id), [photos, panel?.photo_document_id]);
  const [picking, setPicking] = useState(false);
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState<null | "photo" | "use" | "plan">(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [said, setSaid] = useState<HeaderSaid | null>(null);
  const [left, setLeft] = useState<{ photo: number | null; plan: number | null }>({ photo: photoReadsLeft, plan: planReadsLeft });
  const [plansOpen, setPlansOpen] = useState(false);
  const [planId, setPlanId] = useState<string>(plans[0]?.id ?? "");
  const [planStatus, setPlanStatus] = useState<Status | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  // The crew's cap, hit: said once, under the button. The office isn't counted.
  const capped = !staff && left.photo === 0;
  // What the photo said about the panel, against the panel as it is now: once the panel says the
  // same (Use It, or a crewmate), the line goes away by itself.
  const facts = useMemo(() => panelFacts(panel, said), [panel, said]);

  /** Read A Photo: with no photo on the job yet, straight to the camera (or the library). */
  function start() {
    if (!ordered.length) {
      cameraRef.current?.click();
      return;
    }
    setAt(0);
    setPicking(true);
  }

  /** A photo taken (or picked from the phone) here is filed on the job's Photos the way the Photos
   *  tab files one (uploadJobPhotos), then read at once: it was taken to be read. */
  async function takePhoto(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (cameraRef.current) cameraRef.current.value = "";
    if (!files.length) return;
    setPicking(false);
    setBusy("photo");
    setStatus({ text: "Saving the photo to the job…", tone: "busy", notes: [] });
    let taken: PanelPhoto | null = null;
    try {
      const [path] = await uploadJobPhotos(orgId, jobId, files.slice(0, 1));
      const r = await loadPanelPhotos(jobId);
      if (!r.ok) {
        setStatus({ text: `The photo is on the job's Photos, but it couldn't be read from here: ${r.error}`, tone: "error", notes: [] });
        return;
      }
      setPhotos(r.photos);
      // THIS photo, by the path its upload filed it at: never the job's newest, which may be a
      // crewmate's taken in the same minute.
      taken = r.photos.find((p) => !!path && p.path === path) ?? null;
      if (!taken) {
        setStatus({ text: "The photo is on the job's Photos, but it isn't in the list yet. Tap Read A Photo and pick it.", tone: "error", notes: [] });
        return;
      }
    } catch (err) {
      setStatus({ text: err instanceof Error && err.message ? err.message : "The photo didn't upload. Try again.", tone: "error", notes: [] });
      return;
    } finally {
      setBusy(null);
    }
    if (taken) await read(taken.id);
  }

  async function read(documentId: string) {
    setPicking(false);
    setBusy("photo");
    setStatus({ text: "Reading the photo…", tone: "busy", notes: [] });
    try {
      const r = await readPanelPhoto(jobId, documentId, panel?.id ?? null);
      if (r.readsLeft !== undefined) setLeft((l) => ({ ...l, photo: r.readsLeft ?? null }));
      if (!r.ok) {
        // The cap's own sentence is already under the button once it is hit.
        setStatus(r.error === PHOTO_CAP_WORDS ? null : { text: r.error, tone: "error", notes: [] });
        return;
      }
      if (r.panel) onPanel(r.panel);
      if (r.adoptedIds?.length && r.adoptedOnto) onAdopted?.(r.adoptedIds, r.adoptedOnto);
      onRows(r.rows);
      setSaid(r.panelSays);
      setStatus({ text: r.message, tone: "done", notes: r.notes });
    } catch {
      setStatus({ text: "The read didn't finish. Check your connection and try again; nothing was added.", tone: "error", notes: [] });
    } finally {
      setBusy(null);
    }
  }

  /** Use It on "The photo says …": the panel takes those words, only where it still says what it
   *  said when the line was drawn (a crewmate's newer value is never overwritten). Undo puts back. */
  async function applyFacts() {
    if (!panel || !facts) return;
    const { patch, seen } = facts;
    setBusy("use");
    try {
      const r = await savePanel(jobId, panel.id, patch, seen);
      if (!r.ok) {
        toast(r.error, "error");
        if (r.current) onPanel(r.current);
        return;
      }
      onPanel(r.row);
      toast(`${r.row.name} now says what the photo says.`, "success", {
        label: "Undo",
        onClick: async () => {
          const u = await savePanel(jobId, panel.id, seen, patch);
          if (u.ok) onPanel(u.row);
          else toast(u.error, "error");
        },
      });
    } catch {
      toast("That didn't save. Check your connection and try again.", "error");
    } finally {
      setBusy(null);
    }
  }

  async function readPlans() {
    if (!planId) return;
    setBusy("plan");
    setPlanStatus({ text: "Reading the plans…", tone: "busy", notes: [] });
    try {
      const r = await readPlanCircuits(jobId, planId);
      if (r.readsLeft !== undefined) setLeft((l) => ({ ...l, plan: r.readsLeft ?? null }));
      if (!r.ok) {
        setPlanStatus(r.error === PLAN_CAP_WORDS ? null : { text: r.error, tone: "error", notes: [] });
        return;
      }
      onRows(r.rows);
      setPlanStatus({ text: r.message, tone: "done", notes: r.notes });
    } catch {
      setPlanStatus({ text: "The read didn't finish. Check your connection and try again; nothing was added.", tone: "error", notes: [] });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={card} aria-label="Read A Photo">
      {/* No `capture`: the phone asks Camera or Photo Library, the same as the dock's Photo button. */}
      <input ref={cameraRef} type="file" accept="image/*" className="hidden" onChange={(e) => void takePhoto(e)} />
      <Button className="w-full" onClick={start} disabled={busy !== null || capped}>
        {busy === "photo" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />} Read A Photo
      </Button>

      {picking && busy === null && ordered.length > 0 && (
        <PhotoPicker
          photos={ordered}
          at={at}
          panelPhotoId={panel?.photo_document_id ?? null}
          onNext={() => setAt((i) => (i + 1) % ordered.length)}
          onRead={(id) => void read(id)}
          onTake={() => cameraRef.current?.click()}
          onClose={() => setPicking(false)}
        />
      )}

      <StatusLine status={status} />
      {capped && <p className="mt-2 text-sm text-slate-600">{PHOTO_CAP_WORDS}</p>}

      {facts && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
          <p className="min-w-0 text-sm text-slate-700">{facts.words}</p>
          <Button variant="outline" className="shrink-0" onClick={() => void applyFacts()} disabled={busy !== null}>
            {busy === "use" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Use It
          </Button>
        </div>
      )}

      {/* READ CIRCUITS FROM THE PLANS: the office only (a tech's page never carries the plans). */}
      {staff && (
        <div className="mt-3 border-t border-slate-100 pt-1">
          <button
            type="button"
            onClick={() => setPlansOpen((v) => !v)}
            aria-expanded={plansOpen}
            className="flex min-h-[44px] w-full items-center gap-2 text-left text-sm font-medium text-[rgb(var(--glass-ink))]"
          >
            <FileText className="h-4 w-4 shrink-0" /> Read Circuits From The Plans
          </button>
          {plansOpen &&
            (plans.length === 0 ? (
              <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
                No plans on this job or its customer yet. Add them on the Customer Page tab, or with Upload Plans on the estimate.
              </p>
            ) : (
              <div className="space-y-2">
                <label className="block">
                  <span className="sr-only">Plans</span>
                  <select className={select} value={planId} onChange={(e) => setPlanId(e.target.value)} disabled={busy !== null}>
                    {plans.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name || "Plans"} · {formatDate(p.created_at)}
                        {p.onCustomer ? " · On The Customer" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <Button variant="outline" className="w-full" onClick={() => void readPlans()} disabled={busy !== null || !planId || left.plan === 0}>
                  {busy === "plan" ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Read These Plans
                </Button>
                {left.plan === 0 && <p className="text-sm text-slate-600">{PLAN_CAP_WORDS}</p>}
                <StatusLine status={planStatus} />
              </div>
            ))}
        </div>
      )}
    </section>
  );
}

/** ONE photo at a time, big enough to check before the tap: what is read is what is seen. */
export function PhotoPicker({
  photos,
  at,
  panelPhotoId,
  onNext,
  onRead,
  onTake,
  onClose,
}: {
  photos: PanelPhoto[];
  at: number;
  panelPhotoId: string | null;
  onNext: () => void;
  onRead: (documentId: string) => void;
  onTake: () => void;
  onClose: () => void;
}) {
  const i = Math.max(0, Math.min(at, photos.length - 1));
  const p = photos[i];
  if (!p) return null;
  return (
    <div className="mt-3 space-y-2">
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
        {p.url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.url} alt={p.name ?? "The photo"} className="h-56 w-full object-contain" />
        ) : (
          <div className="flex h-56 items-center justify-center text-slate-400">
            <ImageOff className="h-6 w-6" />
          </div>
        )}
        <div className="flex items-center justify-between gap-2 bg-white pl-3 text-xs text-slate-600">
          <span className="min-w-0 truncate">
            {p.id === panelPhotoId ? "The panel's photo · " : ""}
            {p.name || "Photo"} · {formatDate(p.created_at)}
            {photos.length > 1 ? ` · ${i + 1} of ${photos.length}` : ""}
          </span>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
      <Button className="w-full" onClick={() => onRead(p.id)}>
        Read This Photo
      </Button>
      <div className={cn("grid gap-2", photos.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
        {photos.length > 1 && (
          <Button variant="outline" onClick={onNext}>
            Next Photo
          </Button>
        )}
        <Button variant="outline" onClick={onTake}>
          <Camera className="h-4 w-4" /> Take A New One
        </Button>
      </div>
    </div>
  );
}

/** The one sentence of state, and what the read couldn't read under it. Always in the page, so a
 *  screen reader hears it change. */
function StatusLine({ status }: { status: Status | null }) {
  return (
    <div role="status" className={cn(status ? "mt-2" : "", "text-sm")}>
      {status && (
        <>
          <p className={cn("flex items-start gap-1.5", status.tone === "error" ? "text-red-700" : "text-slate-700")}>
            {status.tone === "busy" && <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin" />}
            <span className="min-w-0">{status.text}</span>
          </p>
          {status.notes.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {status.notes.map((n, k) => (
                <li key={k} className="flex items-start gap-1.5 text-xs font-medium text-amber-800">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {n}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
