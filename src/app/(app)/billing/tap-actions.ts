"use server";
import { requireStaff } from "@/lib/staff-guard";
import { dbError } from "@/lib/db-error";
import { getStripe, billingEnabled } from "@/lib/stripe";
import { canAcceptPayments, connectStateFromOrg } from "@/lib/stripe-connect";
import { invoiceBalance } from "@/lib/invoice-math";
import { reportError } from "@/lib/observe";

/**
 * TAP TO PAY ON IPHONE — the server half (2026-09-10, migration 0252).
 *
 * The phone is the card reader. The tech taps "Tap to Pay" on the Pay Now screen, the customer
 * holds their card to the back of the iPhone, and the money lands on the invoice the same way an
 * online payment does: Stripe's webhook books it (payment_intent.succeeded → recordInvoicePayment)
 * and the screen polls invoiceCollectStatus until it flips. NOTHING HERE WRITES A PAYMENT ROW.
 * The webhook is the one writer for card money; a second writer keyed on a different id is the
 * double-record class recordInvoicePayment was built to close.
 *
 * THE MONEY LAW (0161) applies to every Stripe object below: the Terminal Location, and the
 * PaymentIntent, are created ON THE TENANT'S OWN CONNECTED ACCOUNT ({ stripeAccount }) so the
 * tenant is merchant of record, pays Stripe's in-person rate, and Contractor North never holds a
 * dollar of it. No application fee. `onBehalfOf` is for destination charges and stays unset.
 *
 * Every function returns a plain sentence on failure and never throws — the caller is a button
 * on a phone in someone's driveway.
 */

const NOT_SET_UP =
  "Card payments aren't switched on for this company yet. Finish Stripe setup in Settings → Payments first.";

/**
 * Test keys → Stripe's SIMULATED Tap to Pay reader (works in the Simulator, needs no Apple
 * entitlement); live keys → the real one. The plugin's native default is `isTest: true`, which
 * would silently simulate in production, so the bridge always passes it explicitly from THIS
 * fact rather than trusting a default. Read from the key, not a flag, because a flag drifts.
 */
function stripeLivemode(): boolean {
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  return !!key && !/^(sk|rk)_test_/.test(key);
}

type OrgRow = {
  name: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  stripe_account_id: string | null;
  stripe_account_status: string | null;
  stripe_charges_enabled: boolean | null;
  stripe_terminal_location_id: string | null;
};

const ORG_COLUMNS =
  "name, address_line1, address_line2, city, state, zip, stripe_account_id, stripe_account_status, stripe_charges_enabled, stripe_terminal_location_id";

export type TapToPayContext =
  | {
      ok: true;
      /** The org can take cards at all (same gate as the QR door). */
      canAccept: boolean;
      /** Live keys → real reader; test keys → simulated reader. */
      livemode: boolean;
      /** The org's Terminal Location, or null until ensureTerminalLocation mints it. */
      locationId: string | null;
      /** What the customer reads on the tap screen. */
      merchantDisplayName: string;
    }
  | { ok: false; error: string };

/**
 * READ-ONLY look at whether Tap to Pay could work for this org — what the bridge's support probe
 * needs and nothing more. Creates nothing, so it is safe to call on every screen mount.
 */
export async function tapToPayContext(): Promise<TapToPayContext> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This action is staff-only." };
  if (!ctx.orgId) return { ok: false, error: "Your account isn't attached to a company yet." };
  const { data: org, error } = await ctx.supabase
    .from("organizations")
    .select(ORG_COLUMNS)
    .eq("id", ctx.orgId)
    .maybeSingle();
  if (error || !org) {
    return { ok: false, error: error ? dbError(error) : "Couldn't read this company's payment setup." };
  }
  const row = org as unknown as OrgRow;
  return {
    ok: true,
    canAccept: billingEnabled && canAcceptPayments(connectStateFromOrg(row)),
    livemode: stripeLivemode(),
    locationId: row.stripe_terminal_location_id ?? null,
    merchantDisplayName: (row.name ?? "").trim() || "Invoice payment",
  };
}

export type TerminalLocationResult =
  | { ok: true; locationId: string; merchantDisplayName: string; livemode: boolean }
  | { ok: false; error: string };

/**
 * ONE TERMINAL LOCATION PER ORG, ON THEIR OWN STRIPE ACCOUNT, MINTED THE FIRST TIME IT IS NEEDED.
 *
 * Stripe will not connect a Tap to Pay reader without a Location id, and its display_name is what
 * the customer sees on the tap screen unless the app names the business itself (we do both). The
 * address is the org's MAILING address (organizations.address_line1/city/state/zip — the one on
 * their invoices), never the public-site address in settings, which is the owner's choice of what
 * to publish and may be nothing at all.
 *
 * The id is persisted with a CHECKED write (the silent-write law: a zero-row update is a 204, and
 * "saved" would then be a lie that costs the tenant a fresh stray Location on every later tap).
 */
