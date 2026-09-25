import { sendPushToProfiles, orgStaffIds } from "@/lib/push";
import { reportError } from "@/lib/observe";
import { formatCurrency, formatDate } from "@/lib/utils";
import { STALE_TRANSFER_DAYS, staleTransfers } from "@/lib/bank-transfer";

/**
 * THE DAILY CRON'S HALF OF 0338 (audit v994 BK3): every bank debit that has been "on its way" for
 * more than a week is said to that org's office once, and to the ops log, then stamped so it is not
 * said again tomorrow. Service role, every org; each push goes only to the org the row belongs to,
 * and the invoice number is read inside that same org.
 *
 * NEVER RESOLVES ANYTHING. Whether the money landed is Stripe's to say (the async events) or a
 * person's to check in the Stripe dashboard; a machine guessing "it must have cleared" would book
 * money nobody saw.
 */
export async function tellStaleBankTransfers(supabase: any, now: Date = new Date()): Promise<{ told: number } | { skipped: string }> {
  const { rows, problem } = await staleTransfers(supabase, now);
  if (problem) return { skipped: problem };
  let told = 0;
  for (const t of rows) {
    const { data: inv } = await supabase
      .from("invoices")
      .select("invoice_number")
      .eq("id", t.invoiceId)
      .eq("org_id", t.orgId)
      .maybeSingle();
    const number = (inv as { invoice_number?: string | null } | null)?.invoice_number;
    reportError(
      "bank-transfer-stale",
      new Error(`a bank transfer has been pending more than ${STALE_TRANSFER_DAYS} days`),
      { orgId: t.orgId, invoiceId: t.invoiceId, transferId: t.id },
    );
    await sendPushToProfiles(await orgStaffIds(t.orgId), "invoice_paid", {
      title: "Bank transfer still not cleared",
      body: `${formatCurrency(t.amount)} by bank transfer on ${number || "an invoice"}, started ${formatDate(t.startedAt)}, has not cleared or failed after ${STALE_TRANSFER_DAYS} days. Check it in your Stripe dashboard before recording anything by hand.`,
      url: `/billing/${t.invoiceId}`,
    });
    // Said once. A zero-row stamp is a 204 (the silent-write law): the ops log hears, and the
    // worst case is the office hearing it again tomorrow.
    const { data: stamped, error } = await supabase
      .from("pending_bank_transfers")
      .update({ stale_alerted_at: now.toISOString() })
      .eq("id", t.id)
      .eq("org_id", t.orgId)
      .select("id");
    if (error || !stamped?.length) reportError("bank-transfer-stale-stamp", error ?? new Error("zero-row stamp"), { transferId: t.id });
    told += 1;
  }
  return { told };
}
