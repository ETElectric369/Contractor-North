"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Download, Loader2, Printer, RefreshCw } from "lucide-react";

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
  const [error, setError] = useState("");
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState("document.pdf");
  const pagesRef = useRef<HTMLDivElement>(null);
  const renderSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++renderSeq.current;
    setState("loading");
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
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        if (seq !== renderSeq.current) return;
        const base = page.getViewport({ scale: 1 });
        const scale = containerW / base.width;
        const vp = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.width = `${Math.floor(vp.width)}px`;
        canvas.style.height = `${Math.floor(vp.height)}px`;
        canvas.className = "mx-auto mb-6 block bg-white shadow-md";
        host.appendChild(canvas);
        const ctx = canvas.getContext("2d")!;
        ctx.scale(dpr, dpr);
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
      }
      setState("ready");
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

  function printPdf() {
    if (!blobUrl) return;
    // A hidden window/tab with the raw PDF → the OS print dialog prints the FILE,
    // not this page's canvases.
    const w = window.open(blobUrl, "_blank");
    w?.addEventListener("load", () => w.print());
  }

  return (
    <div className="flex h-screen flex-col bg-slate-200">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-300 bg-white px-4 py-2.5">
        <a href={back || "/"} className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900">
          <ArrowLeft className="h-4 w-4" /> Back
        </a>
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
            disabled={state !== "ready"}
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

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-6">
        {state === "loading" && (
          <div className="flex flex-col items-center gap-3 py-24 text-slate-500">
            <Loader2 className="h-8 w-8 animate-spin" />
            <p className="text-sm font-medium">Building your PDF…</p>
            <p className="text-xs text-slate-400">First one can take a few seconds.</p>
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