export async function ensureTerminalLocation(): Promise<TerminalLocationResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This action is staff-only." };
  const orgId = ctx.orgId;
  if (!orgId) return { ok: false, error: "Your account isn't attached to a company yet." };
  const supabase = ctx.supabase;

  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .select(ORG_COLUMNS)
    .eq("id", orgId)
    .maybeSingle();
  if (orgErr || !org) {
    return { ok: false, error: orgErr ? dbError(orgErr) : "Couldn't read this company's payment setup." };
  }
  const row = org as unknown as OrgRow;
  const merchantDisplayName = (row.name ?? "").trim() || "Invoice payment";
  const livemode = stripeLivemode();

  // Already minted — the common case after the first tap.
  if (row.stripe_terminal_location_id) {
    return { ok: true, locationId: row.stripe_terminal_location_id, merchantDisplayName, livemode };
  }

  if (!billingEnabled) return { ok: false, error: "Card payments aren't set up on this server yet." };
  const connect = connectStateFromOrg(row);
  if (!canAcceptPayments(connect)) return { ok: false, error: NOT_SET_UP };

  // Stripe requires line1 / city / state / postal_code for a US Location, and a Location's country
  // can never be changed once created — so refuse with the fix named rather than let Stripe reject
  // with a field name the office has never seen.
  const line1 = (row.address_line1 ?? "").trim();
  const city = (row.city ?? "").trim();
  const state = (row.state ?? "").trim();
  const zip = (row.zip ?? "").trim();
  if (!line1 || !city || !state || !zip) {
    return {
      ok: false,
      error:
        "Stripe needs your company's street address, city, state and ZIP to set up Tap to Pay. Add them in Settings → Company, then try again.",
    };
  }

  let locationId: string;
  try {
    const loc = await getStripe().terminal.locations.create(
      {
        display_name: merchantDisplayName,
        address: {
          line1,
          ...((row.address_line2 ?? "").trim() ? { line2: (row.address_line2 ?? "").trim() } : {}),
          city,
          state,
          postal_code: zip,
          country: "US",
        },
        metadata: { org_id: orgId },
      },
      // THE line that puts the Location in the tenant's Stripe, not ours.
      { stripeAccount: connect.accountId! },
    );
    locationId = loc.id;
  } catch (e) {
    reportError("stripe:terminal:location", e, { orgId });
    const said = e instanceof Error ? e.message : "";
    return { ok: false, error: `Stripe couldn't set up Tap to Pay for this company${said ? ` — ${said}` : ""}.` };
  }

  // Checked, and guarded on the column still being null: two phones reaching for Tap to Pay in
  // the same second must not each win — the second one's write matches zero rows, and the
  // re-read below hands it the first one's id instead of a duplicate.
  const { data: saved, error: saveErr } = await supabase
    .from("organizations")
    .update({ stripe_terminal_location_id: locationId })
    .eq("id", orgId)
    .is("stripe_terminal_location_id", null)
    .select("id");
  if (saveErr) {
    reportError("stripe:terminal:location-save", saveErr, { orgId, locationId });
    return { ok: false, error: `Stripe set up the location, but it couldn't be saved to your company: ${dbError(saveErr)}` };
  }
  if (!saved?.length) {
    const { data: again } = await supabase
      .from("organizations")
      .select("stripe_terminal_location_id")
      .eq("id", orgId)
      .maybeSingle();
    const theirs = (again as { stripe_terminal_location_id?: string | null } | null)?.stripe_terminal_location_id;
    if (theirs) {
      // Lost the race. The one we just made is a stray on the tenant's account — tidy it, best
      // effort; a leftover Location is harmless but untidy in THEIR dashboard.
      try {
        await getStripe().terminal.locations.del(locationId, { stripeAccount: connect.accountId! });
      } catch {
        /* best effort */
      }
      return { ok: true, locationId: theirs, merchantDisplayName, livemode };
    }
    // Not a race: the row simply wasn't ours to write (RLS said no, quietly). Say so; nothing
    // moved — and the Location we just made would be a stray per attempt, so it goes too.
    try {
      await getStripe().terminal.locations.del(locationId, { stripeAccount: connect.accountId! });
    } catch {
      /* best effort */
    }
    reportError("stripe:terminal:location-unsaved", new Error("zero-row update saving stripe_terminal_location_id"), {
      orgId,
      locationId,
    });
    return {
      ok: false,
      error: "Stripe set up the location, but it couldn't be saved to your company — nothing was changed. Ask an owner or admin to try.",
    };
  }
  return { ok: true, locationId, merchantDisplayName, livemode };
}

export type TapPaymentIntentResult =
  | {
      ok: true;
      /** What the phone hands to the reader (collectPaymentMethod wants the SECRET, not the id). */
      clientSecret: string;
      /** The pi_… id — the webhook and the payments row are keyed on it; the plugin never returns it. */
      paymentIntentId: string;
      /** Integer CENTS, exactly what Stripe was told to charge. */
      amount: number;
      /** The same amount in dollars, for the confirmation copy. */
      balance: number;
      invoiceNumber: string | null;
      livemode: boolean;
    }
  | { ok: false; error: string };

