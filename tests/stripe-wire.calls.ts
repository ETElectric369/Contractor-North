import type Stripe from "stripe";

/**
 * EVERY CALL THE APP MAKES TO STRIPE, in the shape its call site sends it (cn-v1210).
 *
 * One row per call site, or per branch of one where the parameters differ (an email that is there
 * or not, a card door or a bank door). The values are made up; the SHAPES are the call sites':
 * which argument is the id, which the parameters, which the request options, and which values may
 * be undefined. tests/stripe-wire.test.ts sends each row through the installed SDK with a stand-in
 * transport and compares the request with tests/stripe-wire.recorded.json, which was recorded from
 * the SDK the app ran before.
 *
 * `method` is the SDK method the row calls. The test reads the app's source for every SDK method
 * it calls and fails when one has no row here, so a new call site brings its row with it.
 */
export type WireCall = { name: string; method: string; run: (s: Stripe) => Promise<unknown> };

const ACCT = { stripeAccount: "acct_1" };
const site = "https://app.example.test";

const invoicePay = (method: "card" | "bank", fee: number, email: string | undefined) => ({
  mode: "payment" as const,
  ...({ payment_method_types: [method === "bank" ? "us_bank_account" : "card"] } as object),
  line_items: [
    { price_data: { currency: "usd", product_data: { name: "Larkspur Electric Invoice INV-900" }, unit_amount: 283089 }, quantity: 1 },
    ...(fee > 0
      ? [{ price_data: { currency: "usd", product_data: { name: "Card processing fee (2.9%)" }, unit_amount: Math.round(fee * 100) }, quantity: 1 }]
      : []),
  ],
  customer_email: email,
  success_url: `${site}/i/tok?paid=${method === "bank" ? "bank" : "1"}`,
  cancel_url: `${site}/i/tok`,
  metadata: { kind: "invoice_payment", invoice_id: "inv-1", org_id: "org-1", pay_method: method, invoice_amount: "2830.89", card_fee: fee.toFixed(2) },
  payment_intent_data: { metadata: { invoice_id: "inv-1", org_id: "org-1", pay_method: method, invoice_amount: "2830.89", card_fee: fee.toFixed(2) } },
});

const topUp = (who: { customer: string } | { customer_email: string | undefined }) => ({
  mode: "payment" as const,
  ...who,
  line_items: [{ price: "price_1", quantity: 1 }],
  success_url: `${site}/settings?tab=getpaid&usage=added`,
  cancel_url: `${site}/settings?tab=getpaid`,
  metadata: { kind: "extra_usage", org_id: "org-1", month: "2026-11", usage_usd: "15" },
});

const location = (name: string, line2: string | null) => ({
  display_name: name,
  address: { line1: "100 Example Street", ...(line2 ? { line2 } : {}), city: "Tupelo", state: "CA", postal_code: "96100", country: "US" },
  metadata: { org_id: "org-1" },
});

const connectAccount = (email: string | undefined, name: string | undefined) => ({
  type: "express" as const,
  email,
  business_profile: { name, support_email: email },
  capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
  metadata: { org_id: "org-1" },
});

