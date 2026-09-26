/**
 * FINISH JOB SAYS THE TRUTH AT THE BUTTON (Connected North Phase 1; Tao Zhu, J-002).
 *
 * Tao's job bills with progress payments: a $10,000 deposit and INV-00028, both paid. Sept 8-9 is
 * on no bill - 19.5 hours. Finish Job on it marked the job complete, billed nothing, said "It bills
 * with progress payments", and those hours dropped off the job card, My Day, the billing board and
 * the portal. The work that is not billed is named - at the button before the press, and in the
 * sentence after it - from the same arithmetic the Unbilled card and the progress report use
 * (unbilledWorkForJob).
 */
import { formatCurrency } from "./utils";

export type NotBilled = {
  hours: number;
  laborAmount: number;
  billsCount: number;
  billsBilled: number;
  /** Takes from stock no invoice holds (Shop Stock, Phase 3), and what they would bill. */
  stockCount?: number;
  stockBilled?: number;
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** "19.5 h ($2,437.50)", "19.5 h and 2 bills ($2,911.12)", or null when everything is billed. */
export function notBilledWords(u: NotBilled | null | undefined): string | null {
  if (!u) return null;
  const hours = r2(Number(u.hours) || 0);
  const bills = Math.max(0, Math.round(Number(u.billsCount) || 0));
  const takes = Math.max(0, Math.round(Number(u.stockCount) || 0));
  const parts = [
    hours > 0 ? `${hours} h` : "",
    bills > 0 ? `${bills} ${bills === 1 ? "bill" : "bills"}` : "",
    takes > 0 ? (takes === 1 ? "1 take from stock" : `${takes} takes from stock`) : "",
  ].filter(Boolean);
  if (!parts.length) return null;
  const amount = r2((Number(u.laborAmount) || 0) + (Number(u.billsBilled) || 0) + (Number(u.stockBilled) || 0));
  return `${parts.join(" and ")} (${formatCurrency(amount)})`;
}

/** After the press, on a job billed with progress payments and no open draft to take the work. */
export function finishedWithWorkOffBill(u: NotBilled | null | undefined): string | null {
  const w = notBilledWords(u);
  return w ? `${w} of work on this job is not on a bill yet. Finishing didn't bill it - bill it with Progress Payment → Final on the job's Invoices tab.` : null;
}

/** Before the press, same job: the amber line in the Finish modal. */
export function finishWouldLeaveOffBill(u: NotBilled | null | undefined): string | null {
  const w = notBilledWords(u);
  return w ? `Not billed yet: ${w}. Finishing marks the job complete and does not bill it. To bill it first: Invoices tab → Progress Payment → Final → Actual T&M.` : null;
}
