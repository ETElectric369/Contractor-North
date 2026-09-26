/**
 * WHAT'S ON A SUPPLIER'S PAPER, READ OFF ITS OWN LINES (Erik, 2026-09-26: "i need to open the bill
 * to see whats on it to be able to approve or deny").
 *
 * The Supplier Bills card asks what a paper was for. He cannot answer that from "$59.17 · It Says
 * 13683 HILLSIDE" alone: he has to SEE the paper before the tap. This turns the rows the CED import
 * kept (supplier_invoice_lines, in the order CED printed them) into the lines the card draws.
 * Pure, so every rule below is tested without a database; supplierPaperContents (supplier-actions)
 * does the staff-only, org-filtered read and hands the rows here.
 *
 * THE EXTENSION IS THE PRICE. CED prices a decora plate "50.00 C": fifty cents. The unit price is
 * decoration and is never multiplied by anything here; a line shows its quantity and its
 * EXTENSION. A $0.00 extension means nothing shipped (a back order), and it says "Not Shipped"
 * rather than a price or a free part.
 *
 * THE TOTAL IS THE SUPPLIER'S, the same column the card's amount is. When the lines plus tax plus
 * shipping don't come to it, the view says how much isn't on a line instead of hiding the gap.
 */

const money = (n: unknown): number => Math.round((Number(n) || 0) * 100) / 100;
const cents = (n: number) => Math.round(n * 100);
const text = (v: unknown): string | null => {
  const s = String(v ?? "").trim();
  return s.length ? s : null;
};

export interface SupplierPaperLineRow {
  description?: string | null;
  part_number?: string | null;
  quantity?: unknown;
  unit_price?: unknown;
  extension?: unknown;
  sort_order?: unknown;
}

export interface PaperContentsLine {
  key: string;
  /** "6 × SP 3WY WHT BXD DMR (DVCL153PWH)": the quantity CED shipped or billed, and the part. */
  what: string;
  /** The extension. Zero means nothing shipped (notShipped). */
  amount: number;
  notShipped: boolean;
}

export interface PaperContents {
  invoiceNumber: string;
  lines: PaperContentsLine[];
  tax: number;
  shipping: number;
  /** supplier_invoices.total: the same figure the card's headline says. */
  total: number;
  /** total − (lines + tax + shipping). Positive: money on the paper that is on no line. */
  offLines: number;
  /** A link to the stored PDF, when one is stored (and could be signed). */
  pdfUrl: string | null;
  /** Said where the PDF link would be, when there is none: never a silent missing button. */
  pdfNote: string | null;
}

/** "6", "55.5", "1,000": the count as CED printed it, never padded with its three decimals. */
export function quantityWords(q: unknown): string {
  const n = Number(q);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

const usd = (n: number) => {
  const s = Math.abs(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
  return n < 0 ? `-${s}` : s;
};

/** One line in words: "6 × SP 3WY WHT BXD DMR (DVCL153PWH) · $167.76", or "… · Not Shipped". */
export function lineWords(l: PaperContentsLine): string {
  return `${l.what} · ${l.notShipped ? "Not Shipped" : usd(l.amount)}`;
}

export function paperContentsLines(rows: SupplierPaperLineRow[]): PaperContentsLine[] {
  // As CED printed them: sort_order, and the read order where two share one (a stable sort).
  const sorted = (rows ?? [])
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (Number(a.r?.sort_order) || 0) - (Number(b.r?.sort_order) || 0) || a.i - b.i)
    .map(({ r }) => r);
  const out: PaperContentsLine[] = [];
  for (const l of sorted) {
    const amount = money(l?.extension);
    const qty = Number(l?.quantity) || 0;
    const description = text(l?.description);
    const part = text(l?.part_number);
    // A row with nothing on it at all is not a line (supplierBillLines drops the same ones).
    if (!amount && !qty && !money(l?.unit_price) && !description && !part) continue;
    const named = description ?? part ?? "A Line With No Description";
    const withPart = part && description && !description.toUpperCase().includes(part.toUpperCase()) ? `${named} (${part})` : named;
    // A back-ordered line prints a zero quantity: the count says nothing, so it is left off.
    const what = qty ? `${quantityWords(qty)} × ${withPart}` : withPart;
    out.push({ key: String(out.length), what, amount, notShipped: amount === 0 });
  }
  return out;
}

export function paperContents(input: {
  invoice: { invoice_number?: string | null; tax?: unknown; shipping?: unknown; total?: unknown; source_file?: string | null };
  lines: SupplierPaperLineRow[];
  /** A signed link to the stored PDF, if the server found and signed one. */
  pdfUrl?: string | null;
  /** True when the server found a stored PDF but could not sign a link to it. */
  pdfUnsignable?: boolean;
  /** True when the server could not check for a stored PDF at all. */
  pdfCheckFailed?: boolean;
}): PaperContents {
  const lines = paperContentsLines(input.lines);
  const tax = money(input.invoice?.tax);
  const shipping = money(input.invoice?.shipping);
  const total = money(input.invoice?.total);
  const lineSum = lines.reduce((s, l) => s + cents(l.amount), 0);
  const offLines = (cents(total) - lineSum - cents(tax) - cents(shipping)) / 100;
  const fileName = text(input.invoice?.source_file);
  // A stored path (the import kept the PDF: "<org>/organize/ced/<sha>.pdf") is a file on file, never
  // a name to quote back at him.
  const storedPath = !!fileName && fileName.includes("/");
  const pdfUrl = text(input.pdfUrl);
  const pdfNote = pdfUrl
    ? null
    : input.pdfUnsignable || storedPath
      ? "Its PDF is on file but couldn't be opened just now."
      : input.pdfCheckFailed
        ? "It couldn't check for its PDF just now."
        : fileName
          ? `Its PDF wasn't saved here, only what was read from ${fileName}. Choose that PDF again with Choose CED PDFs on Bills to keep it.`
          : "It came in as pasted text, so there's no PDF here.";
  return { invoiceNumber: String(input.invoice?.invoice_number ?? ""), lines, tax, shipping, total, offLines, pdfUrl, pdfNote };
}

/** The gap between the lines and the total, in words; null when they agree to the cent. */
export function offLinesWords(c: Pick<PaperContents, "offLines">): string | null {
  if (cents(c.offLines) === 0) return null;
  if (c.offLines > 0) return `${usd(c.offLines)} of the total isn't on any line.`;
  return `The lines come to ${usd(-c.offLines)} more than the total.`;
}
