"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, Printer, RefreshCw } from "lucide-react";
import { BackLink } from "@/components/back-link";

const MARGINS = [
  { v: 0.5, label: "Narrow · ½ in" },
  { v: 0.75, label: "Normal · ¾ in" },
  { v: 1, label: "Wide · 1 in" },
];

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
  const renderSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++renderSeq.current;
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
      const fn = /filename="([^"]+)"/.exec(cd)?.[1];
      const buf = await res.arrayBuffer();
      if (seq !== renderSeq.current) return; // a newer request superseded this one

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
      if (seq !== renderSeq.current) return;

      const host = pagesRef.current!;
      host.innerHTML = "";
      // Never measure the host itself — it's display:none while loading, so clientWidth
      // is 0 and every page rendered into a negative-width canvas (Erik's blank sheets).
      const containerW = Math.min(Math.max(window.innerWidth - 32, 280), 900);
      // These canvases ARE the print output, so resolution matters — but every page is
      // retained at once, and at 3x a letter page is ~24 MB of bitmap. A 12-page material
      // list blew past what an iOS PWA will hold and the tab reloaded mid-review. Budget
      // the TOTAL pixels instead: full quality for a short doc, stepping down (never below
      // 1.5x, which still prints cleanly) as the page count grows.
      const HIGH = Math.min(Math.max(window.devicePixelRatio || 1, 2.5), 3);
      const dpr = pdf.numPages <= 4 ? HIGH : pdf.numPages <= 10 ? 2 : 1.5;
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        if (seq !== renderSeq.current) return;
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
        if (n === 1) setState("ready");
      }
      setState("ready");
      setAllPainted(true);
    } catch (e: any) {
      if (seq !== renderSeq.current) return;
      setError(e?.message ?? "Couldn't build the PDF.");
      setState("error");
    }
  }, [doc, id, m]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  // Release the blob (and the retained page bitmaps) when the viewer goes away — a
  // multi-megabyte PDF held by an object URL survives navigation otherwise.
  const pagesHost = pagesRef;
  useEffect(() => {
    const host = pagesHost.current;
    return () => {
      setBlobUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return null;
      });
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

  // `back` arrives from the query string: only an in-app PATH may be followed. A value like
  // "//evil.tld" or "https://evil.tld" would turn our own Back button into an off-site
  // redirect wearing the app's URL — and this page is reached straight from a money document.
  const safeBack = back && /^\/(?!\/)/.test(back) ? back : "/";

  // GO BACK, don't push forward — via the house detector, not document.referrer (audit 7:
  // client-side navigation never sets referrer, so the cn-v730 heuristic was DEAD in the
  // installed PWA — the exact environment Erik reported the loop from). BackLinkTracker in the
  // root layout already tracks in-app navigation for every route including /print/*; BackLink
  // unwinds history when the arrival was in-app and falls back to the href on a cold open.
  return (
    <div className="pdf-preview-root flex h-screen flex-col bg-slate-200">
      <div className="no-print flex flex-wrap items-center justify-between gap-3 border-b border-slate-300 bg-white px-4 py-2.5">
        <BackLink
          fallback={safeBack}
          fallbackLabel="Back"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900"
        />
        <div className="flex items-center gap-2">
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

      <div className="pdf-pages-scroll min-h-0 flex-1 overflow-y-auto px-2 py-6">
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
      </div>
    </div>
  );
}
