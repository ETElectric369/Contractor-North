"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { Download, Loader2, Printer, RefreshCw } from "lucide-react";
import { BackLink } from "@/components/back-link";
import { pdfPreviewBackHref } from "@/lib/pdf-preview-back";
import { pageWidthInside, worthRedrawing } from "@/lib/pdf-page-width";
import { renderTurns } from "@/lib/pdf-render-turns";
import { Turned } from "@/components/turned";

const MARGINS = [
  { v: 0.5, label: "Narrow · ½ in" },
  { v: 0.75, label: "Normal · ¾ in" },
  { v: 1, label: "Wide · 1 in" },
];

/**
 * WHICHEVER ELEMENT IS ACTUALLY SCROLLING THE SHEETS. Upright that is the box itself, as it always
 * was. Turned sideways the box becomes the frame and the quarter-turned face inside it is the
 * scroller (globals.css), so "keep his place across a repaint" has to read and write the scrollTop of
 * THAT one — written to the wrong element it is silently a no-op, and page 5 of an invoice becomes
 * page 1 every time the phone turns, which is the exact bug the place-keeping is there to prevent.
 */
function theScroller(box: HTMLElement | null): HTMLElement | null {
  if (!box) return null;
  return box.querySelector<HTMLElement>(":scope > .turn-face[data-held]") ?? box;
}

/**
 * The document PDF viewer. Renders the server-generated PDF page-by-page onto canvases
 * with PDF.js — NOT an <iframe>, because Safari's PWA shell simply refuses to display
 * PDFs in frames (Erik's blank grey screen). What's drawn here are the exact bytes of
 * the file Download saves and Print prints.
 */
