import { invoiceAmount } from "@/lib/invoice-amount";

/**
 * THE AMOUNT ON EVERY INVOICE ROW — the billing board's four lanes and All Invoices, a
 * customer's Invoices tab, a job's Invoices tab. One component, so the words can't drift apart
 * the way the job tab's bare total did (it printed the TOTAL where the board printed the BALANCE).
 *
 * The line reads "**$1,558.62** due of $8,318.62": the figure bold, the total inline beside it
 * (Erik, d103cb9f), and what has been paid underneath.
 *
 * THE PHONE RULE (cn-v983): a row's right-hand column is shrink-0, so anything wide there
 * squeezes the min-w-0 left column — the customer, the invoice number, the Overdue flag — down to
 * nothing (at 393px a partly paid row left the customer 0-16px wide). So there are two halves:
 *   · <InvoiceAmount>       the right-hand column, from `sm` up;
 *   · <InvoiceAmountDetail> the same line under the row's left-hand text, below `sm`, where it
 *                           sits on its own line and the paid note truncates before the line does.
 * Put both in every row; exactly one shows at any width. Pass the row's `status` wherever the
 * list can hold a void invoice: a void bill reads "Void · was $T", never "due".
 */
export function InvoiceAmount({ total, paid, overdue = false, status }: { total: number | null | undefined; paid: number | null | undefined; overdue?: boolean; status?: string | null }) {
  const a = invoiceAmount(total, paid, status);
  return (
    <span className="hidden flex-col items-end text-right sm:flex">
      <span className="whitespace-nowrap text-sm">
        <span className={`font-medium ${overdue ? "text-red-700" : "text-slate-900"}`}>{a.due}</span>{" "}
        <span className="text-slate-500">{a.against}</span>
      </span>
      {a.note && <span className="whitespace-nowrap text-[11px] text-slate-500">{a.note}</span>}
    </span>
  );
}

/** The same line, on a phone, under the row's left-hand text. */
export function InvoiceAmountDetail({ total, paid, overdue = false, status }: { total: number | null | undefined; paid: number | null | undefined; overdue?: boolean; status?: string | null }) {
  const a = invoiceAmount(total, paid, status);
  return (
    <div className="flex min-w-0 items-baseline gap-1 text-xs sm:hidden">
      <span className="shrink-0 whitespace-nowrap">
        <span className={`font-semibold ${overdue ? "text-red-700" : "text-slate-900"}`}>{a.due}</span>{" "}
        <span className="text-slate-500">{a.against}</span>
      </span>
      {a.note && <span className="min-w-0 truncate text-[11px] text-slate-500">· {a.note}</span>}
    </div>
  );
}
