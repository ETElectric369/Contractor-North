"use server";

/**
 * THE SEND-AGAIN NOTICE CAN BE PUT AWAY (Erik, 2026-11-22; migration 0419).
 *
 *   "I know its been revised and I don't want to send it again, can we put a dismiss button on
 *    those please" ... "For Revised, lets mark it Sent - Revised with the send again alarm
 *    dismissible"
 *
 * Two doors, both the office's (guarded as setInvoiceStatus is: requireStaff, and the company named on
 * every read and write). Dismiss stamps `invoices.resend_dismissed_at`; the rule (lib/invoice-revision,
 * customerHoldsOlderCopy step (e)) counts it only while it is later than sent_at, so the next send
 * re-arms the notice with nothing to clear. Bring the Notice Back sets it null.
 *
 * NEITHER IS A REVISION AND NEITHER IS A SEND: nothing here calls stampInvoiceRevised or touches
 * sent_at. setInvoiceStatus writes no activity line, so neither does this.
 *
 * A "use server" file exports only async functions (types are fine).
 */
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";
import { isUuid } from "@/lib/actions/resolve-id";
import { dbError } from "@/lib/db-error";
import { customerHoldsOlderCopy } from "@/lib/invoice-revision";

export type ResendNoticeResult = { ok: true } | { ok: false; error: string };

/** Everything the notice rule reads, and nothing more (the projection law). */
const NOTICE_COLUMNS = "id, status, sent_at, revised_at, total, amount_paid, sent_total, resend_dismissed_at, payments(paid_at)";

type NoticeRow = {
  id: string;
  status: string | null;
  sent_at: string | null;
  revised_at: string | null;
  total: number | string | null;
  amount_paid: number | string | null;
  sent_total: number | string | null;
  resend_dismissed_at: string | null;
  payments?: { paid_at?: string | null }[] | null;
};

const NOT_FOUND = "That invoice couldn't be found.";

async function readNoticeRow(invoiceId: string): Promise<{ ok: false; error: string } | { ok: true; supabase: any; orgId: string; row: NoticeRow }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This action is staff-only." };
  if (!ctx.orgId) return { ok: false, error: "Your sign-in isn't attached to a company yet." };
  if (typeof invoiceId !== "string" || !isUuid(invoiceId)) return { ok: false, error: NOT_FOUND };
  const supabase = ctx.supabase;
  const { data, error } = await supabase.from("invoices").select(NOTICE_COLUMNS).eq("id", invoiceId).eq("org_id", ctx.orgId).maybeSingle();
  if (error) return { ok: false, error: dbError(error) };
  if (!data) return { ok: false, error: NOT_FOUND };
  return { ok: true, supabase, orgId: ctx.orgId, row: data as NoticeRow };
}

function revalidate(invoiceId: string) {
  revalidatePath("/billing");
  revalidatePath(`/billing/${invoiceId}`);
}

/**
 * Dismiss: the notice is quiet until this bill is sent again. When the notice is not standing (the
 * rule says so, with whatever dismissal is already there), nothing is written and the answer is ok:
 * the row the person tapped has already gone quiet, and a second stamp would only move the date.
 */
export async function dismissResendNotice(invoiceId: string): Promise<ResendNoticeResult> {
  const read = await readNoticeRow(invoiceId);
  if (!read.ok) return read;
  const { supabase, orgId, row } = read;
  const standing =
    String(row.status ?? "") !== "void" &&
    customerHoldsOlderCopy(row.sent_at, row.revised_at, {
      total: row.total as number | null,
      amountPaid: row.amount_paid as number | null,
      sentTotal: row.sent_total as number | null,
      paidAt: (row.payments ?? []).map((p) => p.paid_at),
      resendDismissedAt: row.resend_dismissed_at,
    });
  if (!standing) return { ok: true };
  const { data: wrote, error } = await supabase
    .from("invoices")
    .update({ resend_dismissed_at: new Date().toISOString() })
    .eq("id", row.id)
    .eq("org_id", orgId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!wrote?.length) return { ok: false, error: "The notice wasn't dismissed: nothing was saved. Reload the page and try again." };
  revalidate(row.id);
  return { ok: true };
}

/** Bring the Notice Back: the dismissal is cleared, so the rule decides on its own again. */
export async function restoreResendNotice(invoiceId: string): Promise<ResendNoticeResult> {
  const read = await readNoticeRow(invoiceId);
  if (!read.ok) return read;
  const { supabase, orgId, row } = read;
  if (row.resend_dismissed_at == null) return { ok: true };
  const { data: wrote, error } = await supabase
    .from("invoices")
    .update({ resend_dismissed_at: null })
    .eq("id", row.id)
    .eq("org_id", orgId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!wrote?.length) return { ok: false, error: "The notice wasn't brought back: nothing was saved. Reload the page and try again." };
  revalidate(row.id);
  return { ok: true };
}
