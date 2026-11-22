import "server-only";
import { markInvoiceSent } from "@/lib/invoice-sent-stamp";
import { recalcInvoice } from "@/lib/invoice-recalc";
import { outgoingDraftFirst } from "@/lib/payment-request";
import { revalidateMoney } from "@/lib/revalidate-money";
import { sendFirstQuestion } from "@/lib/pay-door-words";

/**
 * A PAY DOOR NEVER SENDS A DRAFT ON ITS OWN (Connected North Phase 1, "Stop the silent money").
 *
 * Tap to Pay, the Pay Now QR and the job header's Pay Now all collect on a BILL. A draft is not a
 * bill until a person sends it (INV-069: a sheet opened and closed sent a $6,412 invoice Erik was
 * still building; INV-078: the QR would have sent Andrew's running draft on the spot). So each of
 * those doors asks first - "Send INV-078 as the bill first?" - and only on the person's yes does it
 * come here: the ONE send stamp (markInvoiceSent: status + sent_at, checked), then the recalc (a
 * draft carrying $6,760 of payments lands on 'partial', not 'sent'), then every money screen told.
 *
 * needsSendRefusal is what a door hands back while there is no yes yet; sendDraftForPayment is the yes.
 */
export type NeedsSend = { ok: false; needsSend: true; invoiceNumber: string | null; error: string };

export function needsSendRefusal(invoiceNumber: string | null | undefined): NeedsSend {
  return { ok: false, needsSend: true, invoiceNumber: invoiceNumber ?? null, error: sendFirstQuestion(invoiceNumber) };
}

export async function sendDraftForPayment(
  supabase: { from: (t: string) => any },
  invoiceId: string,
): Promise<{ ok: boolean; error?: string }> {
  // NOTHING IS SENT STALE (cn-v1177): the draft's money is brought up to date immediately before the
  // flip (the recalc re-resolves what it takes off for the job's payment requests), and a recalc that
  // could not land sends nothing.
  // The bill going out comes first: the job's other drafts give up their derived credit to it
  // (lib/payment-request outgoingDraftFirst).
  if (!(await outgoingDraftFirst(supabase, invoiceId))) {
    return { ok: false, error: "This invoice couldn't be brought up to date just now, so it wasn't sent and there's nothing for them to pay yet. Try again in a moment." };
  }
  const sent = await markInvoiceSent(supabase, invoiceId);
  if (!sent.ok) return { ok: false, error: sent.error ?? "Couldn't send this invoice, so there's nothing for them to pay yet." };
  await recalcInvoice(supabase, invoiceId);
  revalidateMoney(invoiceId);
  return { ok: true };
}
