"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, FileText, Loader2, MoreHorizontal, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DropTarget } from "@/components/drop-target";
import { CameraCapture } from "@/components/camera-capture";
import { QuickCostButton } from "@/components/quick-cost-button";
import { ACTIONS_ROW_CLS } from "@/components/section-actions-menu";
import { GLASS_MENU_CLASS, useGlassMenuPlacement } from "@/components/ui/glass-menu";
import { captureReceipt, readReceiptDocument, type ReceiptTone } from "@/lib/receipt-capture";
import { linkReceiptToBill } from "@/app/(app)/jobs/actions";

/** Same test JobDocuments / JobPhotos use: a touch device gets the phone's own camera app
 *  through a capture input; a mouse gets the in-browser <CameraCapture>. */
function onPhone() {
  return (
    typeof navigator !== "undefined" &&
    (navigator.maxTouchPoints > 0 || /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent))
  );
}

type Tone = ReceiptTone | "busy";
/** `differentDoc`: a bill already carries this paper's number and nothing was written; the line
 *  offers Different Purchase: Record It Anyway for the paper filed as this document. `sameBillId`
 *  (d1ff7c5a): that bill is on THIS job, so the line also offers Same Purchase: It's That Bill,
 *  which ties the paper to it instead of reading it again or billing it twice. */
type Line = { id: number; name: string; text: string; tone: Tone; differentDoc?: string; sameBillId?: string };

/**
 * A PAPER THAT ISN'T A COST (a plan, a permit, anything else for the job's file): what it can be filed
 * as from the ⋯, and what its line says. It is filed on the job as that and the receipt reader is never
 * asked, so it is never a paid read, never a bill and never "Not On A Bill Yet".
 */
export const NOT_A_COST_PAPERS = [
  { category: "Plan", label: "Plan" },
  { category: "Permit", label: "Permit" },
  { category: "Other", label: "Other Paper" },
] as const;
export type NotACostCategory = (typeof NOT_A_COST_PAPERS)[number]["category"];
export const notACostSentence = (category: NotACostCategory) =>
  `Filed on the job as ${category === "Other" ? "a paper" : `a ${category}`}. It isn't a cost, so it wasn't read.`;

/**
 * ONE PAPER THROUGH THE DOOR: a cost is filed as a Receipt and read into its bill; a paper that isn't
 * a cost (`category`) is filed as what it is and the reader is never asked. The sentence is the
 * pipeline's own, except a non-cost paper's, which says what it was filed as.
 */
export async function capturePaper(o: { orgId: string; jobId: string; file: File; category?: NotACostCategory; nortOn: boolean }) {
  const { orgId, jobId, file, category, nortOn } = o;
  const out = await captureReceipt({ orgId, jobId, file, category, read: !category, nortOn });
  return { out, sentence: category && out.kind === "filed" ? notACostSentence(category) : out.sentence };
}

/** What the camera hint says when the door never opened: the two other ways in, by name. */
const CAMERA_HINT = "Camera didn't open? Tap ⋯ for Upload (your photos and PDFs) or Type It In, or allow the camera for North in your phone's Settings.";

/**
 * THE COSTS TAB'S HEADER: ONE WAY TO ADD A COST (W1-23). One primary "Snap The Bill" (the phone's
 * camera, one shot; the desktop capture modal) and beside it a 44px ⋯, "More Ways To Add A Cost":
 *
 *   Upload      the emailed-PDF / photo-library case, many at once (its own input, never the
 *               camera's: iOS drops `capture` the moment `multiple` is on);
 *   Type It In  the one typed cost sheet (QuickCostButton typeOnly), this job preselected;
 *   File A Paper (Not A Cost)
 *               a plan, a permit or another paper for the job's file: it asks which, then takes the
 *               same library input, files the paper as that and never runs the reader (review of
 *               W1-23: a plan sent through Upload was filed as a Receipt, read by the paid reader,
 *               told to "enter the cost manually" and counted as Not On A Bill Yet).
 *
 * A snapped or uploaded paper runs THE receipt pipeline (lib/receipt-capture): prep → upload → file
 * it on the job as a Receipt → billJobReceipt reads it and WRITES the itemized bill. Write-then-show:
 * one result line per paper, in the pipeline's own words when the reader didn't run, and the file
 * is FILED either way, so nothing captured is lost; Receipts & Papers below keeps Record As Cost for
 * a retry and the pencil to re-file a paper as what it is. The bills list refreshes
 * underneath (router.refresh), and its Edit / Delete are the undo trail.
 *
 * The job's cost total is not said here any more: what is OPEN leads the tab (Not Billed Yet), and
 * the money sits in the profit line at its foot. `billsTotal` is still taken, so the page's mount
 * stays as it is.
 */
