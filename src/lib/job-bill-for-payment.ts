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

export type JobBillRow = { id: string; invoice_number: string | null; status: string | null; total: number | string | null; amount_paid: number | string | null };

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
  const open = rows
    .filter((r) => String(r.status ?? "") !== "void")
    .map((r) => ({ r, balance: invoiceBalance(Number(r.total ?? 0), Number(r.amount_paid ?? 0)) }))
    .filter((x) => x.balance > 0.005);
  if (!open.length) return { kind: "none" };
  if (open.length > 1) return { kind: "ambiguous", bills: open.map((x) => ({ number: x.r.invoice_number ?? "an invoice", balance: x.balance })) };
  const [{ r, balance }] = open;
  const amount = Number(opts.amount);
  const paysItAll = Number.isFinite(amount) && amount > 0 && amount >= balance - 0.005;
  if (String(r.status ?? "") === "draft" && (opts.card || paysItAll)) return { kind: "needsSend", bill: r, balance };
  return { kind: "land", bill: r, balance };
}
