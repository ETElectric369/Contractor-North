/**
 * A PAYMENT METHOD IS A KEY, NOT A LABEL (0287).
 *
 * payments.method was written by five doors in three spellings: the settle-up chips sent the
 * chip LABEL ("Cash", "Venmo"), the Venmo QR sent the literal "venmo", the Stripe webhook sent
 * "card", and Settings let an office type any custom method it liked. So the same money read
 * "Cash" on one row and "cash" on the next, and anything that grouped by method counted them as
 * two ways of being paid.
 *
 * One key is stored; one label is rendered. paymentMethodKey() is the app's normalizer and
 * public.payment_method_key() is the database's (a BEFORE trigger on payments runs it, so an old
 * build's "Cash" is normalized rather than refused). The two must agree alias for alias:
 * payment-method.test.ts reads the migration and holds them to it.
 */

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: "Cash",
  check: "Check",
  card: "Card",
  ach: "ACH",
  transfer: "Transfer",
  venmo: "Venmo",
  zelle: "Zelle",
  paypal: "PayPal",
  cashapp: "Cash App",
  other: "Other",
};

/** Spellings people (and Stripe) use for a method we already have a key for. Mirrored in
 *  supabase/migrations/0287_a_payment_method_is_a_key.sql — change both or neither. */
export const PAYMENT_METHOD_ALIASES: Record<string, string> = {
  cheque: "check",
  "credit card": "card",
  "debit card": "card",
  credit: "card",
  debit: "card",
  "bank transfer": "transfer",
  wire: "transfer",
  "wire transfer": "transfer",
  "bank debit": "ach",
  us_bank_account: "ach",
  "cash app": "cashapp",
};

/** The stored key for whatever a person or a door called the method. A custom method from
 *  Settings ("Apple Cash") is kept, lower-cased, so it still groups with itself. */
export function paymentMethodKey(raw: string | null | undefined): string {
  const k = String(raw ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!k) return "other";
  return PAYMENT_METHOD_ALIASES[k] ?? k;
}

/** How a stored method reads on a page, a PDF or out loud. */
export function paymentMethodLabel(raw: string | null | undefined): string {
  const key = paymentMethodKey(raw);
  return (
    PAYMENT_METHOD_LABELS[key] ??
    key
      .split(" ")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ")
  );
}
