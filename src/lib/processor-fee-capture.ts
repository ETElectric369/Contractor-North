import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { billingEnabled, getStripe } from "@/lib/stripe";
import { feeFromPaymentIntent } from "@/lib/processor-fee";
import { reportError } from "@/lib/observe";

/**
 * READING STRIPE'S REAL FEE ONTO A PAYMENT ROW (migration 0284). Two callers, one reader:
 *
 *   the Stripe webhook, right after it records an online payment, and
 *   the daily automations cron, for every fee the webhook could not read (a Stripe hiccup, a bank
 *   debit whose balance transaction was not there yet, and every online payment recorded before
 *   the column existed).
 *
 * THE PAYMENT COMES FIRST, ALWAYS. This runs after the money is recorded and settled, never before
 * and never in its way: it does not throw, and a failure is written to the ops log and left NULL
 * for the cron to try again. A fee is worth knowing; it is never worth losing or delaying a payment.
 */

export type FeeCapture = "stored" | "not_yet" | "failed";

/**
 * Read one PaymentIntent's fee off the account it lives on and store it on that org's payment row.
 *
 * `account` is the contractor's connected account. Every invoice payment is a direct charge made
 * ON that account (/api/pay and Tap to Pay both pass stripeAccount), so that is the only place the
 * charge and its balance transaction can be read from. Null means the platform account, which is
 * where an event with no `account` came from.
 */
export async function captureProcessorFee(
  supabase: SupabaseClient,
  p: { orgId: string; paymentIntent: string; account: string | null },
): Promise<FeeCapture> {
  const ctx = { orgId: p.orgId, paymentIntent: p.paymentIntent, account: p.account };
  try {
    const pi = await getStripe().paymentIntents.retrieve(
      p.paymentIntent,
      { expand: ["latest_charge.balance_transaction"] },
      p.account ? { stripeAccount: p.account } : undefined,
    );
    const fee = feeFromPaymentIntent(pi);
    // Not known yet is not a failure: NULL stays NULL and the cron asks again tomorrow.
    if (fee === null) return "not_yet";
    const { data: wrote, error } = await supabase
      .from("payments")
      .update({ processor_fee: fee })
      // The org is part of the key, not just the pi_: three companies share this table, and the
      // service client that runs this bypasses RLS.
      .eq("org_id", p.orgId)
      .eq("stripe_payment_intent", p.paymentIntent)
      .select("id");
    if (error) {
      reportError("stripe:fee:store", error, ctx);
      return "failed";
    }
    // A zero-row UPDATE is a 204 (the silent-write law). Stripe knows the fee but no payment row
    // of this org holds the payment, so it went nowhere; say so rather than call it stored.
    if (!wrote?.length) {
      reportError("stripe:fee:no-payment-row", new Error("no payment row of this org holds this payment intent"), ctx);
      return "failed";
    }
    return "stored";
  } catch (e) {
    reportError("stripe:fee:lookup", e, ctx);
    return "failed";
  }
}

/** How many fees one daily run reads. Each is one Stripe call; ET has a handful a week. */
export const FEE_BACKFILL_LIMIT = 25;

export type FeeBackfill = {
  looked_at: number;
  stored: number;
  not_yet: number;
  failed: number;
  /** Online payments whose org no longer has a connected account to read them from. */
  no_account: number;
};

/**
 * THE DAILY SWEEP: every online payment whose fee is still unknown, a bounded number per run,
 * newest first (a fee the webhook just missed is the likeliest to be readable, and an old one that
 * keeps failing must not stand in front of it).
 *
 * The read spans orgs because this is the cron's service client, the same as every other daily
 * step; each payment is then read on ITS OWN org's connected account and written back scoped to
 * that org, so no org's Stripe account is ever asked about another org's money.
 */
export async function backfillProcessorFees(
  supabase: SupabaseClient,
  limit = FEE_BACKFILL_LIMIT,
): Promise<FeeBackfill | { skipped: string }> {
  if (!billingEnabled) return { skipped: "Stripe is not configured" };
  const { data: rows, error } = await supabase
    .from("payments")
    .select("id, org_id, stripe_payment_intent")
    .not("stripe_payment_intent", "is", null)
    .is("processor_fee", null)
    .order("paid_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`reading payments without a fee failed: ${error.message}`);

  const out: FeeBackfill = { looked_at: 0, stored: 0, not_yet: 0, failed: 0, no_account: 0 };
  const todo = (rows ?? []) as { id: string; org_id: string | null; stripe_payment_intent: string }[];
  if (!todo.length) return out;

  const orgIds = [...new Set(todo.map((r) => r.org_id).filter((id): id is string => !!id))];
  const { data: orgs, error: orgErr } = await supabase
    .from("organizations")
    .select("id, stripe_account_id")
    .in("id", orgIds);
  if (orgErr) throw new Error(`reading connected accounts failed: ${orgErr.message}`);
  const accountOf = new Map(
    ((orgs ?? []) as { id: string; stripe_account_id: string | null }[]).map((o) => [o.id, o.stripe_account_id]),
  );

  // Org by org, so each org's payments are read on that org's own account.
  for (const orgId of orgIds) {
    const mine = todo.filter((r) => r.org_id === orgId);
    const account = accountOf.get(orgId) ?? null;
    if (!account) {
      // Its online payments came through a connected account that is gone now. There is nowhere
      // to read the fee from, so it stays unknown, and the ops log says why instead of nothing.
      out.no_account += mine.length;
      reportError("stripe:fee:no-connected-account", new Error("online payments with no fee, and the org has no connected account"), {
        orgId,
        payments: mine.length,
      });
      continue;
    }
    for (const r of mine) {
      out.looked_at++;
      out[await captureProcessorFee(supabase, { orgId, paymentIntent: r.stripe_payment_intent, account })]++;
    }
  }
  return out;
}
