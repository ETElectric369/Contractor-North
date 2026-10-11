import type { SupabaseClient } from "@supabase/supabase-js";
import { dbError } from "@/lib/db-error";

/**
 * TAKE A CREDIT BACK (Erik, 2026-10-10, INV-089). He posted a $165 account credit to stand in for a
 * discount, and there was no door back: the credit sat on the bill as "paid" with no way to undo it
 * but a database hand.
 *
 * TWO DOORS, BECAUSE THE MONEY MAY BE REAL (the skeptic's probe): a credit on an invoice may be the
 * customer's own overpayment, applied here from another bill. So "Take It Back" never destroys it —
 * it RETURNS the credit to the customer's account (invoice_id null; the invoice it came off is
 * recomputed by the caller and owed again), where it can be applied to the right bill. "Delete This
 * Credit" is the second, explicit door, for a credit that should never have existed: open, posted
 * by the office (not a card refund — Stripe's record), and already OFF every invoice.
 *
 * Every write is pinned to the row as it was read (the move race applyCustomerCredit guards) and
 * read back by id (silent-write law). One rule taking the client it is given; billing/actions wraps
 * it with the staff gate, the recalc, the revision stamp and the revalidation.
 */
type CreditRow = { amount: unknown; disposition: string | null; status: string | null; invoice_id: string | null; stripe_refund_id: string | null };

async function readOpenOfficeCredit(sb: SupabaseClient, creditId: string): Promise<{ ok: true; row: CreditRow } | { ok: false; error: string }> {
  const { data: c, error } = await sb
    .from("customer_credits")
    .select("id, amount, disposition, status, invoice_id, stripe_refund_id")
    .eq("id", creditId)
    .maybeSingle();
  if (error) return { ok: false, error: dbError(error) };
  if (!c) return { ok: false, error: "Credit not found." };
  const row = c as CreditRow;
  if (row.status !== "open") return { ok: false, error: "That credit is already closed out." };
  if (row.disposition !== "credit") return { ok: false, error: "That one is flagged for a refund — mark it refunded instead." };
  if (row.stripe_refund_id) return { ok: false, error: "That credit is a card refund's record — it stays." };
  return { ok: true, row };
}

export type WithdrawResult = { ok: true; invoiceId: string; amount: number } | { ok: false; error: string };

/** Return a credit from the invoice it sits on to the customer's account. */
export async function withdrawCredit(sb: SupabaseClient, creditId: string): Promise<WithdrawResult> {
  const read = await readOpenOfficeCredit(sb, creditId);
  if (!read.ok) return read;
  const origin = read.row.invoice_id;
  if (!origin) return { ok: false, error: "That credit is already on the account, not on an invoice." };
  const moved = await sb
    .from("customer_credits")
    .update({ invoice_id: null })
    .eq("id", creditId)
    .eq("invoice_id", origin) // pinned to where it was read: a move that landed in between is not undone blind
    .eq("status", "open")
    .select("id");
  if (moved.error) return { ok: false, error: dbError(moved.error) };
  if (!moved.data?.length) return { ok: false, error: "That credit moved before this landed — reload and look again." };
  return { ok: true, invoiceId: origin, amount: Number(read.row.amount) || 0 };
}

export type DeleteCreditResult = { ok: true; amount: number } | { ok: false; error: string };

/** Delete an office credit that is off every invoice — the one that should never have existed. */
export async function deleteCredit(sb: SupabaseClient, creditId: string): Promise<DeleteCreditResult> {
  const read = await readOpenOfficeCredit(sb, creditId);
  if (!read.ok) return read;
  if (read.row.invoice_id) return { ok: false, error: "That credit is on an invoice — Take It Back first, then delete it." };
  const gone = await sb.from("customer_credits").delete().eq("id", creditId).is("invoice_id", null).eq("status", "open").select("id");
  if (gone.error) return { ok: false, error: dbError(gone.error) };
  if (!gone.data?.length) return { ok: false, error: "That credit changed before this landed — reload and look again." };
  return { ok: true, amount: Number(read.row.amount) || 0 };
}
