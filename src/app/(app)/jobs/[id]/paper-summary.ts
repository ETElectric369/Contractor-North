/**
 * WHAT A PAPER IS, IN ONE LINE, AND WHAT IT CAME TO (cn-v1174, the owner on the Costs tab: "receipts
 * and papers need to show a summary and total amount for identification pls").
 *
 * ONE RULE for the Costs tab's Receipts & Papers rows and its Supplier bills rows:
 *
 *   1. THE BILL WINS. A paper on a bill says what was bought on it (its line descriptions, the first
 *      two, then "+N more") and the bill's amount. The supplier is NOT said again: both rows that read
 *      this already name it on a line of their own ("On the <supplier> bill #N.", the bill's header).
 *   2. ELSE THE RECEIPT READER'S OWN RECORD for that paper (organized_items): its vendor, then its
 *      title or else its summary; its amount.
 *   3. ELSE NOTHING. A paper nobody read says nothing and shows no figure: never a guess, never $0.
 *      A file's name is not a summary.
 *
 * A recorded amount is shown as it is recorded, zero or negative included (a credit reads as one); a
 * MISSING amount is null, never 0. Long text is never cut here: the row clamps it to one line in CSS.
 * Pure, no words of its own: the caller hands in its "+N more" in the reader's language.
 */

export type PaperBillFacts = {
  amount?: number | string | null;
  bill_line_items?: readonly { description?: string | null }[] | null;
};

export type PaperReaderFacts = {
  vendor?: string | null;
  title?: string | null;
  summary?: string | null;
  amount?: number | string | null;
};

export type PaperSummary = {
  /** The one line of what it is; null = nothing recorded to say. */
  what: string | null;
  /** The figure on the right; null = none recorded (never drawn as $0). */
  total: number | null;
  /** Where it came from: the bill, the reader's record, or nothing. */
  from: "bill" | "reader" | "none";
};

/** How many line descriptions are named before "+N more". */
export const LINES_NAMED = 2;

const NONE: PaperSummary = { what: null, total: null, from: "none" };

/** A recorded amount as a number; null when nothing (or nothing numeric) is recorded. */
function recorded(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function words(v: string | null | undefined): string | null {
  const s = String(v ?? "").replace(/\s+/g, " ").trim();
  return s ? s : null;
}

/** What was bought on a bill: its line descriptions in order (blank and repeated ones skipped), the
 *  first LINES_NAMED of them, then the caller's "+N more" for the rest. null when no line says. */
export function billLinesWhat(
  lines: PaperBillFacts["bill_line_items"],
  more: (n: number) => string,
): string | null {
  const seen = new Set<string>();
  const said: string[] = [];
  for (const l of lines ?? []) {
    const d = words(l?.description);
    if (!d) continue;
    const key = d.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    said.push(d);
  }
  if (!said.length) return null;
  const head = said.slice(0, LINES_NAMED).join(", ");
  const rest = said.length - LINES_NAMED;
  return rest > 0 ? `${head} ${more(rest)}` : head;
}

/** THE ONE RULE (see the header). `readers`: every reader record for this paper; the first that says
 *  anything (words or an amount) is the one shown. */
export function paperSummary(input: {
  bill?: PaperBillFacts | null;
  readers?: readonly PaperReaderFacts[] | null;
  more: (n: number) => string;
}): PaperSummary {
  if (input.bill) {
    return { what: billLinesWhat(input.bill.bill_line_items, input.more), total: recorded(input.bill.amount), from: "bill" };
  }
  for (const r of input.readers ?? []) {
    if (!r) continue;
    const vendor = words(r.vendor);
    const about = words(r.title) ?? words(r.summary);
    const what = [vendor, about].filter(Boolean).join(" · ") || null;
    const total = recorded(r.amount);
    if (what || total !== null) return { what, total, from: "reader" };
  }
  return NONE;
}

/** A receipt reader's record as the paper match reads it (organized_items). */
export type PaperTieRow = { document_id?: string | null; file_url?: string | null; created_at?: string | null };

/**
 * THE READER'S RECORDS FOR ONE PAPER, IN THE ORDER paperSummary TAKES THEM (skeptic, cn-v1174: one
 * paper with several records showed an arbitrary one). A record naming this paper's document_id wins
 * over one matched only by the same file (a record with no document_id and this paper's file_url);
 * among equals the NEWEST wins (created_at, descending; a record with no stamp goes last, and ties
 * keep the read's own order).
 */
export function readersForPaper<T extends PaperTieRow>(paper: { id: string; file_url?: string | null }, ties: readonly T[] | null | undefined): T[] {
  const id = String(paper.id);
  const file = paper.file_url ?? null;
  const ranked: { r: T; exact: boolean; at: number; i: number }[] = [];
  (ties ?? []).forEach((r, i) => {
    if (!r) return;
    const exact = !!r.document_id && String(r.document_id) === id;
    const byFile = !r.document_id && !!file && r.file_url === file;
    if (!exact && !byFile) return;
    const t = r.created_at ? Date.parse(r.created_at) : NaN;
    ranked.push({ r, exact, at: Number.isFinite(t) ? t : -Infinity, i });
  });
  ranked.sort((a, b) => (a.exact === b.exact ? (b.at === a.at ? a.i - b.i : b.at - a.at) : a.exact ? -1 : 1));
  return ranked.map((x) => x.r);
}
