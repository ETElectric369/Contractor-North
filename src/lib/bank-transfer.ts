import { paymentMethodKey } from "@/lib/payment-method";
import { formatCurrency, formatDate } from "@/lib/utils";

/**
 * A BANK TRANSFER ON ITS WAY (audit v994 BK1-BK3, migration 0338).
 *
 * A card settles inside Stripe Checkout. A bank debit (ACH, us_bank_account) does not: Checkout
 * finishes as completed(UNPAID), the money moves for 3-5 business days, and only then does
 * checkout.session.async_payment_succeeded (or _failed) arrive. This module is everything the app
 * knows about that in-between, in one place:
 *
 *   · which Checkout sessions ARE bank debits, and so which payment method a booked one gets
 *     (BK2: every Stripe payment used to be booked 'card', so a bank debit read "Card" and "Card
 *     fee" on the invoice, the PDF, the statement and the owner's fees);
 *   · the pending marker (pending_bank_transfers) the webhook writes when a debit starts and
 *     resolves when it clears or fails - NEVER money, never read by a total (see 0338);
 *   · the one read every door uses to ask "is a transfer already on its way for this invoice?"
 *     (/i, /api/pay, the reminder cron, the office's invoice page).
 *
 * A DATABASE WITHOUT 0338 HAS NO TRANSFERS ON THEIR WAY. Bank Transfer is off everywhere until
 * 0338 is applied (Erik, 2026-09-24), so a missing table answers "none", exactly the truth, and a
 * card payment is never held up by it.
 */

export type BankTransferStatus = "pending" | "cleared" | "failed";

export type PendingTransfer = { id: string; invoiceId: string; amount: number; startedAt: string };

type Sb = { from: (t: string) => any };

/** 42P01 undefined_table / PostgREST PGRST205: the database has not reached 0338 yet. */
export function isMissingTransfers(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? "");
  const msg = String((err as { message?: string })?.message ?? "");
  return code === "42P01" || code === "PGRST205" || (/pending_bank_transfers/i.test(msg) && /does not exist|could not find/i.test(msg));
}

/**
 * IS THIS CHECKOUT A BANK DEBIT? /api/pay pins ONE method per door (payment_method_types is
 * ["card"] or ["us_bank_account"]) and stamps metadata.pay_method with the door. The types are the
 * fact Stripe charged by, so they win; the metadata is the fallback for a session that does not
 * carry them.
 */
export function isBankCheckout(session: {
  payment_method_types?: string[] | null;
  metadata?: Record<string, string> | null;
}): boolean {
  const types = (session?.payment_method_types ?? []).map((t) => String(t));
  if (types.length) return types.includes("us_bank_account") && !types.includes("card");
  return session?.metadata?.pay_method === "bank";
}

/** The payments.method KEY a Checkout payment is booked under (0287): 'ach' for a bank debit,
 *  'card' for everything else. Tap to Pay never comes through here; it is always a card. */
export function checkoutPaymentMethod(session: Parameters<typeof isBankCheckout>[0]): "ach" | "card" {
  return paymentMethodKey(isBankCheckout(session) ? "us_bank_account" : "card") as "ach" | "card";
}

/**
 * THE ONE READ: transfers still on their way for these invoices, keyed by invoice id. Org-scoped by
 * the caller's `orgId` (the service role reads here too, and it bypasses RLS). Returns `problem`
 * rather than guessing when the read fails for any reason but the table not existing yet, so a
 * caller can fail CLOSED (the reminder cron skips; /api/pay refuses a second checkout).
 */
export async function pendingTransfers(
  supabase: Sb,
  orgId: string,
  invoiceIds?: string[],
): Promise<{ byInvoice: Map<string, PendingTransfer[]>; problem: string | null }> {
  const byInvoice = new Map<string, PendingTransfer[]>();
  if (invoiceIds && !invoiceIds.length) return { byInvoice, problem: null };
  let q = supabase
    .from("pending_bank_transfers")
    .select("id, invoice_id, amount, started_at")
    .eq("org_id", orgId)
    .eq("status", "pending");
  if (invoiceIds) q = q.in("invoice_id", invoiceIds);
  const { data, error } = await q.limit(1000);
  if (error) return isMissingTransfers(error) ? { byInvoice, problem: null } : { byInvoice, problem: "the bank transfers on their way could not be read" };
  for (const r of (data ?? []) as { id: string; invoice_id: string; amount: number | string; started_at: string }[]) {
    const key = String(r.invoice_id);
    const list = byInvoice.get(key) ?? [];
    list.push({ id: String(r.id), invoiceId: key, amount: Math.round((Number(r.amount) || 0) * 100) / 100, startedAt: String(r.started_at) });
    byInvoice.set(key, list);
  }
  return { byInvoice, problem: null };
}

/** "A $2,830.89 bank transfer started Sep 25, 2026 is on its way." for one or more pending debits,
 *  dated in the ORG's zone when the caller knows it. */
export function transferOnItsWaySentence(list: PendingTransfer[], tz?: string): string {
  const total = Math.round(list.reduce((s, t) => s + t.amount, 0) * 100) / 100;
  const first = [...list].sort((a, b) => a.startedAt.localeCompare(b.startedAt))[0];
  const when = first ? ` started ${tz ? formatDate(first.startedAt, tz) : formatDate(first.startedAt)}` : "";
  return list.length === 1
    ? `A ${formatCurrency(total)} bank transfer${when} is on its way.`
    : `${list.length} bank transfers totalling ${formatCurrency(total)}${when ? `, the first${when},` : ""} are on their way.`;
}