/**
 * MINT THE PAYMENTINTENT THE PHONE WILL COLLECT — on the tenant's account, for the full balance.
 *
 * `card_present` + `capture_method: automatic` means confirming on the device is the whole
 * payment: the PI goes straight to `succeeded`, Stripe emits payment_intent.succeeded on the
 * connected account, and the webhook books it. The metadata is how the webhook knows WHOSE
 * invoice — and `source: "tap_to_pay"` is the marker that keeps a Tap payment from being booked
 * twice, because a hosted-Checkout PI fires the same event without it (see the webhook branch).
 *
 * Declined? Call the bridge again with the SAME clientSecret — Stripe says re-use the PI rather
 * than minting another, and a second PI per attempt would also be a second door onto the same
 * balance.
 */
export async function createTapPaymentIntent(invoiceId: string): Promise<TapPaymentIntentResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This action is staff-only." };
  const orgId = ctx.orgId;
  if (!orgId) return { ok: false, error: "Your account isn't attached to a company yet." };
  const supabase = ctx.supabase;
  if (!billingEnabled) return { ok: false, error: "Card payments aren't set up on this server yet." };

  // Own org only — RLS already says so, and the explicit eq says so again where a reader can see
  // it (tenant-isolation-root-cause: a rule at one layer is a convention, not a boundary).
  const { data: inv, error: invErr } = await supabase
    .from("invoices")
    .select("id, invoice_number, status, total, amount_paid, org_id")
    .eq("id", invoiceId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (invErr) return { ok: false, error: dbError(invErr) };
  if (!inv) return { ok: false, error: "Invoice not found." };
  const status = String((inv as { status?: string }).status ?? "");
  if (status === "void") return { ok: false, error: "This invoice is void — there's nothing to collect." };

  const balance = invoiceBalance((inv as { total?: number | null }).total, (inv as { amount_paid?: number | null }).amount_paid);
  if (balance <= 0) return { ok: false, error: "This invoice is already paid in full." };
  // Stripe refuses a card charge under fifty cents (the same floor /api/pay applies).
  if (balance < 0.5) return { ok: false, error: "The balance is under $0.50 — too small for a card. Record it another way." };
  const amount = Math.round(balance * 100);

  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .select("stripe_account_id, stripe_account_status, stripe_charges_enabled")
    .eq("id", orgId)
    .maybeSingle();
  if (orgErr || !org) {
    return { ok: false, error: orgErr ? dbError(orgErr) : "Couldn't read this company's payment setup." };
  }
  const connect = connectStateFromOrg(org as never);
  if (!canAcceptPayments(connect)) return { ok: false, error: NOT_SET_UP };

  // A PAY DOOR ON A DRAFT IS A DOOR ONTO A WALL (collectArtifacts, INV-064) — a tap is a door as
  // much as a QR is. Putting a bill in front of a customer IS sending it: promote here, checked —
  // and only now, after every refusal above has had its say, so a "nothing to collect" answer
  // never leaves the invoice's status changed behind it.
  if (status === "draft") {
    const { data: sent, error: sendErr } = await supabase
      .from("invoices")
      .update({ status: "sent" })
      .eq("id", invoiceId)
      .eq("status", "draft")
      .select("id");
    if (sendErr || !sent?.length) {
      return { ok: false, error: "Couldn't send this invoice, so there's nothing for them to pay yet." };
    }
  }

  const invoiceNumber = ((inv as { invoice_number?: string | null }).invoice_number ?? null) || null;
  try {
    const pi = await getStripe().paymentIntents.create(
      {
        amount,
        currency: "usd",
        // Terminal payments MUST include card_present; nothing else, so this PI can never be paid
        // through any door but the reader.
        payment_method_types: ["card_present"],
        // Authorize and capture in one step — no two-day capture window to reconcile.
        capture_method: "automatic",
        description: invoiceNumber ? `Invoice ${invoiceNumber}` : "Invoice payment",
        // kind + invoice_id + org_id is what recordInvoicePayment needs; source is the Terminal-only
        // marker the webhook gates on. Keep all four — dropping any one either loses the booking or
        // reopens the double-booking.
        metadata: { kind: "invoice_payment", source: "tap_to_pay", invoice_id: inv.id, org_id: orgId },
      },
      // THE line that makes it a direct charge on the tenant's account.
      { stripeAccount: connect.accountId! },
    );
    if (!pi.client_secret) {
      reportError("stripe:terminal:intent", new Error("PaymentIntent came back without a client_secret"), {
        orgId,
        invoiceId,
        paymentIntentId: pi.id,
      });
      return { ok: false, error: "Stripe started the payment but didn't hand back what the reader needs. Try again." };
    }
    return {
      ok: true,
      clientSecret: pi.client_secret,
      paymentIntentId: pi.id,
      amount,
      balance,
      invoiceNumber,
      livemode: !!pi.livemode,
    };
  } catch (e) {
    reportError("stripe:terminal:intent", e, { orgId, invoiceId });
    const said = e instanceof Error ? e.message : "";
    return { ok: false, error: `Stripe wouldn't start this card payment${said ? ` — ${said}` : ""}.` };
  }
}
