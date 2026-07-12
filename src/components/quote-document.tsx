import type { ReactNode } from "react";
import { formatCurrency, formatDate } from "@/lib/utils";
import { DocHeader, DocParty, DocTotals, DocNote, DocDescription, type DocPartyCustomer } from "@/components/doc-templates";
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
}) {
  const c = customer;
  const circuitRows = (circuits ?? []).filter((r) => r && (r.description?.trim() || r.ckt || r.breaker || r.wire));

  return (
    <>
    <div className="print-page mx-auto max-w-3xl bg-white p-10 shadow-sm">
      <DocHeader
        co={co}
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

      {title && <div className="mt-5 text-base font-semibold text-slate-900">{title}</div>}
      {description && <DocDescription text={description} />}

      {/* Line items — a multi-line/comma-list description renders extra lines as
          indented sub-items (e.g. the materials that make up a service line),
          via the SAME lineItemParts logic the office print page used. Includes
          the Unit column the public /q page was missing. */}
      <table className="mt-4 w-full border-collapse text-[13px] leading-snug">
        <thead>
          <tr className="border-b border-slate-300 text-left text-[11px] uppercase tracking-wide text-slate-500">
            <th className="py-1.5 font-semibold">Description</th>
            <th className="w-12 py-1.5 text-right font-semibold">Qty</th>
            <th className="w-12 py-1.5 text-right font-semibold">Unit</th>
            <th className="w-20 py-1.5 text-right font-semibold">Price</th>
            <th className="w-24 py-1.5 text-right font-semibold">Amount</th>
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
            return (
              <tr key={it.id ?? i} className="border-b border-slate-100 align-top [break-inside:avoid]">
                <td className="py-1 pr-2 text-slate-800">
                  {head && <div>{head}</div>}
                  {subs.length > 0 && (
                    <ul className="ml-3 mt-0.5 list-disc text-[11px] text-slate-500 marker:text-slate-300">
                      {subs.map((s, j) => (
                        <li key={j}>{s}</li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="py-1 text-right text-slate-600">{it.quantity}</td>
                <td className="py-1 text-right text-slate-500">{it.unit}</td>
                <td className="py-1 text-right text-slate-600">{formatCurrency(it.unit_price)}</td>
                <td className="py-1 text-right font-medium text-slate-900">{formatCurrency(it.line_total)}</td>
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
        {documentFooter || "Thank you for the opportunity to earn your business."}
      </div>
    </div>

    {/* Circuit schedule — a second sheet (break-before:page in print) showing the panel layout
        behind the price: which breaker feeds what, on which wire. Only when the estimate carries one. */}
    {circuitRows.length > 0 && (
      <div className="print-page mx-auto mt-6 max-w-3xl bg-white p-10 shadow-sm print:mt-0" style={{ breakBefore: "page" }}>
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
