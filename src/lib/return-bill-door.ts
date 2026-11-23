import { isTaxish } from "@/lib/credit-memo-close";

/**
 * WHEN A BILL'S ROW OFFERS FILE WITH ITS BILL (cn-v1184). The owner's credit came in from the job page
 * (Record as Cost on a credit), a bill of its own below zero on the job, so every draft listed the
 * purchase and then "Returned:" lines under it. The row of such a credit carries the door
 * (credit-memo-actions returnBillHome / fileReturnBillWithItsBill), which closes what the credit
 * returns on whichever of the job's bills carry those lines; the credit stays a bill of its own.
 *
 * Offered on a credit below zero to the cent, on a job, not a correction, nothing filed under it, not
 * set aside, with at least one PART line (not tax, below zero) that still bills, and only where the
 * page has read the correction column (`ready`). Where the page KNOWS an invoice that went out holds
 * it (`heldBySent`), not offered; a draft holding it never hides it (the owner's exact case). Where
 * the page cannot know, it is offered and the server's sentence refuses. Once its part lines bill
 * nothing, the door leaves the row, and the row says only that (it cannot know who took them off).
 */
export const NOT_FILED_WITH_ITS_BILL = "Not filed with its bill yet.";
/** The row cannot know who took the lines off (this door, or a person's Bill switch): it says only
 *  what is true (skeptic #86, S5). */
export const LINES_OFF_THE_BILL = "Its lines are off the customer's bill.";
/** Both doors' answer once every part line is off: a plain fact, drawn slate, never a refusal (S7). */
export const ALREADY_FILED = "This credit is already filed: its lines are off the customer's bill.";

type CreditRowInput = {
  ready: boolean;
  bill: {
    amount: number | string | null | undefined;
    job_id?: string | null;
    corrects_bill_id?: string | null;
    superseded_by_bill_id?: string | null;
    superseded?: boolean | null;
  };
  hasCorrections: boolean;
  lines: readonly { amount: unknown; billable?: boolean | null; category?: string | null; description?: string | null }[] | null | undefined;
  heldBySent?: boolean | null;
};

const cents = (n: unknown) => Math.round((Number(n) || 0) * 100);
const partLines = (lines: CreditRowInput["lines"]) => (lines ?? []).filter((l) => !isTaxish(l) && cents(l.amount) < 0);

/** A credit on a job this door is about at all (before asking whether its lines still bill). */
function creditOnJob(i: CreditRowInput): boolean {
  if (!i.ready) return false;
  if (!(cents(i.bill.amount) < 0)) return false;
  if (!i.bill.job_id) return false;
  if (i.bill.corrects_bill_id || i.hasCorrections) return false;
  if (i.bill.superseded_by_bill_id || i.bill.superseded) return false;
  return true;
}

export function rowOffersFileWithItsBill(i: CreditRowInput): boolean {
  if (!creditOnJob(i)) return false;
  if (!partLines(i.lines).some((l) => l.billable !== false)) return false;
  if (i.heldBySent === true) return false;
  return true;
}

/** The row's one slate line: before filing, on a row that offers the door; after, once none bills. */
export function returnRowLine(i: CreditRowInput): string | null {
  if (rowOffersFileWithItsBill(i)) return NOT_FILED_WITH_ITS_BILL;
  if (!creditOnJob(i)) return null;
  const parts = partLines(i.lines);
  return parts.length && parts.every((l) => l.billable === false) ? LINES_OFF_THE_BILL : null;
}
