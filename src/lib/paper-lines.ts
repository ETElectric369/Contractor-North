import { decideReceiptLine } from "@/app/(app)/bills/receipt-billing";

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
}

/** Normalize the AI's line_items into clean BillLine rows. */
export function cleanLines(raw: any): BillLine[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l: any) => {
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
      const { category, billable } = decideReceiptLine(description, stated, l?.billable);
      // A part-used amount a person set on the bill (TD3), kept only where it can stand: on a line
      // that bills, between nothing and the line itself (0272's check).
      const used = l?.billed_amount === null || l?.billed_amount === undefined || l?.billed_amount === "" ? NaN : Number(l.billed_amount);
      const keepsUsed = billable && Number.isFinite(used) && used >= 0 && used <= Math.abs(amount) + 0.005;
      return keepsUsed
        ? { description, quantity, unit_price, amount, category, billable, billed_amount: Math.round(used * 100) / 100 }
        : { description, quantity, unit_price, amount, category, billable };
    })
    .filter((l: BillLine) => l.description.length > 0)
    .slice(0, 100);
}
