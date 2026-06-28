import { revalidatePath } from "next/cache";

/**
 * THE money nerve: after any invoice/payment/draw mutation, refresh every surface that shows
 * money totals so they can't disagree — the billing board, the invoice page, the My Day money
 * line (getMoneyPipeline), and the money reports. They're all force-dynamic, so re-running them
 * is cheap and can never show a stale total. Call this from every money mutation instead of a
 * lone revalidatePath("/billing") — that was the recurring "My Day lags ~45s" / board-vs-detail
 * drift class. Must be invoked from a Server Action / Route Handler (where revalidatePath is legal).
 */
export function revalidateMoney(invoiceId?: string | null) {
  revalidatePath("/billing");
  if (invoiceId) revalidatePath(`/billing/${invoiceId}`);
  revalidatePath("/planner"); // My Day money line
  revalidatePath("/analytics");
  revalidatePath("/tax-report");
}
