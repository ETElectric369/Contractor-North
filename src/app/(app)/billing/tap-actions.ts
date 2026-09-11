"use server";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";
import { createClient } from "@/lib/supabase/server";
import { dbError } from "@/lib/db-error";
import { getStripe, billingEnabled } from "@/lib/stripe";
import { canAcceptPayments, connectStateFromOrg } from "@/lib/stripe-connect";
import { invoiceBalance } from "@/lib/invoice-math";
import { reportError } from "@/lib/observe";
import { orgStaffIds, pushConfigured, sendPushToProfiles } from "@/lib/push";
import { STAFF_ROLES } from "@/lib/actions/perms";

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
 * WHO MAY ACCEPT APPLE'S TERMS (Apple 3.8): "Tap to Pay on iPhone Terms and Conditions must only
 * be accepted by an administrator user or otherwise authorized party." Apple's own sample gates
 * the sheet on "the user is an admin"; the T&C say the acceptor signs "on behalf of your company
 * … as its authorized legal representative". In CN that is owner or admin — NOT office, even
 * though office passes requireStaff: an office manager runs the books, they do not sign for the
 * company. The SDK itself is not role-aware (Apple presents the sheet to whoever connects first),
 * so this list is the whole gate, enforced in the app before connect is ever called.
 */
const ENABLE_ROLES = ["owner", "admin"];

/**
 * WHO IS "ELIGIBLE" TO BE TOLD (Apple 3.3: "all eligible users at least once"). Billing in CN is
 * STAFF-ONLY — owner/admin/office. The dock hides Money from a tech, and requireStaff guards
 * every money door in this file and the connection-token route, so a tech cannot take a tap and
 * never reaches a Pay Now. An intro card shown to that tech would be a dead end: "here is Tap to
 * Pay on iPhone" opening onto a staff-only wall. So eligible = exactly the people billing is
 * open to — and it IS STAFF_ROLES rather than a parallel list, because the launch push
 * (announceTapToPay → orgStaffIds) addresses that same set and two lists drift apart. Still
 * wider than ENABLE_ROLES on purpose: hearing about the feature and signing Apple's terms for it
 * are different rights (office hears; owner/admin signs).
 */
const ELIGIBLE_ROLES = STAFF_ROLES;

/**
 * A SIGNED-IN, ACTIVE MEMBER — the floor for the "tell me about myself" actions below, which read
 * or stamp the caller's OWN profile row and touch no money. requireStaff would refuse a tech here
 * with "staff-only", and Apple 3.8.1 wants exactly that person to get a real answer ("ask an
 * admin"), not a wall. Deactivated is still a boundary (audit v921): the seat is gone, so is the
 * intro, so is the role answer.
 */
async function requireMember(): Promise<
  | { supabase: Awaited<ReturnType<typeof createClient>>; userId: string; orgId: string | null; role: string }
  | { error: string }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: "Not signed in." };
  const { data: me, error } = await supabase
    .from("profiles")
    .select("role, org_id, active")
    .eq("id", user.id)
    .maybeSingle();
  if (error) return { error: dbError(error) };
  if (!me) return { error: "Your profile couldn't be found." };
  const row = me as { role?: string | null; org_id?: string | null; active?: boolean | null };
  if (row.active === false) return { error: "This account has been deactivated." };
  return { supabase, userId: user.id, orgId: row.org_id ?? null, role: String(row.role ?? "") };
}

/**
 * The caller's role, read fresh off their own row. requireStaff checks the role but hands back
 * only { supabase, userId, orgId } — a second one-column read is cheaper than widening a guard
 * that ~30 money actions share.
 */
async function callerRole(supabase: Awaited<ReturnType<typeof createClient>>, userId: string): Promise<string> {
  const { data } = await supabase.from("profiles").select("role").eq("id", userId).maybeSingle();
  return String((data as { role?: string | null } | null)?.role ?? "");
}

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
      /**
       * THIS caller may accept Apple's Terms and Conditions (Apple 3.8: owner/admin only). The
       * bridge reads it BEFORE connectReader, because the SDK raises Apple's T&C sheet inside
       * connect for whoever gets there first — the gate has to be ours. False means: warm up
       * only if the account is already linked, and say "ask an admin" (3.8.1) otherwise.
       */
      canEnable: boolean;
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
  const [{ data: org, error }, role] = await Promise.all([
    ctx.supabase.from("organizations").select(ORG_COLUMNS).eq("id", ctx.orgId).maybeSingle(),
    callerRole(ctx.supabase, ctx.userId),
  ]);
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
    canEnable: ENABLE_ROLES.includes(role),
  };
}

