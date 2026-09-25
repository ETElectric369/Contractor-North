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
 *                         (a DRAFT taking a card → "needsSend": "Send INV-0xx as the bill first?")
 *   two or more         → "ambiguous": named, and the person picks the bill from the Invoices tab
 *
 * "Open" means a non-void bill with money still owed. A draft counts: recording a cash payment on a
 * draft is ordinary (it stays a draft - paidStatus never advances one), and minting a second bill
 * beside a draft that already carries the work is the duplicate this exists to stop. Only a CARD
 * needs a real bill in front of it, so only a card asks for the send.
 */
import { invoiceBalance } from "./invoice-math";

export type JobBillRow = { id: string; invoice_number: string | null; status: string | null; total: number | string | null; amount_paid: number | string | null };

export type JobBillChoice =
  | { kind: "none" }
  | { kind: "land"; bill: JobBillRow; balance: number }
  | { kind: "needsSend"; bill: JobBillRow; balance: number }
  | { kind: "ambiguous"; bills: { number: string; balance: number }[] };

export function jobBillForPayment(rows: readonly JobBillRow[], opts: { card: boolean }): JobBillChoice {
  const open = rows
    .filter((r) => String(r.status ?? "") !== "void")
    .map((r) => ({ r, balance: invoiceBalance(Number(r.total ?? 0), Number(r.amount_paid ?? 0)) }))
    .filter((x) => x.balance > 0.005);
  if (!open.length) return { kind: "none" };
  if (open.length > 1) return { kind: "ambiguous", bills: open.map((x) => ({ number: x.r.invoice_number ?? "an invoice", balance: x.balance })) };
  const [{ r, balance }] = open;
  if (opts.card && String(r.status ?? "") === "draft") return { kind: "needsSend", bill: r, balance };
  return { kind: "land", bill: r, balance };
}
