import type { ReactNode } from "react";
import type { ResolvedSite } from "@/lib/site-address";
import { formatCurrency, formatDate } from "@/lib/utils";
import type { CSSProperties } from "react";
import { normalizeDocStyle, sheetStyleVars, type DocStyle, type EstimateFormat } from "@/lib/doc-style";
import { coerceTaskDetail, detailExplains, lineQty, partMoney, taskMoney } from "@/lib/estimate/task-lines";

// The quote table's rhythm is a step tighter than the invoice's at every density.
const QUOTE_DENSITY_ROW: Record<DocStyle["density"], string> = {
  compact: "py-0.5",
  default: "py-1",
  airy: "py-2",
};
import { DocHeader, DocParty, DocSite, DocTotals, DocNote, DocDescription, type DocPartyCustomer } from "@/components/doc-templates";
import { lineItemParts } from "@/components/line-item-text";
import type { QuoteCircuit } from "@/lib/types";

/**
 * THE single quote/estimate document body. Every read-only surface — the office
 * print/PDF page and the public /q link — renders THIS, so they can never drift
 * (the old "the /q page shows a run-on description, no Unit column, no terms/
 * footer the print copy has"). It mirrors invoice-document.tsx: page-specific
 * chrome (back/print buttons, the share banner) stays in each page around it,
 * and the surface-specific bits — the customer-facing accept widget and the
 * "Questions? Contact …" row — are gated per surface (the public page passes
 * them, the office print page doesn't), the same way InvoiceDocument leaves the
 * pay widget to the page.
 *
 * Line items render through the SAME bullet/sub-item logic the print page used
 * (lineItemParts → header + indented bullet list), so a multi-line description
 * becomes orderly sub-items instead of a comma-jammed run-on on BOTH surfaces.
 */
export type QuoteDocItem = {
  id?: string;
  description?: string | null;
  quantity: number;
  unit?: string | null;
  unit_price: number;
  line_total: number;
  /** The task behind the line (0386), when it was built from one: the office's full breakdown, or
   *  the redacted shape public_quote ships. Read through coerceTaskDetail (the new `labor` rows or
   *  an old row's `hours`/`rate` alike); printed only when `estimateFormat` says "detailed". */
  detail?: unknown;
};

