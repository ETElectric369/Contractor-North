/**
 * WHICH BILL DOES A PAYMENT TAKEN FROM THE JOB PAGE GO ON? (Connected North Phase 1)
 *
 * The job header's Pay Now / Record Payment used to MINT a fresh one-line invoice for whatever was
 * typed - on a job whose bill was already out. J-052 has INV-074 sent and open for $624.49; paying
 * from its header would have written a second invoice for the same work, and the customer would owe
 * both. So the job's open bill is the door:
 *
 *   no open bill        → "none": mint the settle-up bill, as before (a doorstep job with no bill yet)
 *   one open bill       → "land": the payment goes on it
 *                         (a DRAFT taking a card, or a payment that pays ALL of a draft →
 *                          "needsSend": "Send INV-0xx as the bill first?")
 *   two or more         → "ambiguous": named, and the person picks the bill from the Invoices tab
 *
 * "Open" means a non-void bill with money still owed. A draft counts: a DEPOSIT on a draft is
 * ordinary (Erik 7/24; it stays a draft - paidStatus never advances one), and minting a second bill
 * beside a draft that already carries the work is the duplicate this exists to stop. A CARD needs a
 * real bill in front of it, so a card asks for the send. So does a payment that covers the whole
 * draft: landed silently, it would leave a draft reading $0 owed that no screen ever calls paid -
 * the toast says "Paid", the badge says Draft. The settle-up bill this replaced was always SENT for
 * exactly that reason, so the person is asked instead, and a partial still just lands.
 */
import { invoiceBalance } from "./invoice-math";
import { isPrepaymentKind } from "./prepayments";
import type { JobAfterPay } from "./complete-job-when-paid";

export type JobBillRow = {
  id: string;
  invoice_number: string | null;
  status: string | null;
  total: number | string | null;
  amount_paid: number | string | null;
  /** Read where the bill is NAMED (the Get Paid sheet): a payment request is said as one. */
  invoice_kind?: string | null;
};

/**
 * THE JOB'S OPEN BILLS, by the one rule this door and the Get Paid sheet both read: a non-void bill with
 * money still owed, oldest first as handed in. A PAYMENT REQUEST counts (a deposit asked ahead and not yet
 * paid IS a bill the customer holds, and settleUp lands a payment on it when it is the only one); the
 * sheet names it as a payment request, never as the job's bill for the work (cn-v1179).
 */
export function openJobBills<R extends JobBillRow>(rows: readonly R[]): { row: R; balance: number }[] {
  return rows
    .filter((r) => String(r.status ?? "") !== "void")
    .map((row) => ({ row, balance: invoiceBalance(Number(row.total ?? 0), Number(row.amount_paid ?? 0)) }))
    .filter((x) => x.balance > 0.005);
}

/** One open bill as the Get Paid sheet names it: its number, what is left, a draft said as a draft,
 *  a payment request said as one. */
export type OpenBillView = { id: string; number: string | null; balance: number; draft: boolean; request: boolean };

export function openBillViews(rows: readonly JobBillRow[]): OpenBillView[] {
  return openJobBills(rows).map(({ row, balance }) => ({
    id: row.id,
    number: row.invoice_number ?? null,
    balance,
    draft: String(row.status ?? "") === "draft",
    request: isPrepaymentKind(row.invoice_kind),
  }));
}

/**
 * WHAT A RECORDED PAYMENT DID, for the sheet to say (cn-v1179, G3): the bill that took the money (made
 * just now or not; a payment request said as one; a draft said as one: it holds no receipt yet), and what
 * became of the job. `again`: the same tap a moment ago already recorded it; nothing was added.
 */
export type PaymentLanded = {
  number: string | null;
  made: boolean;
  request: boolean;
  draft: boolean;
  /** null: the bill is on no job. */
  job: JobAfterPay | null;
  again?: boolean;
};

export type JobBillChoice =
  | { kind: "none" }
  | { kind: "land"; bill: JobBillRow; balance: number }
  | { kind: "needsSend"; bill: JobBillRow; balance: number }
  | { kind: "ambiguous"; bills: { number: string; balance: number }[] };

export function jobBillForPayment(
  rows: readonly JobBillRow[],
  opts: {
    card: boolean;
    /** What they are paying, when a figure was given: a draft it pays in full asks for the send. */
    amount?: number | null;
  },
): JobBillChoice {
  const open = openJobBills(rows);
  if (!open.length) return { kind: "none" };
  if (open.length > 1) return { kind: "ambiguous", bills: open.map((x) => ({ number: x.row.invoice_number ?? "an invoice", balance: x.balance })) };
  const [{ row: r, balance }] = open;
  const amount = Number(opts.amount);
  const paysItAll = Number.isFinite(amount) && amount > 0 && amount >= balance - 0.005;
  if (String(r.status ?? "") === "draft" && (opts.card || paysItAll)) return { kind: "needsSend", bill: r, balance };
  return { kind: "land", bill: r, balance };
}
