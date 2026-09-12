"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropTarget } from "@/components/drop-target";
import { CameraCapture } from "@/components/camera-capture";
import { QuickCostButton } from "@/components/quick-cost-button";
import { captureReceipt, type ReceiptTone } from "@/lib/receipt-capture";
import { formatCurrency } from "@/lib/utils";

/** Same test JobDocuments / JobPhotos use: a touch device gets the phone's own camera app
 *  through a capture input; a mouse gets the in-browser <CameraCapture>. */
function onPhone() {
  return (
    typeof navigator !== "undefined" &&
    (navigator.maxTouchPoints > 0 || /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent))
  );
}

// The typed door, styled as the outline twin of the primary Snap the Bill (Button md/outline,
// px-3 so the three doors fit one line at 402px). QuickCostButton takes a className, not a
// variant, because its trigger is a plain <button> the dock used to skin.
const OUTLINE_BTN =
  "btn-gloss inline-flex h-11 items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-slate-300 bg-white px-3 text-sm font-medium text-slate-800 transition-colors hover:border-[rgb(var(--glass-ink))]/40 hover:bg-[rgb(var(--glass-tint))]/10 hover:text-[rgb(var(--glass-ink))] [&_svg]:size-4 [&_svg]:shrink-0";

type Tone = ReceiptTone | "busy";
type Line = { id: number; name: string; text: string; tone: Tone };

/**
 * THE COSTS TAB'S HEADER — the Add Cost door, camera first (Erik, 2026-09-11: "combine costs
 * with add cost on that upper button and get rid of it below… make it able to take a photo of
 * a bill… who's going to manually type it anymore once they've tried mr Nort processing
 * machine"). Left: the job's bills total. Right: [Snap the Bill] — the phone's camera (or the
 * desktop capture modal) — then THE receipt pipeline (lib/receipt-capture, the same one
 * JobDocuments and the Add Cost sheet run): prep the image → upload → file it on the job as a
 * Receipt → billJobReceipt reads it and WRITES the itemized bill. [Upload] takes the emailed-PDF
 * / photo-library case, many at once. [Add Cost] is the typed form for what has no paper.
 *
 * Write-then-show, not review-then-save: one result line per bill, in the pipeline's own words
 * when the reader didn't run (over its 8 MB cap, a .heic name, an unreadable total) — and the
 * file is FILED either way, so nothing captured is lost; Receipts & Documents below still has
 * "Record as Cost" for a retry. The Supplier bills list refreshes underneath (router.refresh),
 * and its Edit / Delete are the undo trail (no save game).
 */
export function JobCostCapture({ orgId, jobId, billsTotal }: { orgId: string; jobId: string; billsTotal: number }) {
  const router = useRouter();
  const captureRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  // THE QUEUE. A drop while a read was in flight used to hit `if (busy) return` — the files
  // vanished without a word, the one silence these result lines exist to prevent (the Snap and
  // Upload buttons are disabled mid-read, but the drop zone stays live for every drag). Now every
  // file gets its row the moment it arrives ("Waiting…") and ONE reader loop drains the queue in
  // order: nothing handed to this door is ever discarded. Refs, not state — the loop is async and
  // must see the queue as it is now, not as it was when a render captured it.
  const queue = useRef<{ id: number; file: File; name: string }[]>([]);
  const running = useRef(false);
  const seq = useRef(0);

  // One line per file, newest on top, replaced in place as the file moves through the pipeline —
  // the person watches each bill land (or hears exactly why it didn't).
  const say = (id: number, name: string, text: string, tone: Tone) =>
    setLines((ls) => [{ id, name, text, tone }, ...ls.filter((l) => l.id !== id)]);

  function snapFiles(files: File[]) {
    if (!files.length) return;
    const items = files.map((file) => ({ id: ++seq.current, file, name: file.name || "Receipt" }));
    queue.current.push(...items);
    if (running.current) {
      // Mid-read: each new file is announced as held, in place, so the person sees it landed
      // (reversed so the first dropped sits on top and stays there when its read begins).
      for (const p of [...items].reverse()) say(p.id, p.name, "Waiting — reads after the one in progress.", "busy");
      return;
    }
    void drain();
  }

  async function drain() {
    running.current = true;
    setBusy(true);
    let touched = false;
    try {
      for (let p = queue.current.shift(); p; p = queue.current.shift()) {
        const left = queue.current.length;
        say(p.id, p.name, left ? `Reading the receipt… (${left} more waiting)` : "Reading the receipt…", "busy");
        try {
          const out = await captureReceipt({ orgId, jobId, file: p.file, read: true });
          // "lost" is the only outcome that left nothing on the job; every other one filed the paper.
          if (out.kind !== "lost") touched = true;
          say(p.id, p.name, out.sentence, out.tone);
        } catch (e) {
          // The pipeline answers in sentences; a throw is the network or a bug. Either way this
          // file's row says so and the loop goes on to the next — one bad file can't strand the
          // rest of the queue behind a spinner.
          say(p.id, p.name, `Couldn't read it (${(e as Error)?.message ?? "unknown error"}) — try again, or type it in with Add Cost.`, "fail");
        }
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
    // The Supplier bills list below is server-rendered; the engine revalidated the route, this
    // re-renders it. Documents that only got filed refresh the same way.
    if (touched) router.refresh();
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    snapFiles(files);
  }

  // Phones get the real camera app (capture="environment"); desktop gets the in-browser modal.
  function snap() {
    if (onPhone()) captureRef.current?.click();
    else setShowCamera(true);
  }

  return (
    <Card className="overflow-hidden">
      {/* The Time tab's header grammar: the total on the left, the verbs on the right, and the
          row WRAPS so no control is ever a half-visible tap target at phone width. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-5 py-3 text-sm">
        <span className="font-semibold text-slate-900">Costs · {formatCurrency(billsTotal)}</span>
        <div className="flex flex-wrap items-center gap-2">
          <input ref={captureRef} type="file" accept="image/*" capture="environment" multiple className="hidden" onChange={onPick} />
          <input ref={fileRef} type="file" accept="image/*,application/pdf,.pdf" multiple className="hidden" onChange={onPick} />
          <DropTarget onFiles={snapFiles} accept="image/*,application/pdf,.pdf" label="Drop the Bills">
            <Button type="button" onClick={snap} disabled={busy} className="px-3">
              {busy ? <Loader2 className="animate-spin" /> : <Camera />} {busy ? "Reading…" : "Snap the Bill"}
            </Button>
          </DropTarget>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            title="Upload Bills (Photos or PDFs)"
            aria-label="Upload Bills"
          >
            <Upload />
          </Button>
          <QuickCostButton orgId={orgId} jobId={jobId} icon="dollar" label="Add Cost" className={OUTLINE_BTN} />
        </div>
      </div>

      {showCamera && (
        <CameraCapture
          onCapture={(file) => {
            setShowCamera(false);
            snapFiles([file]);
          }}
          onClose={() => setShowCamera(false)}
        />
      )}

      {lines.length > 0 && (
        <ul className="divide-y divide-slate-100 border-t border-slate-100">
          {lines.map((l) => (
            <li key={l.id} className="flex items-start gap-2 px-5 py-2 text-sm">
              {l.tone === "busy" && <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-slate-400" />}
              <span className="min-w-0">
                <span className="mr-1.5 font-medium text-slate-700">{l.name} ·</span>
                <span
                  className={
                    l.tone === "ok"
                      ? "text-emerald-700"
                      : l.tone === "warn"
                        ? "text-amber-700"
                        : l.tone === "fail"
                          ? "text-red-600"
                          : "text-slate-500"
                  }
                >
                  {l.text}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