export function JobCostCapture({ orgId, jobId, billsTotal: _billsTotal, nortOn = true }: { orgId: string; jobId: string; billsTotal: number; nortOn?: boolean }) {
  const router = useRouter();
  const captureRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [busy, setBusy] = useState(false);
  // THE CAMERA DOOR SPEAKS (the Add Cost sheet's rule, same day, same phone: Erik 2026-09-16,
  // "Add cost can't take photo"). When the OS refuses the capture input nothing in JS throws, so
  // Snap arms a short timer: no photo, no cancel, and the page never left the screen means the
  // door never opened, and this line says so and names the other two doors. A real camera covers
  // the page and the photo or the cancel clears it on return, so a slow camera is never a false alarm.
  const [cameraHint, setCameraHint] = useState<string | null>(null);
  const snapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapListeners = useRef<(() => void) | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  // THE QUEUE. A drop while a read was in flight used to hit `if (busy) return` — the files
  // vanished without a word, the one silence these result lines exist to prevent (Snap The Bill and
  // Upload are disabled mid-read, but the drop zone stays live for every drag). Now every file gets
  // its row the moment it arrives ("Waiting…") and ONE reader loop drains the queue in order:
  // nothing handed to this door is ever discarded. Refs, not state — the loop is async and must see
  // the queue as it is now, not as it was when a render captured it.
  // `category`: filed as that paper (a Plan, a Permit, Other) and never read; absent = a cost.
  const queue = useRef<{ id: number; file: File; name: string; category?: NotACostCategory }[]>([]);
  // What the library input's next pick is: a cost (null) or a paper that isn't one. Set by the ⋯ row
  // that opens the input, read once by onPick.
  const pickAs = useRef<NotACostCategory | null>(null);
  const running = useRef(false);
  const seq = useRef(0);

  // THE ⋯. A plain panel whose rows stay MOUNTED while it is shut (hidden, never removed), so the
  // Type It In sheet it opens is never unmounted mid-edit: the panel closes as the sheet opens.
  const [moreOpen, setMoreOpen] = useState(false);
  // File A Paper (Not A Cost)'s one question, asked inside the ⋯: which paper is it?
  const [askPaper, setAskPaper] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  // The question is its second view: it adds three rows to a panel already open, so the panel is
  // measured again (the shared hook's content key) and never hangs under the bottom dock.
  const { panelRef, panelStyle } = useGlassMenuPlacement(moreOpen, askPaper ? "which-paper" : "ways");
  useEffect(() => {
    if (!moreOpen) return;
    const away = (e: PointerEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMoreOpen(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [moreOpen]);

  // One line per file, newest on top, replaced in place as the file moves through the pipeline —
  // the person watches each bill land (or hears exactly why it didn't).
  const say = (id: number, name: string, text: string, tone: Tone, differentDoc?: string, sameBillId?: string) =>
    setLines((ls) => [
      { id, name, text, tone, ...(differentDoc ? { differentDoc } : {}), ...(differentDoc && sameBillId ? { sameBillId } : {}) },
      ...ls.filter((l) => l.id !== id),
    ]);

  /**
   * SAME PURCHASE: IT'S THAT BILL (d1ff7c5a). The reader found this paper's number on a bill of this
   * very job: it is that bill's own receipt, snapped again (or snapped after the bill was typed). The
   * tie is the fix, not another read and not a second bill. A refusal is said on the line.
   */
  async function tieIt(l: Line) {
    if (!l.differentDoc || !l.sameBillId || busy) return;
    setBusy(true);
    say(l.id, l.name, "Tying it to that bill…", "busy");
    try {
      const res = await linkReceiptToBill(l.sameBillId, l.differentDoc);
      if (!res.ok) {
        say(l.id, l.name, res.error ?? "The tie didn't save. Try again.", "fail", l.differentDoc, l.sameBillId);
        return;
      }
      say(l.id, l.name, "On that bill now. Nothing was recorded twice.", "ok");
      router.refresh();
    } catch (e) {
      say(l.id, l.name, `Couldn't tie it (${(e as Error)?.message ?? "unknown error"}). Try again.`, "fail", l.differentDoc, l.sameBillId);
    } finally {
      setBusy(false);
    }
  }

  /**
   * DIFFERENT PURCHASE, RIGHT HERE (review of audit v994's fix). The line said to press it, and
   * this door had no such button: the one under Receipts & Papers only appears after another
   * Record As Cost press, another paid read. A person looked and says it is a different purchase.
   */
  async function recordAnyway(l: Line) {
    if (!l.differentDoc || busy) return;
    setBusy(true);
    say(l.id, l.name, "Recording it as a different purchase…", "busy");
    try {
      const out = await readReceiptDocument(l.differentDoc, { differentPurchase: true }, nortOn);
      say(l.id, l.name, out.sentence, out.tone);
      router.refresh();
    } catch (e) {
      say(l.id, l.name, `Couldn't record it (${(e as Error)?.message ?? "unknown error"}). Try again.`, "fail", l.differentDoc);
    } finally {
      setBusy(false);
    }
  }

  function snapFiles(files: File[], category?: NotACostCategory) {
    if (!files.length) return;
    const items = files.map((file) => ({ id: ++seq.current, file, name: file.name || (category ?? "Receipt"), ...(category ? { category } : {}) }));
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
        const doing = p.category ? "Filing it…" : "Reading the receipt…";
        say(p.id, p.name, left ? `${doing} (${left} more waiting)` : doing, "busy");
        try {
          // A paper that isn't a cost is filed as what it is and the reader is never asked.
          const { out, sentence } = await capturePaper({ orgId, jobId, file: p.file, category: p.category, nortOn });
          // "lost" is the only outcome that left nothing on the job; every other one filed the paper.
          if (out.kind !== "lost") touched = true;
          // A same-number match: the paper filed as this document, and (when that bill is on this
          // job) the bill it may be, for the two doors under the line.
          const differentDoc = out.kind === "already" && out.samePurchase ? out.docId : undefined;
          const sameBillId = out.kind === "already" && out.samePurchase && out.sameOnThisJob ? out.sameBillId : undefined;
          say(p.id, p.name, sentence, out.tone, differentDoc, sameBillId);
        } catch (e) {
          // The pipeline answers in sentences; a throw is the network or a bug. Either way this
          // file's row says so and the loop goes on to the next — one bad file can't strand the
          // rest of the queue behind a spinner.
          say(p.id, p.name, `Couldn't ${p.category ? "file" : "read"} it (${(e as Error)?.message ?? "unknown error"}) — try again, or tap ⋯ and Type It In.`, "fail");
        }
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
    // The bills list below is server-rendered; the engine revalidated the route, this re-renders
    // it. Documents that only got filed refresh the same way.
    if (touched) router.refresh();
  }

  function clearSnapWatch() {
    if (snapTimer.current) {
      clearTimeout(snapTimer.current);
      snapTimer.current = null;
    }
    snapListeners.current?.();
    snapListeners.current = null;
    setCameraHint(null);
  }
  useEffect(() => () => clearSnapWatch(), []);

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    clearSnapWatch();
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    // The camera's input is always a cost; the library input is what the ⋯ row that opened it said.
    const as = e.target === fileRef.current ? pickAs.current : null;
    pickAs.current = null;
    snapFiles(files, as ?? undefined);
  }

  // Phones get the real camera app (capture="environment"); desktop gets the in-browser modal.
  function snap() {
    if (!onPhone()) return setShowCamera(true);
    const input = captureRef.current;
    if (!input) {
      // Not mounted (it always is): the library door rather than a dead tap.
      if (fileRef.current) return fileRef.current.click();
      return setCameraHint(CAMERA_HINT);
    }
    clearSnapWatch();
    const onCancel = () => clearSnapWatch();
    const onVisible = () => {
      if (document.visibilityState === "visible") clearSnapWatch();
    };
    input.addEventListener("cancel", onCancel);
    document.addEventListener("visibilitychange", onVisible);
    snapListeners.current = () => {
      input.removeEventListener("cancel", onCancel);
      document.removeEventListener("visibilitychange", onVisible);
    };
    input.click();
    snapTimer.current = setTimeout(() => {
      snapTimer.current = null;
      if (document.visibilityState !== "visible") return; // covered: the camera is most likely up
      snapListeners.current?.();
      snapListeners.current = null;
      setCameraHint(CAMERA_HINT);
    }, 2500);
  }

  function upload(as: NotACostCategory | null = null) {
    setMoreOpen(false);
    setAskPaper(false);
    setCameraHint(null);
    pickAs.current = as;
    if (fileRef.current) return fileRef.current.click();
    pickAs.current = null;
    setCameraHint("Couldn't open your files on this device. Try Snap The Bill, or tap ⋯ and Type It In.");
  }

  return (
    <Card>
      <div className="flex items-center gap-2 px-5 py-3">
        {/* NO `multiple` ON THE CAMERA INPUT. iOS ignores `capture` the moment `multiple` is
            present and opens the photo library instead, so with both set Snap The Bill never
            reached the camera on an iPhone. One shot per Snap; Upload's own input keeps
            `multiple` for the emailed-PDF and photo-library case, many at once. */}
        <input ref={captureRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onPick} />
        <input ref={fileRef} type="file" accept="image/*,application/pdf,.pdf" multiple className="hidden" onChange={onPick} />
        <DropTarget onFiles={snapFiles} accept="image/*,application/pdf,.pdf" label="Drop The Bills" className="min-w-0 flex-1">
          <Button type="button" onClick={snap} disabled={busy} className="w-full">
            {busy ? <Loader2 className="animate-spin" /> : <Camera />} {busy ? "Reading…" : "Snap The Bill"}
          </Button>
        </DropTarget>
        <div ref={moreRef} className="relative shrink-0">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => {
              setMoreOpen((o) => !o);
              setAskPaper(false);
            }}
            aria-label="More Ways To Add A Cost"
            title="More Ways To Add A Cost"
            aria-expanded={moreOpen}
          >
            <MoreHorizontal />
          </Button>
          <div ref={panelRef} hidden={!moreOpen} style={{ ...panelStyle, right: 0 }} className={`${GLASS_MENU_CLASS} w-56`}>
            <button type="button" onClick={() => upload()} disabled={busy} className={ACTIONS_ROW_CLS}>
              <Upload className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> Upload
            </button>
            <QuickCostButton typeOnly orgId={orgId} jobId={jobId} label="Type It In" icon="keyboard" className={ACTIONS_ROW_CLS} onOpen={() => setMoreOpen(false)} nortOn={nortOn} />
            <button type="button" onClick={() => setAskPaper((a) => !a)} disabled={busy} className={ACTIONS_ROW_CLS} aria-expanded={askPaper}>
              <FileText className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> File A Paper (Not A Cost)
            </button>
            {askPaper && (
              <div role="group" aria-label="What Is It?" className="border-t border-white/20 pl-6">
                {NOT_A_COST_PAPERS.map((k) => (
                  <button key={k.category} type="button" onClick={() => upload(k.category)} disabled={busy} className={ACTIONS_ROW_CLS}>
                    {k.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {cameraHint && <p className="border-t border-slate-100 px-5 py-2 text-sm text-amber-700">{cameraHint}</p>}

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
                {l.differentDoc && (
                  <span className="mt-1.5 flex flex-wrap items-center gap-2">
                    {l.sameBillId && (
                      <button
                        type="button"
                        onClick={() => tieIt(l)}
                        disabled={busy}
                        className="inline-flex min-h-11 items-center rounded-md border border-brand/30 bg-brand/5 px-3 text-xs font-medium text-brand hover:bg-brand/10 disabled:opacity-50"
                      >
                        Same Purchase: It&apos;s That Bill
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => recordAnyway(l)}
                      disabled={busy}
                      className="inline-flex min-h-11 items-center rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      Different Purchase: Record It Anyway
                    </button>
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
