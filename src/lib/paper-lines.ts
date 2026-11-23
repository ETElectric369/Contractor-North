import { decideReceiptLine } from "@/app/(app)/bills/receipt-billing";
import { applyPenMark, penMarkOf, type PenMark } from "@/lib/pen-marks";
import { isTaxish } from "@/lib/credit-memo-close";

/**
 * A PAPER'S LINES, AS THE BILL WILL HOLD THEM (moved out of organize/paperwork-core.ts for Shop
 * Stock, Phase 2).
 *
 * File It writes a tray paper's transcribed lines onto its bill through cleanLines, in this order,
 * with sort_order = the index here. The Shop Stock destination asks a person to confirm a count on
 * EACH of those lines before anything is written, so the tray row has to see exactly the lines the
 * bill will get, in exactly that order: the row and the server key a person's answers by index. One
 * function, importable by both (paperwork-core.ts is server-only), is how the two cannot disagree.
 */
export interface BillLine {
  description: string;
  quantity: number;
  unit_price: number;
  amount: number;
  category: string | null;
  /** false = the company eats this line; it never reaches the customer's invoice (0268). */
  billable: boolean;
  /**
   * What the job used, in dollars, when the line was a container (0272): 60 of 500 wire nuts.
   * Set by a person on the bill, never by a reader. It rides back onto the paper when a filing is
   * undone (Erik, audit v994 TD3: "Undo, then refile, keeps the line choices made on the bill").
   * Absent = the whole line, which is what every read line means.
   */
  billed_amount?: number;
  /**
   * INK ON THE PAPER (cn-v1181, src/lib/pen-marks.ts): what the reader saw written by hand on this
   * line. `unclear` IS the open question (held off the customer's bill until a person answers).
   */
  pen?: PenMark;
  /** Crossed out or sent back: off the customer's bill. Explicit once read or answered. */
  returned?: boolean;
}

/**
 * Normalize the AI's line_items into clean BillLine rows.
 *
 * PEN MARKS (cn-v1181): each cleaned line goes through applyPenMark with what the reader said of it
 * (`pen`, `hand_quantity`) or what is stored on it (`pen`, `returned`), so a struck line comes off the
 * customer's bill and a quantity changed by hand becomes two lines, kept and returned, at the PRINTED
 * extension split cent-exact. IDEMPOTENT: a stored line (File It, an Undo) carries an explicit
 * `returned` and no `hand_quantity`, and passes through exactly as it is, so cleanLines(cleanLines(x))
 * is cleanLines(x). The 100-line cap applies after the split.
 *
 * A TAX LINE NEVER TAKES A PEN MARK (cn-v1184): tax rides with what it taxes (lib/bill-itemisation
 * takes a not-billed line's share of the untouched tax off with it), and a stroke over the tax or the
 * totals says nothing a line mark could say. So on a tax line (isTaxish, the one predicate) what the
 * reader said (`pen`, `hand_quantity`) and what is stored (`pen`, `returned`) are ignored, and so is a
 * stored `billable: false` that came WITH a mark or a `returned: true` (the mark's doing). A tax line
 * a person switched off with no mark on it stays off. Still idempotent: the clean tax line carries
 * neither a mark nor `returned`.
 *
 * AN `unclear` LINE IS NEVER A REASON TO WAIT (P8): it is filed like any other line, held off the
 * customer's bill by billable = false, and the bill asks Kept or Returned. File It is not blocked.
 */
export function cleanLines(raw: any): BillLine[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .flatMap((l: any): BillLine[] => {
      const quantity = Number(l?.quantity) || 1;
      const unit_price = l?.unit_price != null && !isNaN(Number(l.unit_price)) ? Number(l.unit_price) : 0;
      const amount =
        l?.amount != null && !isNaN(Number(l.amount)) ? Number(l.amount) : Math.round(quantity * unit_price * 100) / 100;
      const description = String(l?.description ?? "").slice(0, 300).trim();
      const stated = l?.category ? String(l.category).slice(0, 60) : null;
      // WHOSE LINE IS IT (0268). Food and drink arrives switched OFF the customer's bill and
      // everything else arrives on it; an explicit flag already stored on the row (a tray item's
      // lines are jsonb, re-read verbatim when it is filed) wins over the default, so re-filing
      // never re-bills the snacks. decideReceiptLine is the deterministic net under the model's
      // category: it fills a shrug when the words are plainly food, and never overrules a person.
      // A TAX LINE (cn-v1184): by the words or the category, stated or resolved; one predicate.
      const tax =
        isTaxish({ category: stated, description }) ||
        isTaxish({ category: decideReceiptLine(description, stated, undefined).category, description });
      const markedOff = penMarkOf(l?.pen) != null || l?.returned === true;
      const storedBillable = tax && markedOff && l?.billable === false ? undefined : l?.billable;
      const { category, billable } = decideReceiptLine(description, stated, storedBillable);
      // A part-used amount a person set on the bill (TD3), kept only where it can stand: on a line
      // that still bills AFTER its pen mark, between nothing and the line itself (0272's check).
      const used = l?.billed_amount === null || l?.billed_amount === undefined || l?.billed_amount === "" ? NaN : Number(l.billed_amount);
      const clean: BillLine = { description, quantity, unit_price, amount, category, billable };
      return applyPenMark(clean, tax ? null : l).map((m) =>
        m.billable && Number.isFinite(used) && used >= 0 && used <= Math.abs(m.amount) + 0.005
          ? { ...m, billed_amount: Math.round(used * 100) / 100 }
          : m,
      );
    })
    .filter((l: BillLine) => l.description.length > 0)
    .slice(0, 100);
}