export type TapToPayRole = { ok: true; canEnable: boolean; role: string } | { ok: false; error: string };

/**
 * MAY THIS PERSON ACCEPT APPLE'S TERMS? (Apple 3.8 / 3.8.1.) One read of the caller's own role —
 * nothing else — so a Settings card or a checkout button can decide between "Accept the Terms"
 * and "Ask an owner or admin to enable Tap to Pay on iPhone" without a money action's gate in
 * the way. Open to every active member on purpose: the person Apple wants told "contact an
 * admin" is precisely the one requireStaff would turn away at the door.
 *
 * NOT the T&C status itself. Whether the merchant HAS accepted is Apple's fact (1.6), read from
 * the SDK on the phone every time; this only answers who is allowed to try.
 */
export async function tapToPayRole(): Promise<TapToPayRole> {
  const me = await requireMember();
  if ("error" in me) return { ok: false, error: me.error };
  return { ok: true, canEnable: ENABLE_ROLES.includes(me.role), role: me.role };
}

export type TapToPayIntroState =
  | {
      ok: true;
      /** ISO timestamp of when this person was shown the intro, or null = not yet. */
      seenAt: string | null;
      /** Someone the intro is FOR: a member who could take a card, in a company that can take cards. */
      eligible: boolean;
    }
  | { ok: false; error: string };

/**
 * HAS THIS PERSON BEEN SHOWN THE INTRO, AND SHOULD THEY BE? (Apple 3.1 / 3.3.)
 *
 * `eligible` is what "all eligible users" means for us: an active staff member (ELIGIBLE_ROLES —
 * the roles billing is open to), in a company whose Stripe account can actually charge.
 * A company that hasn't finished Stripe setup gets no intro — the card would open onto a wall,
 * and the Set Up Card Payments door already tells them what comes first. `seenAt` is the once
 * flag: null and eligible → show it, stamp it (tapToPayIntroSeen), never again. Reads the
 * caller's own row and their own org only.
 */
