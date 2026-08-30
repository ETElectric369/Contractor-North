"use client";

import { useRef, useState, useTransition } from "react";
import { Check } from "lucide-react";
import { Input, Label } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { SegmentedControl } from "@/components/ui/segmented";
import { updateOrgSettings } from "./actions";
import { DEFAULT_DOC_STYLE, normalizeDocStyle, type DocStyle } from "@/lib/doc-style";

/**
 * DOCUMENT LAYOUT — the dial-it-in knobs (Erik: "i dial these things in with microadjustments
 * just like we did with the design studio"). Three column-spacing rounds by code change bought
 * this card: the handful of layout decisions a contractor actually tunes, self-serve.
 *
 * Every knob defaults to today's exact look (absent-key-keeps-base), saves on change with the
 * payment-methods "Saved ✓" pattern, and is re-clamped on the READ side (lib/doc-style) at every
 * renderer — so nothing typed here can push absurd geometry onto customer paper. The stored PDF
 * re-renders by itself: changed knobs change the /print HTML hash. The WordPress-style free-form
 * editor is native-shell territory; this card is the online 90%.
 */
export function DocumentLayoutSettings({ initial }: { initial: unknown }) {
  const [style, setStyle] = useState<DocStyle>(normalizeDocStyle(initial));
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, start] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function patch(p: Partial<DocStyle>) {
    // Merge sub-keys HERE: updateOrgSettings shallow-merges top-level keys, so the nested
    // object must go out whole (the saveNumbering precedent).
    const next = normalizeDocStyle({ ...style, ...p });
    setStyle(next);
    setError(null);
    start(async () => {
      const res = await updateOrgSettings({ doc_style: next as unknown as Record<string, unknown> });
      if (!res?.ok) {
        setError(res?.error ?? "Couldn't save — try again.");
        return;
      }
      setSaved(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setSaved(false), 2000);
    });
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-500">
        How estimates and invoices lay out on paper. Every change applies to previews, PDFs, and
        customer links the moment it saves — defaults are exactly how documents look today.
      </p>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label>Column spacing</Label>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={8}
              max={48}
              step={2}
              value={style.col_gap}
              onChange={(e) => patch({ col_gap: Number(e.target.value) })}
              className="flex-1"
              aria-label="Gap before each number column, pixels"
            />
            <span className="w-12 text-right font-mono text-xs tabular-nums text-slate-500">{style.col_gap}px</span>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            The gap before Qty, Price, and Amount — smaller gives long descriptions more room to
            stay on one line.
          </p>
        </div>

        <div>
          <Label>Row spacing</Label>
          <SegmentedControl
            stretch
            activeId={style.density}
            onSelect={(id) => patch({ density: id as DocStyle["density"] })}
            items={[
              { id: "compact", label: "Compact" },
              { id: "default", label: "Normal" },
              { id: "airy", label: "Airy" },
            ]}
          />
          <p className="mt-1 text-xs text-slate-400">Compact fits more lines per page.</p>
        </div>

        <div>
          <Label>Logo size</Label>
          <SegmentedControl
            stretch
            activeId={style.logo_size}
            onSelect={(id) => patch({ logo_size: id as DocStyle["logo_size"] })}
            items={[
              { id: "s", label: "Small" },
              { id: "m", label: "Medium" },
              { id: "l", label: "Large" },
            ]}
          />
        </div>

        <div>
          <Label>Page margins (inches)</Label>
          <div className="flex items-center gap-2">
            <NumberInput
              value={style.margin_x}
              onValueChange={(v) => patch({ margin_x: v })}
              className="w-20 text-center"
              aria-label="Side margins, inches"
            />
            <span className="text-xs text-slate-400">sides</span>
            <NumberInput
              value={style.margin_y}
              onValueChange={(v) => patch({ margin_y: v })}
              className="w-20 text-center"
              aria-label="Top and bottom margins, inches"
            />
            <span className="text-xs text-slate-400">top/bottom</span>
          </div>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-700">
        <input
          type="checkbox"
          checked={style.show_breakdown}
          onChange={(e) => patch({ show_breakdown: e.target.checked })}
          className="h-4 w-4 rounded border-slate-300"
        />
        Show the Labor / Materials breakdown box on invoices
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="doc-close-inv">Invoice closing line</Label>
          <Input
            id="doc-close-inv"
            value={style.closing_invoice}
            onChange={(e) => patch({ closing_invoice: e.target.value })}
            placeholder={`Blank = "Please remit $… Thank you for your business."`}
          />
        </div>
        <div>
          <Label htmlFor="doc-close-quote">Estimate closing line</Label>
          <Input
            id="doc-close-quote"
            value={style.closing_quote}
            onChange={(e) => patch({ closing_quote: e.target.value })}
            placeholder={`Blank = "Thank you for the opportunity…"`}
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => patch({ ...DEFAULT_DOC_STYLE })}
          className="text-xs font-medium text-slate-500 underline-offset-2 hover:text-brand hover:underline"
        >
          Reset to defaults
        </button>
        {saved && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600">
            <Check className="h-3.5 w-3.5" /> Saved
          </span>
        )}
        {error && <span className="text-xs font-medium text-red-600">{error}</span>}
      </div>
    </div>
  );
}
