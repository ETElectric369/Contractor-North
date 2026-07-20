import "server-only";
import { recalcTotals } from "@/lib/invoice-math";
import { reportError } from "@/lib/observe";

/** Recompute an invoice's totals from items + payments, and auto-advance paid status.
 *  Applied customer credits (disposition "credit", still open) count toward amount_paid
 *  the same as a payment — a credit on account reduces the balance the customer owes —
 *  so they're folded into the payments side here and survive every recalc. (Refunds are
 *  a cash-OUT, tracked separately in `collected`, and never reduce this balance.)
 *
 *  THE single definition of amount_paid. It lives here, not in billing/actions.ts, so the
 *  Stripe webhook (a route handler on the service client — it can't import a "use server"
 *  module's private helper) settles an online payment through the SAME math. It used to
 *  carry its own payments-only sum and blind-write `amount_paid`, which ERASED any posted
 *  credit: a $200 credit + an $800 card payment on a $1,000 invoice came back as $800 paid
 *  / status partial, so the customer got dunned for the credit and could pay it twice.
 *
 *  Works with any client (RLS-scoped user client or the service client) — the credits
 *  SELECT needs whatever visibility the caller already has on the invoice. */
export async function recalcInvoice(supabase: any, invoiceId: string): Promise<void> {
  const [{ data: items }, { data: pays }, { data: credits }, { data: inv }] = await Promise.all([
    supabase.from("invoice_items").select("line_total").eq("invoice_id", invoiceId),
    supabase.from("payments").select("amount").eq("invoice_id", invoiceId),
    supabase.from("customer_credits").select("amount").eq("invoice_id", invoiceId).eq("disposition", "credit").eq("status", "open"),
    supabase.from("invoices").select("tax_rate, status").eq("id", invoiceId).single(),
  ]);

  const { subtotal, tax, total, amountPaid, status } = recalcTotals(
    (items ?? []).map((i: any) => Number(i.line_total ?? 0)),
    [
      ...(pays ?? []).map((p: any) => Number(p.amount ?? 0)),
      ...(credits ?? []).map((c: any) => Number(c.amount ?? 0)),
    ],
    Number(inv?.tax_rate ?? 0),
    inv?.status ?? "draft",
  );

  const { error } = await supabase
    .from("invoices")
    .update({ subtotal, tax, total, amount_paid: amountPaid, status })
    .eq("id", invoiceId);
  // If this silently fails the invoice shows stale totals/status (wrong balance,
  // wrong paid state) — surface it rather than letting the money figures drift.
  if (error) reportError("recalcInvoice", error, { invoiceId });
}
