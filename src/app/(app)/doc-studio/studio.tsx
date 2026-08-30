"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Redo2, RotateCcw, Undo2 } from "lucide-react";
import { InvoiceDocument } from "@/components/invoice-document";
import { QuoteDocument } from "@/components/quote-document";
import { SegmentedControl } from "@/components/ui/segmented";
import { Input, Label } from "@/components/ui/input";
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
 * THE DOCUMENT STUDIO — a real page, grabbed with real hands.
 *
 * Erik, after the knobs card: "its a nightmare without a preview or an actual rendering of the
 * rows and columns getting moved and the back and forth is exactly what ive been fighting for
 * years... see what you can wow me with." So the canvas below is not a mockup — it is the ACTUAL
 * InvoiceDocument/QuoteDocument components, the same code every PDF and customer link renders,
 * fed realistic sample rows. What he drags here is what Mark receives.
 *
 * Direct manipulation, design-studio spirit:
 *   · drag the page's edge bars → margins (inches, live)
 *   · drag the bar at the number columns → column gap (px, live — the description breathes)
 *   · click the logo → cycle its size
 *   · templates/density/closing lines in the toolbar
 * Every change autosaves (debounced) with an undo trail — no save game (the NOT-annoying rule).
 * The overlay handles are POSITIONED BY MEASURING the rendered page after every change, so they
 * always sit exactly on the thing they move, whatever the template does to the layout.
 */

type DocKind = "invoice" | "quote";
type Template = "classic" | "modern" | "minimal";