export const wireCalls: WireCall[] = [
  { name: "refund: read the charge", method: "charges.retrieve", run: (s) => s.charges.retrieve("ch_1", {}, ACCT) },
  { name: "tap: make the location (two address lines)", method: "terminal.locations.create", run: (s) => s.terminal.locations.create(location("Larkspur Electric", "Unit 2"), ACCT) },
  { name: "tap: make the location (one address line)", method: "terminal.locations.create", run: (s) => s.terminal.locations.create(location("Larkspur & Sons, Inc.", null), ACCT) },
  { name: "tap: delete a stray location", method: "terminal.locations.del", run: (s) => s.terminal.locations.del("tml_1", {}, ACCT) },
  {
    name: "tap: create the payment",
    method: "paymentIntents.create",
    run: (s) =>
      s.paymentIntents.create(
        {
          amount: 12345,
          currency: "usd",
          ...({ payment_method_types: ["card_present"] } as object),
          capture_method: "automatic",
          description: "Invoice INV-900",
          metadata: { kind: "invoice_payment", source: "tap_to_pay", invoice_id: "inv-1", org_id: "org-1", user_id: "user-1" },
        },
        ACCT,
      ),
  },
  { name: "tap: read the payment", method: "paymentIntents.retrieve", run: (s) => s.paymentIntents.retrieve("pi_1", {}, ACCT) },
  { name: "tap: cancel the payment", method: "paymentIntents.cancel", run: (s) => s.paymentIntents.cancel("pi_1", {}, ACCT) },
  { name: "subscribe: make the customer (no email)", method: "customers.create", run: (s) => s.customers.create({ name: "Larkspur Electric", email: undefined, metadata: { org_id: "org-1" } }) },
  { name: "subscribe: make the customer (email)", method: "customers.create", run: (s) => s.customers.create({ name: "Larkspur Electric", email: "office@example.test", metadata: { org_id: "org-1" } }) },
  {
    name: "subscribe: checkout",
    method: "checkout.sessions.create",
    run: (s) =>
      s.checkout.sessions.create({
        mode: "subscription",
        customer: "cus_1",
        line_items: [{ price: "price_1", quantity: 1 }],
        success_url: `${site}/settings?tab=getpaid&billing=success`,
        cancel_url: `${site}/settings?tab=getpaid&billing=cancelled`,
        metadata: { org_id: "org-1" },
        subscription_data: { metadata: { org_id: "org-1" } },
      }),
  },
  { name: "billing portal", method: "billingPortal.sessions.create", run: (s) => s.billingPortal.sessions.create({ customer: "cus_1", return_url: `${site}/settings?tab=getpaid` }) },
  { name: "top-up: read the price with its product", method: "prices.retrieve", run: (s) => s.prices.retrieve("price_1", { expand: ["product"] }) },
  { name: "top-up: checkout (known customer)", method: "checkout.sessions.create", run: (s) => s.checkout.sessions.create(topUp({ customer: "cus_1" })) },
  { name: "top-up: checkout (email only)", method: "checkout.sessions.create", run: (s) => s.checkout.sessions.create(topUp({ customer_email: "office@example.test" })) },
  { name: "top-up: checkout (no customer, no email)", method: "checkout.sessions.create", run: (s) => s.checkout.sessions.create(topUp({ customer_email: undefined })) },
  { name: "connect: make the account (all fields)", method: "accounts.create", run: (s) => s.accounts.create(connectAccount("office@example.test", "Larkspur Electric"), { idempotencyKey: "connect-account-org-1-1960000" }) },
  { name: "connect: make the account (no email, no name)", method: "accounts.create", run: (s) => s.accounts.create(connectAccount(undefined, undefined), { idempotencyKey: "connect-account-org-1-1960000" }) },
  {
    name: "connect: onboarding link",
    method: "accountLinks.create",
    run: (s) => s.accountLinks.create({ account: "acct_1", refresh_url: `${site}/settings?tab=getpaid&connect=refresh`, return_url: `${site}/settings?tab=getpaid&connect=done`, type: "account_onboarding" }),
  },
  { name: "connect: login link", method: "accounts.createLoginLink", run: (s) => s.accounts.createLoginLink("acct_1") },
  { name: "connect: read the account", method: "accounts.retrieve", run: (s) => s.accounts.retrieve("acct_1") },
  { name: "health: balance", method: "balance.retrieve", run: (s) => s.balance.retrieve({}, { timeout: 5000, maxNetworkRetries: 0 }) },
  { name: "health: a price", method: "prices.retrieve", run: (s) => s.prices.retrieve("price_1", {}, { timeout: 5000, maxNetworkRetries: 0 }) },
  { name: "pay link: card with a fee line", method: "checkout.sessions.create", run: (s) => s.checkout.sessions.create(invoicePay("card", 82.1, "customer@example.test"), ACCT) },
  { name: "pay link: bank, no fee, no email", method: "checkout.sessions.create", run: (s) => s.checkout.sessions.create(invoicePay("bank", 0, undefined), ACCT) },
  { name: "card reader: connection token", method: "terminal.connectionTokens.create", run: (s) => s.terminal.connectionTokens.create({}, ACCT) },
  { name: "webhook: read a subscription", method: "subscriptions.retrieve", run: (s) => s.subscriptions.retrieve("sub_1") },
  { name: "refund: find the top-up session", method: "checkout.sessions.list", run: (s) => s.checkout.sessions.list({ payment_intent: "pi_1", limit: 1 }) },
  {
    name: "fee: read the payment with its fee (connected)",
    method: "paymentIntents.retrieve",
    run: (s) => s.paymentIntents.retrieve("pi_1", { expand: ["latest_charge.balance_transaction"] }, { ...({ stripeAccount: "acct_1" } as object), timeout: 8000, maxNetworkRetries: 1 }),
  },
  {
    name: "fee: read the payment with its fee (platform)",
    method: "paymentIntents.retrieve",
    run: (s) => s.paymentIntents.retrieve("pi_1", { expand: ["latest_charge.balance_transaction"] }, { ...({} as object), timeout: 8000, maxNetworkRetries: 1 }),
  },
];
