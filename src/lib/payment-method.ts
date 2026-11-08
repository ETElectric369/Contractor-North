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
 *
 * ONE LIST OF THE WAYS MONEY MOVES (cn-v1152). Erik, 2026-11-07: "there are some payment entry
 * windows that show venmo as an option then others that dont … i had to add venmo in the notes and
 * now in the invoice im creating … i just recorded a payment with a venmo button". The customer's
 * door read Settings › Payment methods; the crew's pay form and the supplier's pay door each kept a
 * word list of their own (four words from 0264, five from 0270), and a CHECK on each column held them
 * to it. Every door that records a payment now draws its chips from the one list through
 * paymentMethodChoices() below and stores the key (0406 took the two CHECKs off and runs the one
 * normalizer on those columns too). A lib, so it imports no catalog: a chip's label is the company's
 * own spelling, as typed in Settings.
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
  // OWN keys only: these tables are indexed by whatever a person typed into Settings, and a
  // plain object answers "constructor" or "__proto__" with Object.prototype's members. That
  // stored the column default through a dropped JSON key and crashed the label (review 09-24).
  return Object.hasOwn(PAYMENT_METHOD_ALIASES, k) ? PAYMENT_METHOD_ALIASES[k] : k;
}

/** How a stored method reads on a page, a PDF or out loud. */
export function paymentMethodLabel(raw: string | null | undefined): string {
  const key = paymentMethodKey(raw);
  if (Object.hasOwn(PAYMENT_METHOD_LABELS, key)) return PAYMENT_METHOD_LABELS[key];
  return (
    key
      .split(" ")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ")
  );
}

/** Whether a value names a way money moves at all: a non-blank string, whose key is then never empty.
 *  A blank is the one thing paymentMethodKey files as other, and a blank is not a pick — a door that
 *  is handed one refuses ("Pick how you paid.") rather than filing the money under a method nobody
 *  chose. Both pay doors (payroll/actions, bills/supplier-actions) judge by this. */
export function isPaymentMethod(v: unknown): v is string {
  return typeof v === "string" && v.trim() !== "" && paymentMethodKey(v) !== "";
}

/** THE LIST A COMPANY STARTS WITH (Settings › Payment methods; org-settings' DEFAULT_SETTINGS reads
 *  this one, so there is one copy of it). A door whose company list is empty draws these, so no door
 *  ever offers no way to pay. Labels as a person reads them; the key of each is its lower-case. */
export const DEFAULT_PAYMENT_METHODS: readonly string[] = ["Cash", "Check", "Card", "Zelle", "Venmo", "Transfer"];

/** One chip on a pay door: the words it shows (the company's own spelling) and the key it submits. */
export type PaymentMethodChoice = { key: string; label: string };

/**
 * THE CHIPS A PAY DOOR DRAWS — the crew's pay form, the supplier's pay door, the customer's Get Paid
 * sheet all read the same company list (settings.payment_methods) through here. Each spelling keeps
 * its words as the label and submits paymentMethodKey() of it; two spellings of one key ("Venmo" and
 * "venmo", "Credit Card" and "Card") are ONE chip, the first spelling's. Blank entries are skipped. An
 * empty list draws `fallback` — the house default — the same way, so a company that cleared its list
 * still has a way to say how it was paid.
 */
export function paymentMethodChoices(
  list: readonly (string | null | undefined)[] | null | undefined,
  fallback: readonly string[] = DEFAULT_PAYMENT_METHODS,
): PaymentMethodChoice[] {
  const out: PaymentMethodChoice[] = [];
  const seen = new Set<string>();
  for (const raw of list ?? []) {
    const label = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!label) continue;
    const key = paymentMethodKey(label);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label });
  }
  if (out.length === 0 && fallback.length > 0) return paymentMethodChoices(fallback, []);
  return out;
}