/**
 * THE DEBIT STARTED (checkout.session.completed with payment_status 'unpaid' on a bank door).
 * The caller has already checked the org owns the connected account and the invoice is the org's.
 *
 * Returns what happened, so the caller tells the office only once:
 *   'noted'        a new pending row;
 *   'known'        this PaymentIntent already has a row (a retried event, or its success/failure
 *                  arrived first - Stripe does not promise order); nothing changes;
 *   'already_paid' a payments row already carries this PaymentIntent: it cleared before this
 *                  event arrived, so there is nothing pending to say;
 *   'no_table'     the database has not reached 0338 (nothing can be pending there);
 *   'failed'       the write failed; the caller reports it.
 */
export async function noteTransferStarted(
  supabase: Sb,
  t: { orgId: string; invoiceId: string; paymentIntent: string; checkoutSession: string | null; amount: number },
): Promise<{ outcome: "noted" | "known" | "already_paid" | "no_table" | "failed"; error?: unknown }> {
  const { data: booked, error: bookedErr } = await supabase
    .from("payments")
    .select("id")
    .eq("org_id", t.orgId)
    .eq("stripe_payment_intent", t.paymentIntent)
    .limit(1);
  if (bookedErr) return { outcome: "failed", error: bookedErr };
  if ((booked ?? []).length) return { outcome: "already_paid" };
  if (!(t.amount > 0)) return { outcome: "failed", error: new Error("a bank transfer with no amount") };
  const { data, error } = await supabase
    .from("pending_bank_transfers")
    .upsert(
      {
        org_id: t.orgId,
        invoice_id: t.invoiceId,
        payment_intent: t.paymentIntent,
        checkout_session: t.checkoutSession,
        amount: Math.round(t.amount * 100) / 100,
        status: "pending",
      },
      { onConflict: "payment_intent", ignoreDuplicates: true },
    )
    .select("id");
  if (error) return isMissingTransfers(error) ? { outcome: "no_table" } : { outcome: "failed", error };
  return { outcome: (data ?? []).length ? "noted" : "known" };
}

/**
 * THE DEBIT CLEARED OR FAILED. Moves a pending row to its end, idempotently: only a row still
 * 'pending' moves, so a retried event changes nothing. When there is NO row (the end arrived before
 * the start, or the start was never recorded), one is written already resolved, so a late
 * completed(unpaid) finds it ('known') and can never mark money pending that has already landed
 * or failed.
 *
 *   'resolved'  a pending row moved (the caller tells the office on 'failed');
 *   'recorded'  no row existed; one was written already resolved;
 *   'already'   the row had already reached an end;
 *   'no_table' / 'failed' as above.
 */
export async function resolveTransfer(
  supabase: Sb,
  t: { orgId: string; invoiceId: string; paymentIntent: string; checkoutSession: string | null; amount: number; status: Exclude<BankTransferStatus, "pending"> },
): Promise<{ outcome: "resolved" | "recorded" | "already" | "no_table" | "failed"; error?: unknown }> {
  const now = new Date().toISOString();
  const { data: moved, error } = await supabase
    .from("pending_bank_transfers")
    .update({ status: t.status, resolved_at: now })
    .eq("org_id", t.orgId)
    .eq("payment_intent", t.paymentIntent)
    .eq("status", "pending")
    .select("id");
  if (error) return isMissingTransfers(error) ? { outcome: "no_table" } : { outcome: "failed", error };
  if ((moved ?? []).length) return { outcome: "resolved" };
  if (!(t.amount > 0)) return { outcome: "already" };
  const { data: wrote, error: insErr } = await supabase
    .from("pending_bank_transfers")
    .upsert(
      {
        org_id: t.orgId,
        invoice_id: t.invoiceId,
        payment_intent: t.paymentIntent,
        checkout_session: t.checkoutSession,
        amount: Math.round(t.amount * 100) / 100,
        status: t.status,
        resolved_at: now,
      },
      { onConflict: "payment_intent", ignoreDuplicates: true },
    )
    .select("id");
  if (insErr) return isMissingTransfers(insErr) ? { outcome: "no_table" } : { outcome: "failed", error: insErr };
  return { outcome: (wrote ?? []).length ? "recorded" : "already" };
}

/** Debits pending longer than this are said to the office (once): ACH takes 3-5 business days. */
export const STALE_TRANSFER_DAYS = 7;

/**
 * THE DEBITS THAT HAVE BEEN "ON THEIR WAY" TOO LONG (daily cron, service role, every org). A
 * pending row that outlives a week means the async event never reached us - most likely because it
 * is not subscribed on the connected-accounts webhook - and the invoice may be sitting open over
 * money that already landed. Each is returned once: the caller tells the office, then stamps it.
 */
export async function staleTransfers(
  supabase: Sb,
  now: Date = new Date(),
): Promise<{ rows: { id: string; orgId: string; invoiceId: string; amount: number; startedAt: string }[]; problem: string | null }> {
  const cutoff = new Date(now.getTime() - STALE_TRANSFER_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("pending_bank_transfers")
    .select("id, org_id, invoice_id, amount, started_at")
    .eq("status", "pending")
    .is("stale_alerted_at", null)
    .lt("started_at", cutoff)
    .limit(200);
  if (error) return isMissingTransfers(error) ? { rows: [], problem: null } : { rows: [], problem: "the bank transfers could not be read" };
  return {
    rows: ((data ?? []) as any[]).map((r) => ({
      id: String(r.id),
      orgId: String(r.org_id),
      invoiceId: String(r.invoice_id),
      amount: Number(r.amount) || 0,
      startedAt: String(r.started_at),
    })),
    problem: null,
  };
}
