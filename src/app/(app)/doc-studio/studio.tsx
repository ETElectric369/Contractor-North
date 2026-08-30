"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Redo2, RotateCcw, Undo2 } from "lucide-react";
import { InvoiceDocument } from "@/components/invoice-document";
import { QuoteDocument } from "@/components/quote-document";
import { SegmentedControl } from "@/components/ui/segmented";
import { Input, Label } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { useToast } from "@/components/toast";
import { updateOrgSettings, setDocTemplateFor } from "../settings/actions";
import { DEFAULT_DOC_STYLE, normalizeDocStyle, type DocStyle } from "@/lib/doc-style";
import {
  SAMPLE_CUSTOMER,
  SAMPLE_DESCRIPTION,
  SAMPLE_INVOICE_ITEMS,
  SAMPLE_QUOTE_ITEMS,
  SAMPLE_SITE,
  sampleTotals,
} from "./sample-data";

/**
 * THE DOCUMENT STUDIO, v2 — after Erik's first hands-on: "its clunky and limited... upgrade the
 * control buttons to a real toolbar."
 *
 * The canvas is the ACTUAL InvoiceDocument/QuoteDocument components — the same code every PDF
 * and customer link renders — fed realistic sample rows. What he drags is what Mark receives.
 *
 * The v2 feel fixes, each learned from v1 on his Mac:
 *   · DRAG SMOOTHNESS: pointermove updates are rAF-coalesced — at most one document re-render
 *     per frame instead of one per mouse event (the clunk was React re-rendering the whole page
 *     on every pixel).
 *   · QUIET HANDLES: v1 drew full-length bars across the page ("crop marks"); v2 shows compact
 *     grab pills, and the full dashed guide line appears only WHILE that handle is being dragged.
 *   · TRUE MEASURE: handles are positioned by measuring the rendered page — v2 re-measures on
 *     ResizeObserver and on the logo image loading, so a late layout shift can't strand a handle.
 *   · PRECISION: the toolbar's Layout group carries tiny number fields (margins in inches, gap in
 *     px) for exact values — drag for feel, type for precision ("microadjustments").
 * Autosave (debounced) + undo trail (⌘Z) — no save game.
 */

type DocKind = "invoice" | "quote";
type Template = "classic" | "modern" | "minimal";

interface Marks {
  page: { left: number; top: number; width: number; height: number };
  scale: number; // px per inch
  gutter: { x: number; top: number; height: number } | null;
  logo: { left: number; top: number; width: number; height: number } | null;
}

type HandleId = "mx-left" | "mx-right" | "my-top" | "gap";

const LOGO_LABEL = { s: "Small", m: "Medium", l: "Large" } as const;