export function QuoteDocument({
  co,
  template,
  docLabel,
  number,
  createdAt,
  validUntil,
  title,
  description,
  customer,
  site,
  items,
  subtotal,
  taxRate,
  tax,
  total,
  notes,
  terms,
  documentFooter,
  circuits,
  acceptSlot,
  showContact = false,
  docStyle,
  estimateFormat,
}: {
  co: any;
  template: any;
  /** "Quote" (fixed price) or "Estimate" (T&M) — follows doc_type per surface. */
  docLabel: string;
  number: string;
  createdAt: string | Date;
  validUntil?: string | Date | null;
  title?: string | null;
  description?: string | null;
  customer: DocPartyCustomer;
  /** The resolved job site — pickSite() output. Absent on surfaces that don't know one yet. */
  site?: ResolvedSite | null;
  items: QuoteDocItem[];
  subtotal: number;
  taxRate?: number | null;
  tax: number;
  total: number;
  notes?: string | null;
  terms?: string | null;
  documentFooter?: string | null;
  /** Optional circuit schedule — prints as a second page when present. */
  circuits?: QuoteCircuit[] | null;
  /** The customer-facing accept/decline widget — public surface only. */
  acceptSlot?: ReactNode;
  /** Show the closing "Questions? Contact …" row — public surface only. */
  showContact?: boolean;
  /** Org doc_style, raw — normalized HERE (sanitize on read; public RPC hands it over untyped). */
  docStyle?: unknown;
  /** HOW THIS ESTIMATE'S TASK LINES READ (cn-v1131): "tasks" prints each task with its price alone;
   *  "detailed" prints its labor rows and parts beneath it. Resolved by the mounter through THE ONE
   *  READER, estimateFormatFor(quote, docStyle) — the estimate's own choice else the company's — so
   *  this component never reads doc_style.estimate_format itself and the paper, the PDF, the public
   *  link and the studio cannot disagree about one estimate. */
  estimateFormat: EstimateFormat;
}) {
  const ds = normalizeDocStyle(docStyle);
  const coSized = { ...co, logoSize: ds.logo_size };
  const rowPad = QUOTE_DENSITY_ROW[ds.density];
  const gap = { paddingLeft: ds.col_gap };
  const c = customer;
  const circuitRows = (circuits ?? []).filter((r) => r && (r.description?.trim() || r.ckt || r.breaker || r.wire));

  return (
    <>
    <div className="print-page mx-auto bg-white shadow-sm" style={sheetStyleVars(ds) as CSSProperties}>
      <DocHeader
        co={coSized}
        template={template}
        meta={{
          docType: docLabel,
          number,
          rows: [
            { label: "Date", value: formatDate(createdAt) },
            ...(validUntil ? [{ label: "Valid until", value: formatDate(validUntil) }] : []),
          ],
        }}
      />

      {/* Prepared-for (two columns: identity + contact | location), mirroring the
          invoice "Bill to" grouping — contact behind a brand accent rule. */}
      <div className="mt-6">
        <DocParty label="Prepared for" customer={c} brand={co.brand} />
      </div>

      {/* WHERE THE WORK HAPPENS. Absent = exactly today's output, so this is additive. */}
      {site && (
        <div className="mt-5">
          <DocSite site={site} brand={co.brand} />
        </div>
      )}

      {title && <div className="mt-5 text-base font-semibold text-slate-900">{title}</div>}
      {/* WHICH KIND OF NUMBER THIS IS, said on the paper. Andrew: "time and material estimate vs.
          fixed bid estimate. it doesn't mean anything.. It needs to have a statement at the top of
          each differentiating." The toggle has existed since cn-v517; the document never said the
          words, so the customer had only a one-word label ("Estimate"/"Quote") to infer a legal
          difference from. One factual line, no sales language — it prints on customer paper. */}
      <p className="mt-1 text-xs italic text-slate-500">
        {docLabel.toLowerCase() === "quote"
          ? "This is a fixed price for the scope described below."
          : "This is an estimate of costs — final billing reflects actual time and materials."}
      </p>
      {description && <DocDescription text={description} />}

      {/* Line items — a multi-line/comma-list description renders extra lines as
          indented sub-items (e.g. the materials that make up a service line),
          via the SAME lineItemParts logic the office print page used. Includes
          the Unit column the public /q page was missing. */}
      <table className="mt-4 w-full border-collapse text-[13px] leading-snug">
        <thead>
          <tr className="border-b border-slate-300 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <th className="py-1.5 font-semibold">Description</th>
            {/* SAME column rule as the invoice (one scheme, one knob): numeric columns take
                exactly their content + the org's gap; the description gets the rest. */}
            <th className="w-px whitespace-nowrap py-1.5 text-right font-semibold" style={gap}>Qty</th>
            <th className="w-px whitespace-nowrap py-1.5 text-right font-semibold" style={gap}>Unit</th>
            <th className="w-px whitespace-nowrap py-1.5 text-right font-semibold" style={gap}>Price</th>
            <th className="w-px whitespace-nowrap py-1.5 text-right font-semibold" style={gap}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, i) => {
            const raw = String(it.description ?? "");
            const parts = lineItemParts(raw).map((s) => s.replace(/^\s*[-•*]\s*/, "").trim());
            // Newline lists keep their first line as a header; a bare comma-list
            // has no header — every part is a bullet.
            const headerStyle = /\n/.test(raw) || parts.length <= 1;
            const head = headerStyle ? parts[0] ?? "" : "";
            const subs = head ? parts.slice(1) : parts.length > 1 ? parts : [];
            // THE BREAKDOWN BEHIND A TASK LINE (0386; labor rows cn-v1131). Erik: the customer sees the
            // estimate "in a per-company format" — "tasks" prints the line alone; "detailed" prints one
            // bullet per labor row (its hours at its rate) and each part with its count beneath it.
            // Only while it still ADDS UP to the line: a price edited by hand afterwards has no
            // breakdown to show, and printing one that disagrees with the figure beside it would be a
            // second number on the customer's paper. A row with no hours yet prints nothing.
            const d = estimateFormat === "detailed" ? coerceTaskDetail(it.detail) : null;
            const laborRows = d ? d.labor.filter((row) => row.hours !== null) : [];
            const breakdown = d && (laborRows.length > 0 || d.materials.length > 0) && detailExplains(d, it) ? d : null;
            // THE BREAKDOWN IS PER UNIT (cn-v1133): the Qty box multiplies it on the line, so when the
            // customer is buying more than one of the task ONE sub-heading above the bullets says so —
            // "For each one:" — and no bullet carries a word of its own. " each" after a part's money
            // misread it: "Tandem breaker, 20A × 2 · $40.00 each" says $40 per breaker, when it is $20
            // × 2 per task (skeptic #39, S1). The customer's words, never the crew's.
            const perUnit = lineQty(it) !== 1;
            return (
              <tr key={it.id ?? i} className="border-b border-slate-100 align-top [break-inside:avoid]">
                <td className={`${rowPad} pr-2 text-slate-800`}>
                  {head && <div>{head}</div>}
                  {subs.length > 0 && (
                    <ul className="ml-3 mt-0.5 list-disc text-[11px] text-slate-500 marker:text-slate-300">
                      {subs.map((s, j) => (
                        <li key={j}>{s}</li>
                      ))}
                    </ul>
                  )}
                  {breakdown && perUnit && <div className="mt-0.5 text-[11px] text-slate-500">For each one:</div>}
                  {breakdown && (
                    <ul className="ml-3 mt-0.5 list-disc text-[11px] text-slate-500 marker:text-slate-300">
                      {/* ONE BULLET PER LABOR ROW. A row that names a person reaches the public wire
                          with its label null (public_quote never ships who): the customer's paper
                          says "Labor", never the crew's names. The row's money is THE one arithmetic
                          (taskMoney) over that row alone, so the bullets add up to the line to the cent. */}
                      {laborRows.map((row, j) => (
                        <li key={`l${j}`}>
                          {row.label ?? "Labor"} · {row.hours} h × {formatCurrency(row.rate)} = {formatCurrency(taskMoney({ ...breakdown, labor: [row], materials: [] }).labor)}
                        </li>
                      ))}
                      {breakdown.materials.map((m, j) => (
                        <li key={j}>
                          {m.name}
                          {m.qty !== null ? ` × ${m.qty}` : ""}
                          {m.qty !== null && m.sell !== null ? ` · ${formatCurrency(partMoney(m))}` : ""}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className={`whitespace-nowrap ${rowPad} text-right text-slate-600`} style={gap}>{it.quantity}</td>
                <td className={`whitespace-nowrap ${rowPad} text-right text-slate-500`} style={gap}>{it.unit}</td>
                <td className={`whitespace-nowrap ${rowPad} text-right text-slate-600`} style={gap}>{formatCurrency(it.unit_price)}</td>
                <td className={`whitespace-nowrap ${rowPad} text-right font-medium text-slate-900`} style={gap}>{formatCurrency(it.line_total)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* Totals — no balance passed, so Total itself is the bold emphasis (no Paid/Balance rows). */}
      <DocTotals subtotal={subtotal} taxRate={taxRate} tax={tax} total={total} />

      {/* Accept/decline — customer-facing surface only (the office print copy omits it). */}
      {acceptSlot && <div className="mt-8 [break-inside:avoid]">{acceptSlot}</div>}

      {notes && <DocNote label="Notes" text={notes} breakAvoid />}
      {terms && <DocNote label="Terms" text={terms} breakAvoid />}

      {showContact && (
        <div className="mt-10 text-center text-xs text-slate-400">
          Questions? Contact {co.name}{co.phone ? ` · ${co.phone}` : ""}.
        </div>
      )}

      <div className="mt-6 whitespace-pre-wrap text-center text-xs text-slate-400">
        {ds.closing_quote.trim() || documentFooter || "Thank you for the opportunity to earn your business."}
      </div>
    </div>

    {/* Circuit schedule — a second sheet (break-before:page in print) showing the panel layout
        behind the price: which breaker feeds what, on which wire. Only when the estimate carries one. */}
    {circuitRows.length > 0 && (
      <div className="print-page mx-auto mt-6 bg-white shadow-sm print:mt-0" style={{ breakBefore: "page" }}>
        <div className="flex items-baseline justify-between border-b border-slate-300 pb-2">
          <h2 className="text-base font-semibold text-slate-900">Circuit Schedule</h2>
          <span className="text-[11px] uppercase tracking-wide text-slate-400">{docLabel} {number}</span>
        </div>
        <p className="mt-2 text-xs text-slate-500">The panel layout behind this estimate — {circuitRows.length} circuit{circuitRows.length === 1 ? "" : "s"}. Field-verify before rough-in.</p>
        <table className="mt-4 w-full border-collapse text-[13px] leading-snug">
          <thead>
            <tr className="border-b border-slate-300 text-left text-[11px] uppercase tracking-wide text-slate-500">
              <th className="w-12 py-1.5 font-semibold">Ckt</th>
              <th className="py-1.5 font-semibold">Description</th>
              <th className="w-20 py-1.5 font-semibold">Wire</th>
              <th className="w-20 py-1.5 font-semibold">Breaker</th>
              <th className="w-28 py-1.5 font-semibold">Load / notes</th>
            </tr>
          </thead>
          <tbody>
            {circuitRows.map((r, i) => (
              <tr key={i} className="border-b border-slate-100 align-top [break-inside:avoid]">
                <td className="py-1 pr-2 font-medium text-slate-700">{r.ckt ?? i + 1}</td>
                <td className="py-1 pr-2 text-slate-800">{r.description}</td>
                <td className="py-1 pr-2 text-slate-600">{r.wire ?? ""}</td>
                <td className="py-1 pr-2 text-slate-600">{r.breaker ?? ""}</td>
                <td className="py-1 text-slate-500">{r.load ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )}
    </>
  );
}