export function PdfPreview({ doc, id, back }: { doc: string; id: string; back: string }) {
  const [m, setM] = useState(0.75);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  // Print stays disabled until EVERY page is on canvas (audit 7: enabling it at page 1 let a
  // fast tap print a money document with blank tail pages). Reset at the top of every load —
  // a stale true from the previous render re-opened the same window on each margin change.
  const [allPainted, setAllPainted] = useState(false);
  const [error, setError] = useState("");
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState("document.pdf");
  const pagesRef = useRef<HTMLDivElement>(null);
  // WHOSE TURN IT IS TO OWN THIS SCREEN. Fetching a new document and redrawing the one in hand are
  // two different jobs with two different rules, and one shared counter let them cancel each other:
  // a rotation mid-fetch dropped the margin he chose, silently, and an interrupted rotation left the
  // sheets drawn for the other orientation. lib/pdf-render-turns.ts carries both rules and their trace.
  const turns = useRef(renderTurns());
  // THE DOCUMENT IS KEPT so the pages can be DRAWN AGAIN at a new width without fetching it twice.
  // Turning the phone sideways more than doubles the room a page has (Erik, 2026-10-01: rotation
  // should work "like documents especially"), and these canvases are bitmaps — a page rasterized for
  // a 374pt-wide phone, stretched to 812, is the same small page blown up. The buffer can't be kept
  // instead: pdf.js may hand its ArrayBuffer to the worker and detach it.
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  /** Always rendered, zero height, never display:none — the one thing that can always be measured. */
  const measureRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  /**
   * How wide a page may be drawn right now. Measured from inside the scroller rather than from
   * window.innerWidth, because sideways the camera cutout takes ~59pt off EACH side (globals.css pads
   * this scroller past it) — a page sized from the window would have been drawn under the notch.
   * Clamped exactly as before: never under 280, never over 900, and the same 16px of breathing room
   * around the sheet so a portrait phone draws precisely what it drew before.
   */
  const roomForAPage = useCallback(() => {
    return pageWidthInside(measureRef.current?.clientWidth ?? window.innerWidth - 16);
  }, []);

  /**
   * DRAW THE PAGES at a given width. Split out of load() so turning the phone redraws from the
   * document already in hand instead of asking the server for the same bytes again — on cellular a
   * 6 MB plan set fetched on every rotation is the kind of thing that makes a man stop turning his
   * phone.
   *
   * A PAINT TURN cancels other paints and NOTHING ELSE. It must never cancel a load: the load is
   * fetching the margin he just tapped, and a turn of the phone that outranked it dropped that margin
   * on the floor with no spinner and no error (pdf-render-turns.ts).
   */
  const paint = useCallback(async (pdf: PDFDocumentProxy, containerW: number) => {
    const host = pagesRef.current;
    if (!host) return;
    // CLAIM THE WIDTH NOW, not when the last page lands — the list is emptied below, so from this
    // instant this is the width the screen shows whether or not this paint ever finishes. Recording it
    // at the end hid an interrupted rotation from the repaint guard, which then declined to redraw and
    // left a 796px sheet in a portrait window that only sideways panning could read.
    const seq = turns.current.startPaint(containerW);
    // Print goes back to disabled for the whole repaint (audit 7: enabling it at page 1 let a fast
    // tap print a money document with blank tail pages, and a repaint has exactly that gap again).
    setAllPainted(false);
    // KEEP HIS PLACE. Redrawing empties the list, so page 5 of an invoice would become page 1 every
    // time the phone turned. The sheets keep their aspect ratio, so the fraction scrolled is the
    // same place at any width.
    const scroller = theScroller(scrollRef.current);
    const was =
      scroller && scroller.scrollHeight > scroller.clientHeight
        ? scroller.scrollTop / scroller.scrollHeight
        : 0;
    try {
      host.innerHTML = "";
      // These canvases ARE the print output, so resolution matters — but every page is
      // retained at once, and at 3x a letter page is ~24 MB of bitmap. A 12-page material
      // list blew past what an iOS PWA will hold and the tab reloaded mid-review. Budget
      // the TOTAL pixels instead: full quality for a short doc, stepping down (never below
      // 1.5x, which still prints cleanly) as the page count grows.
      const HIGH = Math.min(Math.max(window.devicePixelRatio || 1, 2.5), 3);
      const dpr = pdf.numPages <= 4 ? HIGH : pdf.numPages <= 10 ? 2 : 1.5;
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        if (!turns.current.paintOwns(seq)) return;
        const base = page.getViewport({ scale: 1 });
        const scale = containerW / base.width;
        const vp = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        // Derive height from the FLOORED width so the printed aspect ratio matches the PDF
        // exactly. Flooring both independently made the canvas a hair taller than 11in,
        // which chromium then pushed onto a second sheet — a blank sliver after every page.
        const cssW = Math.floor(vp.width);
        const cssH = Math.round((cssW * base.height) / base.width);
        canvas.width = Math.floor(cssW * dpr);
        canvas.height = Math.round((canvas.width * base.height) / base.width);
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
        canvas.className = "pdf-page-canvas mx-auto mb-6 block bg-white shadow-md";
        host.appendChild(canvas);
        const ctx = canvas.getContext("2d")!;
        ctx.scale(dpr, dpr);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        // SHOW PAGE 1 THE MOMENT IT EXISTS. Waiting for every canvas made a 6-page doc feel
        // as slow as its last page; the rest keep painting into the already-visible list.
        // Only if this paint still owns the list: page one is rasterized BEFORE the next trip
        // round the loop checks, so a margin change landing in that window had the old document's
        // first sheet declare itself "ready" over the new one's "Opening…".
        if (n === 1 && turns.current.paintOwns(seq)) setState("ready");
      }
      // A margin change or a newer rotation mid-paint owns the screen now, and a superseded paint
      // finishing late must not claim the width back either.
      if (!turns.current.finishedPaint(seq, containerW)) return;
      setState("ready");
      setAllPainted(true);
      if (scroller && was > 0) scroller.scrollTop = was * scroller.scrollHeight;
    } catch (e: any) {
      // A page that won't rasterize is its own failure, not the fetch's — this used to be caught by
      // load()'s handler, which can no longer see it.
      if (!turns.current.paintOwns(seq)) return;
      setError(e?.message ?? "Couldn't draw the pages.");
      setState("error");
    }
  }, []);

  const load = useCallback(async () => {
    // A LOAD TURN outranks everything: the document on screen is about to be replaced, so a repaint of
    // it is cancelled too — and until this one has the bytes in hand, nothing else may repaint at all.
    const seq = turns.current.startLoad();
    setState("loading");
    setAllPainted(false);
    setError("");
    try {
      const res = await fetch(`/api/pdf/${doc}/${id}?m=${m}`, { credentials: "same-origin" });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error ?? `Couldn't build the PDF (${res.status}).`);
      }
      const cd = res.headers.get("content-disposition") ?? "";
      // The UTF-8 name first (RFC 5987, lib/content-disposition), the ASCII fallback second.
      const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(cd)?.[1];
      let fn = /filename="([^"]+)"/.exec(cd)?.[1];
      try {
        if (utf8) fn = decodeURIComponent(utf8);
      } catch {
        /* a malformed escape keeps the ASCII name */
      }
      const buf = await res.arrayBuffer();
      if (!turns.current.loadOwns(seq)) return; // a newer request superseded this one

      // Keep the raw bytes for Download/Print — the preview and the file can't diverge.
      const url = URL.createObjectURL(new Blob([buf], { type: "application/pdf" }));
      setBlobUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return url;
      });
      if (fn) setFilename(fn);

      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url,
      ).toString();
      const pdf = await pdfjs.getDocument({ data: buf }).promise;
      if (!turns.current.loadOwns(seq)) {
        void pdf.destroy();
        return;
      }
      // Adopt this document and let the previous one go — a margin change loads a second copy, and a
      // parsed PDF held for nothing is the same leak the blob above is revoked for.
      const previous = pdfRef.current;
      pdfRef.current = pdf;
      if (previous) void previous.destroy();
      // THE FETCH IS DONE, so rotations may repaint again — and the width below is measured right now,
      // which is why a turn of the phone during the fetch needed no repaint of its own.
      turns.current.settled(seq);
      await paint(pdf, roomForAPage());
    } catch (e: any) {
      if (!turns.current.loadOwns(seq)) return;
      turns.current.settled(seq);
      setError(e?.message ?? "Couldn't build the PDF.");
      setState("error");
    }
  }, [doc, id, m, paint, roomForAPage]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // ── DRAW THEM AGAIN WHEN THE ROOM CHANGES ──────────────────────────────────────────────────────
  // Turning the phone is the whole point, and a bitmap does not re-flow. WIDTH ONLY: the keyboard and
  // a browser's own chrome change the HEIGHT, and nothing about a page's size depends on that, so
  // reading a document is never interrupted by a repaint it didn't need. A rotation fires `resize` on
  // iOS; `orientationchange` is the belt for the browsers that only fire that one.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const maybeRepaint = () => {
      clearTimeout(t);
      // Late enough that iOS has settled on the new size — asked mid-rotation it reports the old one.
      t = setTimeout(() => {
        const pdf = pdfRef.current;
        // DEFER, DON'T FIGHT. While a fetch is in flight, pdfRef still holds the document being
        // replaced — repainting it here outranked the fetch and the margin he tapped never landed.
        // Nothing is lost by waiting: load() ends in paint(pdf, roomForAPage()), which measures the
        // room at that moment, so the new orientation is drawn anyway.
        if (!pdf || turns.current.isLoading()) return;
        const want = roomForAPage();
        if (!worthRedrawing(want, turns.current.drawnAtW())) return;
        void paint(pdf, want);
      }, 180);
    };
    window.addEventListener("resize", maybeRepaint);
    window.addEventListener("orientationchange", maybeRepaint);
    // AND THE ONE THAT ACTUALLY FIRES IN THE APP NOW. The shell is portrait-locked, so when the phone
    // is turned the WINDOW never changes shape — neither `resize` nor `orientationchange` happens, and
    // without this a document would stay drawn at the portrait width inside a box twice as wide, which
    // is strictly worse than not turning at all. components/turns-sideways.tsx fires it the moment the
    // turn is decided; the two above stay for a browser, where the window really does change.
    window.addEventListener("cn:screen-turned", maybeRepaint);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", maybeRepaint);
      window.removeEventListener("orientationchange", maybeRepaint);
      window.removeEventListener("cn:screen-turned", maybeRepaint);
    };
  }, [paint, roomForAPage]);

  // Release the blob (and the retained page bitmaps) when the viewer goes away — a
  // multi-megabyte PDF held by an object URL survives navigation otherwise.
  const pagesHost = pagesRef;
  const turnsOnLeaving = turns.current;
  useEffect(() => {
    const host = pagesHost.current;
    return () => {
      // Abort any in-flight fetch/paint loop (audit 7): tapping Back mid-load still rasterized
      // every page into detached canvases and leaked the multi-MB blob on the page you fled to.
      turnsOnLeaving.abandonAll();
      setBlobUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
      // The parsed document is kept across rotations now, so leaving has to let go of it too —
      // destroy() also shuts down its pdf.js worker.
      const pdf = pdfRef.current;
      pdfRef.current = null;
      if (pdf) void pdf.destroy();
      if (host) host.innerHTML = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function printPdf() {
    // Print THIS window's rendered pages (print CSS lays them one per sheet, and the
    // canvases already contain the margins baked into the PDF). window.open() is a trap
    // in the installed app: the popup belongs to Safari — a different application — so
    // the print dialog appeared BEHIND the app window (Erik 7/24).
    window.print();
  }

  // `back` arrives from the query string: only an in-app PATH may be followed (the guard lives in
  // pdfPreviewBackHref). Without one, Back goes to the document's own page, never to "/".
  const safeBack = pdfPreviewBackHref(doc, id, back);

  // GO BACK, don't push forward — via the house detector, not document.referrer (audit 7:
  // client-side navigation never sets referrer, so the cn-v730 heuristic was DEAD in the
  // installed PWA — the exact environment Erik reported the loop from). BackLinkTracker in the
  // root layout already tracks in-app navigation for every route including /print/*; BackLink
  // unwinds history when the arrival was in-app and falls back to the href on a cold open.
  //
  // THE TOOLBAR CLEARS THE STATUS BAR (be3dca81). /print sits outside the app shell, so when the
  // iOS shell went full-bleed (cn-v917) this toolbar was left starting at y=0, and Back, the only
  // way off this page (no dock, no topbar, no swipe-back in the shell), was drawn under the clock
  // where a tap can't reach it. Erik had to kill the app. --sat is 0 in a browser and the PWA, so
  // only the shell moves. Back is a full 44px target, and the controls on the right wrap onto
  // their own row at phone width instead of running off the edge.
  return (
    <div className="pdf-preview-root flex h-screen flex-col bg-slate-200">
      {/* `pdf-preview-bar`: the same bar, sideways too. A phone held sideways puts the camera cutout
          on the SIDE — iOS reports ~59pt of inset on both — and this page paints edge to edge with no
          app shell around it, so globals.css pads Back and the Download button clear of it. Nothing
          moves otherwise, nothing is dropped, every control stays 44px. */}
      <div className="pdf-preview-bar no-print flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-slate-300 bg-white px-4 pb-2.5 pt-[max(0.625rem,var(--sat,0px))]">
        <BackLink
          fallback={safeBack}
          fallbackLabel="Back"
          className="-ml-2 inline-flex min-h-11 min-w-11 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-slate-600 hover:text-slate-900"
        />
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="pdf-margin" className="text-xs font-medium text-slate-500">Margins</label>
          <select
            id="pdf-margin"
            value={m}
            onChange={(e) => setM(Number(e.target.value))}
            disabled={state === "loading"}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm disabled:opacity-50"
          >
            {MARGINS.map((o) => (
              <option key={o.v} value={o.v}>{o.label}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={printPdf}
            disabled={state !== "ready" || !allPainted}
            title={state === "ready" && !allPainted ? "Preparing pages…" : undefined}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 disabled:opacity-50"
          >
            <Printer className="h-4 w-4" /> Print
          </button>
          <a
            href={blobUrl ?? "#"}
            download={filename}
            aria-disabled={state !== "ready"}
            className={`inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-1.5 text-sm font-semibold text-white ${state !== "ready" ? "pointer-events-none opacity-50" : ""}`}
          >
            <Download className="h-4 w-4" /> Download PDF
          </a>
        </div>
      </div>

      {/* `turn-host`: the bar above stays exactly where it is — the phone's top edge — and THIS is the
          rectangle the page turns inside when the phone is held sideways (Erik, 2026-10-01). Upright,
          <Turned> has no box at all and this is the same scroller it has always been. */}
      <div ref={scrollRef} className="pdf-pages-scroll turn-host min-h-0 flex-1 overflow-y-auto px-2 py-6">
       <Turned>
        {/* THE ONE THING THAT CAN ALWAYS BE MEASURED. The pages host below is display:none while
            loading (clientWidth 0 → a page drawn into a negative-width canvas: Erik's blank sheets),
            and window.innerWidth doesn't know about the camera inset this scroller is padded for. This
            sits inside the padding, draws nothing, and is exactly the room a page has — including when
            that room is the turned box, which is twice as wide. */}
        <div ref={measureRef} aria-hidden="true" className="h-0" />
        {state === "loading" && (
          <div className="flex flex-col items-center gap-3 py-24 text-slate-500">
            <Loader2 className="h-8 w-8 animate-spin" />
            {/* HONEST THEATER (Erik: "pdf still seems to be regenerating every time" — the log
                said HIT, 0.9s; this screen said "Building… takes a few seconds" either way, so a
                stored copy LOOKED like a rebuild). Neutral line first; the slow-warning only
                appears once it's actually being slow. */}
            <p className="text-sm font-medium">Opening…</p>
            <p className="pdf-slow-note text-xs text-slate-400">Rebuilding this one — a few seconds.</p>
          </div>
        )}
        {state === "error" && (
          <div className="mx-auto max-w-md rounded-xl border border-red-200 bg-red-50 p-6 text-center">
            <p className="text-sm font-medium text-red-700">{error}</p>
            <button type="button" onClick={load} className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700">
              <RefreshCw className="h-4 w-4" /> Try again
            </button>
          </div>
        )}
        <div ref={pagesRef} className={state === "ready" ? "" : "hidden"} />
       </Turned>
      </div>
    </div>
  );
}
