/**
 * DOCUMENT LAYOUT KNOBS — the dial-it-in layer Erik asked for after three rounds of
 * column-spacing tuning by code change ("i dial these things in with microadjustments
 * just like we did with the design studio").
 *
 * One nested `doc_style` object on organizations.settings, because ONE key can ride the
 * public_* RPC org whitelists ('doc_style', o.settings->'doc_style' — never to_jsonb(o),
 * see 0140/0187's standing instruction). Absent keys keep today's look — a fresh org's
 * documents are pixel-identical to before this module existed.
 *
 * SANITIZE ON READ (project doctrine): this normalizer is the single boundary. Every
 * renderer — staff print, public /i and /q, in-app preview — passes whatever raw value it
 * holds through normalizeDocStyle, so a hand-edited or RPC-carried object can never inject
 * absurd geometry into customer paper. There is deliberately NO versioning machinery here:
 * the knobs are their own undo, and the stored-PDF cache re-renders automatically because
 * changed knobs change the /print HTML hash.
 */

export interface DocStyle {
  /** Gap (px) to the LEFT of each numeric column in line-item tables. */
  col_gap: number;
  /** Table row rhythm: padding + type size scale together. */
  density: "compact" | "default" | "airy";
  /** Letterhead logo size. */
  logo_size: "s" | "m" | "l";
  /** The labor/materials cost-breakdown box on invoices (auto-shown today). */
  show_breakdown: boolean;
  /** Closing line on invoices — "" keeps the built-in remit/thank-you sentence. */
  closing_invoice: string;
  /** Closing line on estimates/quotes — "" keeps the built-in fallback. */
  closing_quote: string;
  /** Page side margins, inches. */
  margin_x: number;
  /** Page top/bottom margins, inches. */
  margin_y: number;
}

export const DEFAULT_DOC_STYLE: DocStyle = {
  col_gap: 20, // = the pl-5 the layout shipped with
  density: "default",
  logo_size: "m",
  show_breakdown: true,
  closing_invoice: "",
  closing_quote: "",
  margin_x: 0.75, // = globals.css .print-page 0.6in 0.75in
  margin_y: 0.6,
};

const clamp = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

export function normalizeDocStyle(raw: unknown): DocStyle {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_DOC_STYLE;
  return {
    col_gap: clamp(r.col_gap, 8, 48, d.col_gap),
    density: r.density === "compact" || r.density === "airy" ? r.density : "default",
    logo_size: r.logo_size === "s" || r.logo_size === "l" ? r.logo_size : "m",
    show_breakdown: r.show_breakdown === undefined ? d.show_breakdown : Boolean(r.show_breakdown),
    closing_invoice: typeof r.closing_invoice === "string" ? r.closing_invoice.slice(0, 300) : "",
    closing_quote: typeof r.closing_quote === "string" ? r.closing_quote.slice(0, 300) : "",
    margin_x: clamp(r.margin_x, 0.3, 1.5, d.margin_x),
    margin_y: clamp(r.margin_y, 0.3, 1.5, d.margin_y),
  };
}

/** Row padding class per density — one map, both document tables. */
export const DENSITY_ROW: Record<DocStyle["density"], string> = {
  compact: "py-1",
  default: "py-2",
  airy: "py-3",
};

/** Logo classes per size — consumed by the letterhead Mark. */
export const LOGO_SIZE: Record<DocStyle["logo_size"], string> = {
  s: "h-9 max-w-[140px]",
  m: "h-12 max-w-[180px]",
  l: "h-16 max-w-[240px]",
};

/** The sheet's CSS vars — globals.css .print-page reads these with today's values as fallback. */
export function sheetStyleVars(s: DocStyle): Record<string, string> {
  return { "--doc-my": `${s.margin_y}in`, "--doc-mx": `${s.margin_x}in` };
}