export async function tapToPayIntroState(): Promise<TapToPayIntroState> {
  const me = await requireMember();
  if ("error" in me) return { ok: false, error: me.error };
  const [{ data: prof, error: profErr }, { data: org, error: orgErr }] = await Promise.all([
    me.supabase.from("profiles").select("tap_to_pay_intro_seen_at").eq("id", me.userId).maybeSingle(),
    me.orgId
      ? me.supabase
          .from("organizations")
          .select("stripe_account_id, stripe_account_status, stripe_charges_enabled")
          .eq("id", me.orgId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (profErr) return { ok: false, error: dbError(profErr) };
  if (orgErr) return { ok: false, error: dbError(orgErr) };
  const seenAt = (prof as { tap_to_pay_intro_seen_at?: string | null } | null)?.tap_to_pay_intro_seen_at ?? null;
  const canAccept = !!org && billingEnabled && canAcceptPayments(connectStateFromOrg(org as never));
  return { ok: true, seenAt, eligible: ELIGIBLE_ROLES.includes(me.role) && canAccept };
}

/**
 * STAMP "SHOWN" ON THE CALLER'S OWN ROW — once. Checked (the silent-write law: a zero-row update
 * is a 204), and guarded on the column still being null so a card dismissed on two devices at
 * once keeps the FIRST time it was seen. Already stamped is not a failure: the card is gone
 * either way, and "that didn't save" over a second dismissal would be the nag the flag exists
 * to prevent.
 */
export async function tapToPayIntroSeen(): Promise<{ ok: true } | { ok: false; error: string }> {
  const me = await requireMember();
  if ("error" in me) return { ok: false, error: me.error };
  const { data: stamped, error } = await me.supabase
    .from("profiles")
    .update({ tap_to_pay_intro_seen_at: new Date().toISOString() })
    .eq("id", me.userId)
    .is("tap_to_pay_intro_seen_at", null)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (stamped?.length) return { ok: true };
  // Zero rows: either already stamped (fine) or the row wasn't ours to write (say so).
  const { data: again } = await me.supabase
    .from("profiles")
    .select("tap_to_pay_intro_seen_at")
    .eq("id", me.userId)
    .maybeSingle();
  if ((again as { tap_to_pay_intro_seen_at?: string | null } | null)?.tap_to_pay_intro_seen_at) return { ok: true };
  return { ok: false, error: "That didn't save — the card will show again next time. Reload and try once more." };
}

/**
 * THE ONE-SHOT LAUNCH PUSH (Apple 3.3 / 6.3: "an in-app push notification must be deployed to all
 * eligible users" at launch). An owner or admin presses this once from Settings; the whole crew's
 * phones say "Tap to Pay on iPhone is here" and where to find it. Owner/admin only because a
 * launch announcement is the company speaking, and office passes requireStaff for the books, not
 * for that.
 *
 * ONCE MEANS ONCE. The org row is CLAIMED with a null-guarded, checked write BEFORE anything is
 * sent: two admins pressing the button in the same second race for one row, the loser matches
 * zero rows and is told the date the winner already sent it. Sending first and recording second
 * would be the double-buzz this column exists to prevent.
 *
 * Refused, with the fix named, when it would be a dead end: Stripe not finished (the push would
 * point at a Pay Now that can't take cards) or push not configured on this server (the claim
 * would land and nobody would hear a thing — a "sent" that never left is the silent failure).
 *
 * `sent` is how many people it was ADDRESSED to (active owner/admin/office — orgStaffIds, the
 * same STAFF_ROLES that ELIGIBLE_ROLES is, so "eligible" and "announced to" cannot drift apart);
 * delivery still honours each person's own notification toggle and whether they have a phone
 * registered, which is theirs to decide. The toggle is the dedicated "Tap to Pay on iPhone" kind,
 * shared with the decline push: Apple's launch requirement must not be switched off as a side
 * effect of someone muting "Invoices paid". The words are Apple's own — the Marketing Guide's
 * push-notification "Value proposition" block, verbatim, short disclaimer included — because 1.9
 * says marketing copy comes from the toolkit, and a paraphrase is the thing App Review flags.
 */
export async function announceTapToPay(): Promise<{ ok: true; sent: number } | { ok: false; error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This action is staff-only." };
  const orgId = ctx.orgId;
  if (!orgId) return { ok: false, error: "Your account isn't attached to a company yet." };
  const supabase = ctx.supabase;
  const role = await callerRole(supabase, ctx.userId);
  if (!ENABLE_ROLES.includes(role)) {
    return { ok: false, error: "Only an owner or admin can send the Tap to Pay on iPhone announcement." };
  }
  if (!pushConfigured()) {
    return { ok: false, error: "Push notifications aren't configured on this server, so nobody would receive it. Nothing was sent." };
  }

  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .select("stripe_account_id, stripe_account_status, stripe_charges_enabled, tap_to_pay_announced_at")
    .eq("id", orgId)
    .maybeSingle();
  if (orgErr || !org) {
    return { ok: false, error: orgErr ? dbError(orgErr) : "Couldn't read this company's payment setup." };
  }
  const already = (org as { tap_to_pay_announced_at?: string | null }).tap_to_pay_announced_at ?? null;
  if (already) return { ok: false, error: `Already announced on ${announcedOn(already)} — it only goes out once.` };
  if (!billingEnabled) return { ok: false, error: "Card payments aren't set up on this server yet." };
  if (!canAcceptPayments(connectStateFromOrg(org as never))) {
    return {
      ok: false,
      error:
        "Card payments aren't switched on for this company yet, so the announcement would point at nothing. Finish Stripe setup in Settings → Getting Paid first.",
    };
  }

  // Claim the once, checked and null-guarded, BEFORE the send.
  const { data: claimed, error: claimErr } = await supabase
    .from("organizations")
    .update({ tap_to_pay_announced_at: new Date().toISOString() })
    .eq("id", orgId)
    .is("tap_to_pay_announced_at", null)
    .select("id");
  if (claimErr) return { ok: false, error: dbError(claimErr) };
  if (!claimed?.length) {
    const { data: again } = await supabase
      .from("organizations")
      .select("tap_to_pay_announced_at")
      .eq("id", orgId)
      .maybeSingle();
    const theirs = (again as { tap_to_pay_announced_at?: string | null } | null)?.tap_to_pay_announced_at;
    if (theirs) return { ok: false, error: `Already announced on ${announcedOn(theirs)} — someone else just sent it.` };
    return { ok: false, error: "That didn't save, so nothing was sent — check your access and try again." };
  }

  const ids = await orgStaffIds(orgId);
  await sendPushToProfiles(ids, "tap_to_pay", {
    title: "Accept in-person payments with Tap to Pay on iPhone.",
    body: "You can accept all types of contactless payments right on your iPhone—from physical debit and credit cards to Apple Pay and other digital wallets. Terms apply.",
    url: "/settings?tab=getpaid",
  });
  revalidatePath("/settings");
  return { ok: true, sent: ids.length };
}

/** "Sep 11, 2026" — for the "already announced" sentence. */
function announcedOn(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "an earlier date"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
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
        "Stripe needs your company's street address, city, state and ZIP to set up Tap to Pay on iPhone. Add them in Settings → Company, then try again.",
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
    return { ok: false, error: `Stripe couldn't set up Tap to Pay on iPhone for this company${said ? ` — ${said}` : ""}.` };
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
        // reopens the double-booking. user_id is the FIFTH, for Apple 5.12: a decline confirmed on
        // the phone after the tech pocketed it reaches Stripe as payment_intent.payment_failed, and
        // the webhook needs to know WHOSE phone to tell — the one person who was holding the card
        // reader, not the whole office.
        metadata: { kind: "invoice_payment", source: "tap_to_pay", invoice_id: inv.id, org_id: orgId, user_id: ctx.userId },
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

/**
 * LET GO OF A DOOR NOBODY WALKED THROUGH (Apple 5.6). The Pay Now sheet mints the PaymentIntent
 * when it OPENS on a phone that can tap, so the press goes straight to the reader; a sheet
 * closed without a tap would otherwise leave one open PaymentIntent per look in the tenant's
 * Stripe. Only a PaymentIntent that is still waiting for a card is cancelled — one that is
 * processing or succeeded is left exactly as it is (Stripe refuses anyway; nothing here can
 * un-charge). Own org only: the intent must carry this org's id and the Tap marker, on this
 * org's connected account, or it is not ours to touch.
 */
export async function cancelTapPaymentIntent(paymentIntentId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This action is staff-only." };
  const orgId = ctx.orgId;
  if (!orgId) return { ok: false, error: "Your account isn't attached to a company yet." };
  if (!billingEnabled) return { ok: false, error: "Card payments aren't set up on this server yet." };
  if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)) return { ok: false, error: "That isn't a payment id." };

  const { data: org, error: orgErr } = await ctx.supabase
    .from("organizations")
    .select("stripe_account_id")
    .eq("id", orgId)
    .maybeSingle();
  if (orgErr || !org) return { ok: false, error: orgErr ? dbError(orgErr) : "Couldn't read this company's payment setup." };
  const accountId = (org as { stripe_account_id?: string | null }).stripe_account_id;
  if (!accountId) return { ok: false, error: NOT_SET_UP };

  try {
    const pi = await getStripe().paymentIntents.retrieve(paymentIntentId, {}, { stripeAccount: accountId });
    if (pi.metadata?.org_id !== orgId || pi.metadata?.source !== "tap_to_pay") {
      return { ok: false, error: "That payment isn't this company's." };
    }
    const waiting = ["requires_payment_method", "requires_confirmation", "requires_action", "requires_capture"];
    if (!waiting.includes(pi.status)) return { ok: true };
    await getStripe().paymentIntents.cancel(paymentIntentId, {}, { stripeAccount: accountId });
    return { ok: true };
  } catch (e) {
    // A cancel that loses a race with a late confirm is exactly the case Stripe refuses; it is
    // logged, not surfaced — the sheet that asked is already closed.
    reportError("stripe:terminal:cancel-intent", e, { orgId, paymentIntentId });
    const said = e instanceof Error ? e.message : "";
    return { ok: false, error: `Stripe wouldn't let go of that payment${said ? ` — ${said}` : ""}.` };
  }
}
