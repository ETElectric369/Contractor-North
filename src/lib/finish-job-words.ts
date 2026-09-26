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
import { isDrawKind } from "./invoice-math";
import type { CardDoor } from "./actuals-draw";

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

/**
 * A TIME & MATERIAL JOB'S FINISH, SAID BEFORE THE PRESS (Erik, 2026-09-26). Finishing builds the
 * bill as a draft through the Overview card's own door (unbilledCardDoor), so the sentence is the
 * door's: what gets built, for how much, and that nothing is sent. `blocked`: the press can't build
 * it (a draft for set amounts can't take the work) - the modal opens that draft or finishes without
 * billing. `builds`: the press writes or updates a draft. `doc`: what that draft is - the Final (a
 * progress payment, on a job billed with draws) or a plain invoice. `lump`: the deposit not yet
 * taken off a bill, so a deposit that covers the work is said with its figures, never "yet".
 */
export function finalFinishWords(
  door: NonNullable<CardDoor>,
  draft: { number: string | null; kind: string } | null,
  work: number,
  lump = 0,
): { line: string; blocked: boolean; builds: boolean; doc: "final" | "invoice" | null } {
  const name = draft?.number ?? "the open draft";
  if (door.kind === "open") {
    return {
      line: `${name} is still a draft for set amounts, not hours and receipts, so the ${formatCurrency(work)} of work not yet billed can't go on it. Open it to send it (or delete it), then bill the work.`,
      blocked: true,
      builds: false,
      doc: null,
    };
  }
  if (door.kind === "covered") return { line: `${depositCoversWords(work, lump)} Finishing marks the job complete.`, blocked: false, builds: false, doc: null };
  if (door.kind === "add") {
    const asFinal = !!draft && isDrawKind(draft.kind);
    return {
      line: `Finishing adds the ${formatCurrency(door.amount)} of work not yet billed to ${name}${asFinal ? " as the Final" : ""} (still a draft) and marks the job complete. Nothing is sent.`,
      blocked: false,
      builds: true,
      doc: asFinal ? "final" : "invoice",
    };
  }
  const what = door.kind === "draw" ? "the Final" : "an invoice";
  return {
    line: `Finishing starts ${what} for ${formatCurrency(door.amount)} of work not yet billed, as a draft, and marks the job complete. Nothing is sent.${door.note ? ` ${door.note}` : ""}`,
    blocked: false,
    builds: true,
    doc: door.kind === "draw" ? "final" : "invoice",
  };
}

/**
 * A DEPOSIT THAT COVERS THE WORK, ON A JOB THAT IS FINISHING (review, 2026-09-26). No bill is built
 * (the draw door refuses one whose net is $0), so the sentence carries the figures: the work, the
 * deposit, and what the deposit is over the work - money to settle with the customer, never left
 * behind a "nothing new to bill yet" on a job with no later bill.
 */
export function depositCoversWords(work: number, lump: number): string {
  const left = Math.round((lump - work) * 100) / 100;
  const base = `The ${formatCurrency(lump)} deposit not yet taken off a bill covers the ${formatCurrency(work)} of work not on a bill, so no bill is built.`;
  return left > 0.005 ? `${base} The deposit is ${formatCurrency(left)} more than the work: settle the difference with the customer.` : base;
}