export function DocStudio({
  co,
  initialStyle,
  initialTemplates,
  fallbackTemplate,
  terms,
  documentFooter,
}: {
  co: Record<string, unknown>;
  initialStyle: unknown;
  initialTemplates: Record<string, string>;
  fallbackTemplate: string;
  terms: { invoice: string; quote: string };
  documentFooter: string;
}) {
  const toast = useToast();
  const [style, setStyle] = useState<DocStyle>(() => normalizeDocStyle(initialStyle));
  const [docKind, setDocKind] = useState<DocKind>("invoice");
  const [templates, setTemplates] = useState<Record<string, string>>(initialTemplates);
  const [saved, setSaved] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [marks, setMarks] = useState<Marks | null>(null);
  const [dragging, setDragging] = useState<HandleId | null>(null);
  const [dragLabel, setDragLabel] = useState<string | null>(null);

  const undoRef = useRef<DocStyle[]>([]);
  const redoRef = useRef<DocStyle[]>([]);
  const styleRef = useRef(style);
  styleRef.current = style;

  // ── Autosave (debounced) — the page IS the form. ──
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueSave = useCallback(
    (next: DocStyle) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      setSaved("saving");
      saveTimer.current = setTimeout(async () => {
        const res = await updateOrgSettings({ doc_style: next as unknown as Record<string, unknown> });
        setSaved(res?.ok ? "saved" : "error");
        if (!res?.ok) toast(res?.error ?? "Couldn't save — your changes are still on screen. Try again.", "error");
      }, 600);
    },
    [toast],
  );

  const apply = useCallback(
    (next: DocStyle, opts?: { history?: boolean; save?: boolean }) => {
      const clean = normalizeDocStyle(next);
      if (opts?.history !== false) {
        undoRef.current = [...undoRef.current.slice(-49), styleRef.current];
        redoRef.current = [];
      }
      setStyle(clean);
      if (opts?.save !== false) queueSave(clean);
    },
    [queueSave],
  );

  // rAF-coalesced live updates for drags: at most one re-render per frame.
  const rafRef = useRef(0);
  const pendingRef = useRef<DocStyle | null>(null);
  const liveApply = useCallback((next: DocStyle) => {
    pendingRef.current = next;
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      if (pendingRef.current) setStyle(normalizeDocStyle(pendingRef.current));
    });
  }, []);

  const undo = useCallback(() => {
    const prev = undoRef.current.pop();
    if (!prev) return;
    redoRef.current.push(styleRef.current);
    setStyle(prev);
    queueSave(prev);
  }, [queueSave]);
  const redo = useCallback(() => {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(styleRef.current);
    setStyle(next);
    queueSave(next);
  }, [queueSave]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // ── Measure the rendered page so every handle sits exactly on what it moves. ──
  const wrapRef = useRef<HTMLDivElement>(null);
  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    const page = wrap?.querySelector<HTMLElement>(".print-page");
    if (!wrap || !page) return;
    const wr = wrap.getBoundingClientRect();
    const pr = page.getBoundingClientRect();
    const rel = (r: DOMRect) => ({ left: r.left - wr.left, top: r.top - wr.top, width: r.width, height: r.height });
    const table = page.querySelector<HTMLElement>("table");
    const th2 = table?.querySelector<HTMLElement>("thead th:nth-child(2)");
    const logoEl = page.querySelector<HTMLElement>("img") ?? page.querySelector<HTMLElement>("svg")?.parentElement ?? null;
    setMarks({
      page: rel(pr),
      scale: pr.width / 8.5,
      gutter:
        table && th2
          ? {
              x: rel(th2.getBoundingClientRect()).left,
              top: rel(table.getBoundingClientRect()).top,
              height: table.getBoundingClientRect().height,
            }
          : null,
      logo: logoEl ? rel(logoEl.getBoundingClientRect()) : null,
    });
  }, []);
  useLayoutEffect(() => {
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [measure, style, docKind, templates]);
  useEffect(() => {
    const wrap = wrapRef.current;
    window.addEventListener("resize", measure);
    // A late-loading logo shifts the header after first measure — remeasure on any load inside.
    wrap?.addEventListener("load", measure, true);
    const ro = new ResizeObserver(() => measure());
    const page = wrap?.querySelector<HTMLElement>(".print-page");
    if (page) ro.observe(page);
    return () => {
      window.removeEventListener("resize", measure);
      wrap?.removeEventListener("load", measure, true);
      ro.disconnect();
    };
  }, [measure, docKind]);

  // ── Drag machinery: live per-frame updates, ONE history entry per gesture. ──
  function startDrag(
    e: React.PointerEvent,
    id: HandleId,
    onMove: (dx: number, dy: number, start: DocStyle) => DocStyle,
    label: () => string,
  ) {
    e.preventDefault();
    const start = styleRef.current;
    const startX = e.clientX;
    const startY = e.clientY;
    setDragging(id);
    setDragLabel(label());
    const move = (ev: PointerEvent) => {
      liveApply(onMove(ev.clientX - startX, ev.clientY - startY, start));
      setDragLabel(label());
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragging(null);
      setDragLabel(null);
      undoRef.current = [...undoRef.current.slice(-49), start];
      redoRef.current = [];
      queueSave(styleRef.current);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  const scale = marks?.scale ?? 96;
  const template = (templates[docKind] || fallbackTemplate || "classic") as Template;

  function pickTemplate(t: Template) {
    setTemplates((m) => ({ ...m, [docKind]: t }));
    void setDocTemplateFor(docKind, t).then((res) => {
      if (!res?.ok) toast(res?.error ?? "Couldn't save the template.", "error");
    });
  }

  const invoiceTotals = sampleTotals(SAMPLE_INVOICE_ITEMS);
  const quoteTotals = sampleTotals(SAMPLE_QUOTE_ITEMS);

  /** Compact grab pill; its full guide line draws only while ITS handle is live. */
  const pill =
    "absolute z-20 flex items-center justify-center rounded-full border border-brand/40 bg-white text-brand shadow-sm transition-colors hover:border-brand hover:bg-brand hover:text-white";
  const guide = "pointer-events-none absolute z-10 border-brand/50";

  const toolGroup = "flex items-center gap-2";
  const toolLabel = "text-[10px] font-bold uppercase tracking-wider text-slate-400";

  return (
    <div className="space-y-3">
      {/* ── THE TOOLBAR — grouped, sticky, one row that wraps on narrow windows. ── */}
      <div className="sticky top-2 z-30 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-slate-200 bg-white/95 px-3 py-2 shadow-sm backdrop-blur">
        <div className={toolGroup}>
          <SegmentedControl
            activeId={docKind}
            onSelect={(id) => setDocKind(id as DocKind)}
            items={[
              { id: "invoice", label: "Invoice" },
              { id: "quote", label: "Estimate" },
            ]}
          />
        </div>
        <div className={toolGroup}>
          <span className={toolLabel}>Template</span>
          <SegmentedControl
            activeId={template}
            onSelect={(id) => pickTemplate(id as Template)}
            items={[
              { id: "classic", label: "Classic" },
              { id: "modern", label: "Modern" },
              { id: "minimal", label: "Minimal" },
            ]}
          />
        </div>
        <div className={toolGroup}>
          <span className={toolLabel}>Density</span>
          <SegmentedControl
            activeId={style.density}
            onSelect={(id) => apply({ ...style, density: id as DocStyle["density"] })}
            items={[
              { id: "compact", label: "Compact" },
              { id: "default", label: "Normal" },
              { id: "airy", label: "Airy" },
            ]}
          />
        </div>
        {/* Precision — drag for feel, type for exactness. */}
        <div className={toolGroup}>
          <span className={toolLabel}>Margins</span>
          <NumberInput
            value={style.margin_x}
            onValueChange={(v) => apply({ ...style, margin_x: v })}
            className="h-8 w-16 text-center text-xs"
            aria-label="Side margins, inches"
          />
          <NumberInput
            value={style.margin_y}
            onValueChange={(v) => apply({ ...style, margin_y: v })}
            className="h-8 w-16 text-center text-xs"
            aria-label="Top and bottom margins, inches"
          />
          <span className={toolLabel}>Gap</span>
          <NumberInput
            value={style.col_gap}
            onValueChange={(v) => apply({ ...style, col_gap: v })}
            className="h-8 w-14 text-center text-xs"
            aria-label="Column gap, pixels"
          />
        </div>
        <span className="ml-auto inline-flex items-center gap-1">
          <button type="button" onClick={undo} title="Undo (⌘Z)" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800">
            <Undo2 className="h-4 w-4" />
          </button>
          <button type="button" onClick={redo} title="Redo (⇧⌘Z)" className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800">
            <Redo2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => apply({ ...DEFAULT_DOC_STYLE })}
            title="Back to the standard layout"
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
          >
            <RotateCcw className="h-4 w-4" />
          </button>
          <span className="w-14 text-right text-xs font-medium">
            {saved === "saving" && <span className="text-slate-400">Saving…</span>}
            {saved === "saved" && <span className="text-emerald-600">Saved ✓</span>}
            {saved === "error" && <span className="text-red-600">Not saved</span>}
          </span>
        </span>
      </div>

      {/* Closing line + breakdown for the doc being viewed. */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2">
        <div className="min-w-64 flex-1">
          <Label htmlFor="studio-closing">{docKind === "invoice" ? "Invoice Closing Line" : "Estimate Closing Line"}</Label>
          <Input
            id="studio-closing"
            value={docKind === "invoice" ? style.closing_invoice : style.closing_quote}
            onChange={(e) =>
              apply(docKind === "invoice" ? { ...style, closing_invoice: e.target.value } : { ...style, closing_quote: e.target.value })
            }
            placeholder={docKind === "invoice" ? `Blank = "Please remit $… Thank you for your business."` : `Blank = "Thank you for the opportunity…"`}
          />
        </div>
        {docKind === "invoice" && (
          <label className="mb-2 flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={style.show_breakdown}
              onChange={(e) => apply({ ...style, show_breakdown: e.target.checked })}
              className="h-4 w-4 rounded border-slate-300"
            />
            Labor / Materials Box
          </label>
        )}
      </div>

      {/* ── The page itself ─────────────────────────────────────────────────── */}
      <div className="overflow-auto rounded-xl bg-slate-200/70 p-4 sm:p-8">
        <div ref={wrapRef} className="relative mx-auto w-fit max-w-full select-none pl-7 pt-7">
          {docKind === "invoice" ? (
            <InvoiceDocument
              co={co}
              template={template}
              number="INV-061"
              createdAt={"2026-08-29"}
              dueDate={"2026-09-28"}
              title="85 Whitney Place — main floor lighting"
              description={SAMPLE_DESCRIPTION}
              customer={SAMPLE_CUSTOMER}
              site={SAMPLE_SITE}
              items={SAMPLE_INVOICE_ITEMS}
              subtotal={invoiceTotals.subtotal}
              taxRate={0}
              tax={invoiceTotals.tax}
              total={invoiceTotals.total}
              amountPaid={0}
              terms={terms.invoice || undefined}
              documentFooter={documentFooter || undefined}
              docStyle={style}
            />
          ) : (
            <QuoteDocument
              co={co}
              template={template}
              docLabel="Estimate"
              number="E-030"
              createdAt={"2026-08-29"}
              validUntil={"2026-09-28"}
              title="85 Whitney Place — main floor lighting"
              description={SAMPLE_DESCRIPTION}
              customer={SAMPLE_CUSTOMER}
              site={SAMPLE_SITE}
              items={SAMPLE_QUOTE_ITEMS}
              subtotal={quoteTotals.subtotal}
              taxRate={0}
              tax={quoteTotals.tax}
              total={quoteTotals.total}
              terms={terms.quote || undefined}
              documentFooter={documentFooter || undefined}
              docStyle={style}
            />
          )}

          {marks && (
            <>
              {/* Guide lines — only while their handle is live. */}
              {dragging === "mx-left" && (
                <div className={`${guide} border-l border-dashed`} style={{ left: marks.page.left + style.margin_x * scale, top: marks.page.top, height: marks.page.height }} />
              )}
              {dragging === "mx-right" && (
                <div className={`${guide} border-l border-dashed`} style={{ left: marks.page.left + marks.page.width - style.margin_x * scale, top: marks.page.top, height: marks.page.height }} />
              )}
              {dragging === "my-top" && (
                <div className={`${guide} border-t border-dashed`} style={{ top: marks.page.top + style.margin_y * scale, left: marks.page.left, width: marks.page.width }} />
              )}
              {dragging === "gap" && marks.gutter && (
                <div className={`${guide} border-l border-dashed`} style={{ left: marks.gutter.x, top: marks.gutter.top, height: marks.gutter.height }} />
              )}

              {/* ── OLD-SCHOOL RULERS (Erik: "i always liked the rulers on the edges... with
                  draggable lines like old school"). Inch ticks along the page's real edges;
                  the brand tabs ON the rulers are the margin stops — drag them like Word's. ── */}
              <Ruler axis="x" page={marks.page} scale={scale} />
              <Ruler axis="y" page={marks.page} scale={scale} />
              {/* WHERE THE PAPER ENDS (Erik: "its not showing the page break"). On screen the
                  sheet scrolls as one long page, but print cuts it every 11 inches — each cut
                  gets the classic dashed line + a Page chip. (The real break can land a hair
                  earlier when a row refuses to split; the line marks the paper's edge.) */}
              {Array.from({ length: Math.max(0, Math.ceil(marks.page.height / (11 * scale)) - 1) }, (_, k) => (
                <div
                  key={`brk${k}`}
                  className="pointer-events-none absolute z-10 border-t-2 border-dashed border-slate-400/70"
                  style={{ top: marks.page.top + (k + 1) * 11 * scale, left: marks.page.left - 22, width: marks.page.width + 22 }}
                >
                  <span className="absolute -top-2.5 right-0 rounded bg-slate-500 px-1.5 py-0.5 text-[9px] font-semibold text-white">
                    Page {k + 2}
                  </span>
                </div>
              ))}
              {/* Margin stops: two mirrored tabs on the top ruler, one on the left ruler. */}
              <div
                className="absolute z-20 h-3 w-3 rotate-45 cursor-col-resize rounded-[3px] border border-brand bg-white shadow-sm hover:bg-brand"
                style={{ left: marks.page.left + style.margin_x * scale - 6, top: marks.page.top - 13, touchAction: "none" }}
                title={`Side Margins — ${style.margin_x}" (drag)`}
                onPointerDown={(e) =>
                  startDrag(e, "mx-left", (dx, _dy, start) => ({ ...start, margin_x: start.margin_x + dx / scale }), () => `${styleRef.current.margin_x.toFixed(2)}"`)
                }
              />
              <div
                className="absolute z-20 h-3 w-3 rotate-45 cursor-col-resize rounded-[3px] border border-brand bg-white shadow-sm hover:bg-brand"
                style={{ left: marks.page.left + marks.page.width - style.margin_x * scale - 6, top: marks.page.top - 13, touchAction: "none" }}
                title={`Side Margins — ${style.margin_x}" (drag)`}
                onPointerDown={(e) =>
                  startDrag(e, "mx-right", (dx, _dy, start) => ({ ...start, margin_x: start.margin_x - dx / scale }), () => `${styleRef.current.margin_x.toFixed(2)}"`)
                }
              />
              <div
                className="absolute z-20 h-3 w-3 rotate-45 cursor-row-resize rounded-[3px] border border-brand bg-white shadow-sm hover:bg-brand"
                style={{ left: marks.page.left - 13, top: marks.page.top + style.margin_y * scale - 6, touchAction: "none" }}
                title={`Top & Bottom Margins — ${style.margin_y}" (drag)`}
                onPointerDown={(e) =>
                  startDrag(e, "my-top", (_dx, dy, start) => ({ ...start, margin_y: start.margin_y + dy / scale }), () => `${styleRef.current.margin_y.toFixed(2)}"`)
                }
              />
              {/* Column-gap pill at the table's first numeric column. */}
              {marks.gutter && (
                <div
                  className={`${pill} h-8 w-3 cursor-col-resize`}
                  style={{ left: marks.gutter.x - 6, top: marks.gutter.top + 2, touchAction: "none" }}
                  title={`Column Spacing — ${style.col_gap}px (drag left for wider numbers, right for wider description)`}
                  onPointerDown={(e) =>
                    startDrag(e, "gap", (dx, _dy, start) => ({ ...start, col_gap: Math.round(start.col_gap - dx / 2) }), () => `${styleRef.current.col_gap}px`)
                  }
                />
              )}
              {/* Logo — click to cycle size. */}
              {marks.logo && (
                <button
                  type="button"
                  className="absolute z-20 rounded-md border-2 border-dashed border-transparent hover:border-brand/60"
                  style={{ left: marks.logo.left - 4, top: marks.logo.top - 4, width: marks.logo.width + 8, height: marks.logo.height + 8 }}
                  title={`Logo: ${LOGO_LABEL[style.logo_size]} — click to change`}
                  onClick={() => {
                    const order: DocStyle["logo_size"][] = ["s", "m", "l"];
                    const next = order[(order.indexOf(style.logo_size) + 1) % order.length];
                    apply({ ...style, logo_size: next });
                  }}
                />
              )}
              {dragLabel && (
                <div className="pointer-events-none absolute left-1/2 top-2 z-30 -translate-x-1/2 rounded-full bg-slate-900/90 px-3 py-1 font-mono text-xs text-white">
                  {dragLabel}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <p className="text-xs text-slate-400">
        Drag the tabs on the rulers to set margins; the pill at the number columns sets their spacing. Click the logo to resize it. Sample
        rows; your real documents restyle instantly.
      </p>
    </div>
  );
}

/** A classic edge ruler: inch ticks (quarters, halves, whole-inch numbers) laid along the page's
 *  measured edge. Purely visual — the draggable margin stops render on top of it. */
function Ruler({ axis, page, scale }: { axis: "x" | "y"; page: { left: number; top: number; width: number; height: number }; scale: number }) {
  const lengthIn = axis === "x" ? 8.5 : 11;
  const lengthPx = axis === "x" ? page.width : page.height;
  const ticks: React.ReactNode[] = [];
  for (let q = 0; q <= Math.floor(lengthIn * 4); q++) {
    const inch = q / 4;
    const pos = inch * scale;
    if (pos > lengthPx) break;
    const size = q % 4 === 0 ? 9 : q % 2 === 0 ? 6 : 4;
    ticks.push(
      <div
        key={q}
        className="absolute bg-slate-300"
        style={axis === "x" ? { left: pos, bottom: 0, width: 1, height: size } : { top: pos, right: 0, height: 1, width: size }}
      />,
    );
    if (q % 4 === 0 && inch > 0 && inch < lengthIn) {
      ticks.push(
        <span
          key={`n${q}`}
          className="absolute font-mono text-[8px] leading-none text-slate-400"
          style={axis === "x" ? { left: pos + 2, top: 1 } : { top: pos + 2, left: 2 }}
        >
          {inch}
        </span>,
      );
    }
  }
  return (
    <div
      className="absolute z-10 overflow-hidden rounded-sm border border-slate-200 bg-white"
      style={
        axis === "x"
          ? { left: page.left, top: page.top - 22, width: page.width, height: 18 }
          : { left: page.left - 22, top: page.top, width: 18, height: page.height }
      }
    >
      {ticks}
    </div>
  );
}