interface Marks {
  page: { left: number; top: number; width: number; height: number };
  scale: number; // px per inch
  gutter: { x: number; top: number; height: number } | null;
  logo: { left: number; top: number; width: number; height: number } | null;
}

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
  const [dragLabel, setDragLabel] = useState<string | null>(null);

  const undoRef = useRef<DocStyle[]>([]);
  const redoRef = useRef<DocStyle[]>([]);
  const styleRef = useRef(style);
  styleRef.current = style;

  // ── Autosave (debounced) — the page IS the form; nothing here has a Save button. ──
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueSave = useCallback((next: DocStyle) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    setSaved("saving");
    saveTimer.current = setTimeout(async () => {
      const res = await updateOrgSettings({ doc_style: next as unknown as Record<string, unknown> });
      setSaved(res?.ok ? "saved" : "error");
      if (!res?.ok) toast(res?.error ?? "Couldn't save — your changes are still on screen. Try again.", "error");
    }, 600);
  }, [toast]);

  /** Commit a style: history entry + autosave. Drags pass history:false per-move and commit once on release. */
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
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return; // native field undo wins
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
    const logoEl = page.querySelector<HTMLElement>("img") ?? page.querySelector<HTMLElement>(".print-page svg")?.parentElement ?? null;
    setMarks({
      page: rel(pr),
      scale: pr.width / 8.5,
      gutter:
        table && th2
          ? { x: rel(th2.getBoundingClientRect()).left, top: rel(table.getBoundingClientRect()).top, height: table.getBoundingClientRect().height }
          : null,
      logo: logoEl ? rel(logoEl.getBoundingClientRect()) : null,
    });
  }, []);
  useLayoutEffect(() => {
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [measure, style, docKind, templates]);
  useEffect(() => {
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure]);

  // ── Drag machinery: live style per-move (no history), one history entry on release. ──
  const dragRef = useRef<{ startX: number; startY: number; start: DocStyle } | null>(null);
  function startDrag(e: React.PointerEvent, onMove: (dx: number, dy: number, start: DocStyle) => void, label?: () => string) {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startY: e.clientY, start: styleRef.current };
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      onMove(ev.clientX - d.startX, ev.clientY - d.startY, d.start);
      if (label) setDragLabel(label());
    };
    const up = () => {
      const d = dragRef.current;
      dragRef.current = null;
      setDragLabel(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (d) {
        // One undo step for the whole gesture, then save the landed value.
        undoRef.current = [...undoRef.current.slice(-49), d.start];
        redoRef.current = [];
        queueSave(styleRef.current);
      }
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

  const handleBar = "absolute z-20 rounded-full bg-brand/50 transition-colors hover:bg-brand";

  return (
    <div className="space-y-3">
      {/* ── Toolbar ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-slate-200 bg-white px-3 py-2">
        <SegmentedControl
          activeId={docKind}
          onSelect={(id) => setDocKind(id as DocKind)}
          items={[
            { id: "invoice", label: "Invoice" },
            { id: "quote", label: "Estimate" },
          ]}
        />
        <SegmentedControl
          activeId={template}
          onSelect={(id) => pickTemplate(id as Template)}
          items={[
            { id: "classic", label: "Classic" },
            { id: "modern", label: "Modern" },
            { id: "minimal", label: "Minimal" },
          ]}
        />
        <SegmentedControl
          activeId={style.density}
          onSelect={(id) => apply({ ...style, density: id as DocStyle["density"] })}
          items={[
            { id: "compact", label: "Compact" },
            { id: "default", label: "Normal" },
            { id: "airy", label: "Airy" },
          ]}
        />
        <span className="ml-auto inline-flex items-center gap-1.5">
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
            className="inline-flex items-center gap-1 rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
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

      {/* Closing line for the doc being viewed — words are layout too. */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2">
        <div className="min-w-64 flex-1">
          <Label htmlFor="studio-closing">{docKind === "invoice" ? "Invoice closing line" : "Estimate closing line"}</Label>
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
            Labor / Materials box
          </label>
        )}
        <p className="mb-2 basis-full text-xs text-slate-400">
          Drag the bars on the page: edges set the margins, the bar at the number columns sets their spacing. Click the logo to resize it.
          Sample rows — your real documents restyle instantly.
        </p>
      </div>

      {/* ── The page itself ─────────────────────────────────────────────────── */}
      <div className="overflow-auto rounded-xl bg-slate-200/70 p-4 sm:p-8">
        <div ref={wrapRef} className="relative mx-auto w-fit max-w-full select-none">
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

          {/* ── Handles, measured onto the real render ── */}
          {marks && (
            <>
              {/* Left + right margin bars */}
              <div
                className={`${handleBar} w-1 cursor-col-resize`}
                style={{ left: marks.page.left + style.margin_x * scale - 2, top: marks.page.top + 8, height: marks.page.height - 16, touchAction: "none" }}
                title={`Side margins — ${style.margin_x}"`}
                onPointerDown={(e) =>
                  startDrag(
                    e,
                    (dx, _dy, start) => apply({ ...start, margin_x: start.margin_x + dx / scale }, { history: false, save: false }),
                    () => `${styleRef.current.margin_x.toFixed(2)}"`,
                  )
                }
              />
              <div
                className={`${handleBar} w-1 cursor-col-resize`}
                style={{ left: marks.page.left + marks.page.width - style.margin_x * scale + 1, top: marks.page.top + 8, height: marks.page.height - 16, touchAction: "none" }}
                title={`Side margins — ${style.margin_x}"`}
                onPointerDown={(e) =>
                  startDrag(
                    e,
                    (dx, _dy, start) => apply({ ...start, margin_x: start.margin_x - dx / scale }, { history: false, save: false }),
                    () => `${styleRef.current.margin_x.toFixed(2)}"`,
                  )
                }
              />
              {/* Top margin bar */}
              <div
                className={`${handleBar} h-1 cursor-row-resize`}
                style={{ top: marks.page.top + style.margin_y * scale - 2, left: marks.page.left + 8, width: marks.page.width - 16, touchAction: "none" }}
                title={`Top & bottom margins — ${style.margin_y}"`}
                onPointerDown={(e) =>
                  startDrag(
                    e,
                    (_dx, dy, start) => apply({ ...start, margin_y: start.margin_y + dy / scale }, { history: false, save: false }),
                    () => `${styleRef.current.margin_y.toFixed(2)}"`,
                  )
                }
              />
              {/* Column-gap bar at the first numeric column: drag LEFT = more room for numbers,
                  RIGHT = more room for the description. The bar re-measures onto the moved edge. */}
              {marks.gutter && (
                <div
                  className={`${handleBar} w-1 cursor-col-resize`}
                  style={{ left: marks.gutter.x + 1, top: marks.gutter.top, height: marks.gutter.height, touchAction: "none" }}
                  title={`Column spacing — ${style.col_gap}px (drag; description gets the rest)`}
                  onPointerDown={(e) =>
                    startDrag(
                      e,
                      (dx, _dy, start) => apply({ ...start, col_gap: Math.round(start.col_gap - dx / 2) }, { history: false, save: false }),
                      () => `${styleRef.current.col_gap}px`,
                    )
                  }
                />
              )}
              {/* Logo — click to cycle size */}
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
              {/* Live value chip while dragging */}
              {dragLabel && (
                <div className="pointer-events-none absolute left-1/2 top-2 z-30 -translate-x-1/2 rounded-full bg-slate-900/90 px-3 py-1 font-mono text-xs text-white">
                  {dragLabel}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
