"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getStripe, STRIPE_PRICE_ID } from "@/lib/stripe";
import { accountUpdateFields } from "@/lib/stripe-connect";
import { planByTier, priceIdFor } from "@/lib/plans";
import { reportError } from "@/lib/observe";
import { stripeSubscriptionLive, SECOND_SUBSCRIPTION_REFUSAL, NO_BILLING_ACCOUNT_REFUSAL } from "@/lib/lapse-doors";
import { shellFromUserAgent } from "@/lib/native-shell";
import { getOrgSettings } from "@/lib/org-settings";
import { monthKeyFor } from "@/lib/usage-window";
import {
  ADD_USAGE_NOT_CONFIGURED,
  ADD_USAGE_NOT_PRICED,
  ADD_USAGE_WEB_ONLY,
  NO_PLAN_CONFIGURED,
  NO_SUCH_PLAN,
  PICK_PLAN_WEB_ONLY,
  extraUsagePriceId,
  extraUsageUsdOf,
  planNotConfiguredWords,
} from "./billing-doors";

function siteUrl() {
  return process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000";
}

async function loadOwnerOrg() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("org_id, role, active")
    .eq("id", user.id)
    .maybeSingle();

  // A deactivated seat is refused here too (audit v921 critical — see staff-guard.ts).
  if (!profile?.org_id || !["owner", "admin"].includes(profile.role) || profile.active === false) {
    redirect("/settings?tab=getpaid&billing_error=Only an owner or admin can manage billing.");
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("*")
    .eq("id", profile!.org_id)
    .single();

  return { supabase, org };
}

export async function startCheckout(formData?: FormData) {
  const { org } = await loadOwnerOrg();
  // THE APP STORE APP SELLS NOTHING (Apple 3.1.1): /subscribe hides the plan cards there, and a form
  // posted from the shell is refused in words — exactly as buyExtraUsage is.
  if (shellFromUserAgent((await headers()).get("user-agent")).native) {
    redirect(`/settings?tab=getpaid&billing_error=${encodeURIComponent(PICK_PLAN_WEB_ONLY)}`);
  }
  // NEVER A SECOND SUBSCRIPTION ON THE SAME CUSTOMER (cn-v1137). A subscription that is live (or
  // past due, or waiting on a card) is managed in the portal; a Checkout beside it would bill the
  // company twice. A canceled one cannot be restarted from the portal, so Checkout is its door and
  // reuses the customer below. One rule, lib/lapse-doors, shared with the doors that offer it.
  if (stripeSubscriptionLive(org)) {
    redirect(`/settings?tab=getpaid&billing_error=${encodeURIComponent(SECOND_SUBSCRIPTION_REFUSAL)}`);
  }
  let url: string | null = null;
  let errMsg: string | null = null;

  // WHICH TIER + CADENCE (cn-v1140): /subscribe's cards post both (monthly or annual, lib/plans
  // priceIdFor). A tier that was posted is honored or refused in words — never quietly swapped for
  // the legacy price under a plan the person did not choose. No tier at all is the legacy Subscribe
  // Now door: the one price an install configured the old way (STRIPE_PRICE_ID) keeps working.
  const tier = String(formData?.get("tier") ?? "");
  const cadence = String(formData?.get("cadence") ?? "monthly") === "annual" ? "annual" : "monthly";
  let priceId: string | null = null;
  if (tier) {
    const plan = planByTier(tier);
    priceId = plan ? priceIdFor(plan.tier, cadence) : null;
    if (!priceId) errMsg = plan ? planNotConfiguredWords(plan.name, cadence) : NO_SUCH_PLAN;
  } else {
    priceId = STRIPE_PRICE_ID || null;
    if (!priceId) errMsg = NO_PLAN_CONFIGURED;
  }

  if (!priceId) {
    errMsg = errMsg ?? NO_PLAN_CONFIGURED;
  } else {
    try {
      const stripe = getStripe();
      let customerId = org.stripe_customer_id as string | null;
      if (!customerId) {
        const customer = await stripe.customers.create({
          name: org.name,
          email: org.email ?? undefined,
          metadata: { org_id: org.id },
        });
        customerId = customer.id;
        // SERVICE CLIENT, AND CHECKED. This is the ONLY writer of stripe_customer_id in the repo,
        // and 0161 pins that column against every signed-in role — so on the user's client it was
        // a silent 403 (bare await, no error captured) and the column stayed NULL on every org
        // forever. Consequences, all of them invisible: a paying subscriber pressing Manage
        // Billing is told "No billing account yet — subscribe first"; every checkout mints ANOTHER
        // orphan Stripe customer; and invoice.payment_failed can't resolve the org, so the
        // card-declined push has never fired for anybody. The correct pattern is 80 lines below
        // in this same file (connectPayments).
        const admin = createServiceClient();
        const { error: linkErr } = await admin
          .from("organizations")
          .update({ stripe_customer_id: customerId })
          .eq("id", org.id);
        // Do NOT continue to checkout if the link didn't land — an unlinked customer is exactly
        // how the orphans were minted, one per attempt. This function is a FORM ACTION and must
        // resolve to void, so it signals the way its siblings do: through billing_error.
        if (linkErr) throw new Error(`link-customer: ${linkErr.message}`);
      }

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${siteUrl()}/settings?tab=getpaid&billing=success`,
        cancel_url: `${siteUrl()}/settings?tab=getpaid&billing=cancelled`,
        metadata: { org_id: org.id },
        subscription_data: { metadata: { org_id: org.id } },
      });
      url = session.url;
    } catch (e: any) {
      // SAY IT SOMEWHERE THAT KEEPS (cn-v949). Stripe's own Health panel showed a failed
      // POST /v1/accounts that this app had no record of: every Stripe refusal on this page
      // went into a query string that the next click erased. The person still sees the
      // message; now the ops log does too.
      reportError("stripe:checkout:create", e, { orgId: org.id, priceId });
      errMsg = e?.message ?? "Stripe error";
    }
  }

  // Redirects live OUTSIDE the try so they aren't swallowed by the catch.
  if (errMsg) redirect(`/settings?tab=getpaid&billing_error=${encodeURIComponent(errMsg)}`);
  redirect(url ?? "/settings?tab=getpaid&billing_error=Could not start checkout.");
}

export async function openPortal() {
  const { org } = await loadOwnerOrg();
  let url: string | null = null;
  let errMsg: string | null = null;

  if (!org.stripe_customer_id) {
    errMsg = NO_BILLING_ACCOUNT_REFUSAL;
  } else {
    try {
      const stripe = getStripe();
      const session = await stripe.billingPortal.sessions.create({
        customer: org.stripe_customer_id,
        return_url: `${siteUrl()}/settings?tab=getpaid`,
      });
      url = session.url;
    } catch (e: any) {
      reportError("stripe:portal:create", e, { orgId: org.id, customerId: org.stripe_customer_id });
      errMsg = e?.message ?? "Stripe error";
    }
  }

  if (errMsg) redirect(`/settings?tab=getpaid&billing_error=${encodeURIComponent(errMsg)}`);
  redirect(url ?? "/settings");
}

/**
 * ADD USAGE (cn-v1140): a one-time payment that raises this month's usage cap. The plan card's
 * second door (Erik's design: Upgrade and Add Usage, nothing to explain).
 *
 * WHO AND WHERE: the owner or an admin (loadOwnerOrg refuses the rest in words), on the WEB — the
 * App Store app sells nothing (Apple 3.1.1): the card hides the door there, and a form posted from
 * the shell is refused in words. WHAT: STRIPE_PRICE_EXTRA_USAGE (billing-doors; the door is hidden
 * when it is unset), retrieved with its product expanded so product.metadata.usage_usd — the
 * internal dollars the purchase adds — is read ONCE here and written into the session's metadata as
 * a string; the webhook (checkout.session.completed, kind "extra_usage") lands that figure as a
 * usage_topups row (0401) for the month named here, keyed on the company's own calendar. ON OUR
 * ACCOUNT: the same client startCheckout uses, never a connected account — this is the company's
 * bill from us. The customer is the company's Stripe customer when it has one (so the receipt
 * lands beside the subscription's), else Checkout collects the email.
 *
 * The way home: success lands on the card with ?usage=added ("Added — it shows on the ring within
 * a minute": the webhook writes, the page only reads), cancel on the card as it was.
 */
export async function buyExtraUsage() {
  const { org } = await loadOwnerOrg();
  if (shellFromUserAgent((await headers()).get("user-agent")).native) {
    redirect(`/settings?tab=getpaid&billing_error=${encodeURIComponent(ADD_USAGE_WEB_ONLY)}`);
  }
  const priceId = extraUsagePriceId();
  if (!priceId) {
    redirect(`/settings?tab=getpaid&billing_error=${encodeURIComponent(ADD_USAGE_NOT_CONFIGURED)}`);
  }
  let url: string | null = null;
  let errMsg: string | null = null;

  try {
    const stripe = getStripe();
    const price = await stripe.prices.retrieve(priceId, { expand: ["product"] });
    const usageUsd = extraUsageUsdOf(price);
    if (!usageUsd) {
      // A price with no usage behind it would sell nothing the ring could show: refused, and filed
      // where North's own team reads it (the product's metadata is the fix).
      reportError("stripe:extra-usage:unpriced", new Error("the extra-usage price's product has no positive metadata.usage_usd"), {
        orgId: org.id,
        priceId,
      });
      errMsg = ADD_USAGE_NOT_PRICED;
    } else {
      const month = monthKeyFor(new Date(), getOrgSettings(org.settings).timezone);
      const customerId = (org.stripe_customer_id as string | null) ?? null;
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        ...(customerId ? { customer: customerId } : { customer_email: (org.email as string | null) ?? undefined }),
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${siteUrl()}/settings?tab=getpaid&usage=added`,
        cancel_url: `${siteUrl()}/settings?tab=getpaid`,
        // THE SHAPE THE WEBHOOK READS, verbatim (api/stripe/webhook): kind, the company, the month
        // the top-up belongs to, and the usage it adds.
        metadata: { kind: "extra_usage", org_id: org.id, month, usage_usd: String(usageUsd) },
      });
      url = session.url;
    }
  } catch (e: any) {
    reportError("stripe:extra-usage:create", e, { orgId: org.id, priceId });
    errMsg = e?.message ?? "Stripe error";
  }

  // Redirects live OUTSIDE the try so they aren't swallowed by the catch.
  if (errMsg) redirect(`/settings?tab=getpaid&billing_error=${encodeURIComponent(errMsg)}`);
  redirect(url ?? "/settings?tab=getpaid&billing_error=Could not start checkout.");
}

/**
 * ── STRIPE CONNECT: let this contractor take card payments from THEIR customers ──
 *
 * Creates (or resumes) an Express account owned by the contractor and returns a
 * Stripe-hosted onboarding link. Stripe collects their identity, tax and bank details
 * directly — we never see or store any of it. Charges are then created ON their
 * account (direct charges), so their customers' money goes to their bank, not ours.
 *
 * Idempotent: an org that already has an account gets a fresh link into the same one,
 * so an interrupted onboarding resumes instead of orphaning accounts.
 */
export async function connectPayments() {
  const { org } = await loadOwnerOrg();
  let url: string | null = null;
  let errMsg: string | null = null;

  try {
    const stripe = getStripe();
    let accountId = org.stripe_account_id as string | null;

    if (!accountId) {
      /**
       * THE KEY MUST DEDUPE A DOUBLE-TAP WITHOUT OUTLIVING A FAILURE (cn-v950).
       *
       * ONE ORG, ONE EXPRESS ACCOUNT (audit v921): a double-tap, a second tab, or a retry after a
       * failed link write each minted another acct_…, so the call was keyed on the org and Stripe
       * replayed the first account instead of creating a second one. That part worked.
       *
       * What it also did, which nobody asked for: Stripe stores the response to an idempotency key
       * for about a day, AND IT STORES FAILURES. ET Electric's first live attempt was refused
       * because the platform profile had not yet declared who carries losses on connected accounts.
       * The next four attempts — the last of them twenty hours later — were replays of that stored
       * 400, verbatim, out of Stripe's cache. Completing the platform profile changed nothing the
       * app could see: it kept reading back an answer from before the fix, and the account could
       * not be created until the key aged out. A permanently deterministic key turns one bad
       * minute into a locked-out day for a brand new contractor.
       *
       * So the key now rotates on a short window. Two taps a second apart still share a window and
       * still dedupe, which is the hazard v921 was actually about. A retry by someone who has gone
       * away and fixed something gets a fresh key, and therefore a fresh answer.
       */
      const mintWindow = Math.floor(Date.now() / (15 * 60 * 1000));
      const account = await stripe.accounts.create({
        type: "express",
        email: org.email ?? undefined,
        business_profile: {
          name: org.name ?? undefined,
          // What their customers see on a card statement.
          support_email: org.email ?? undefined,
        },
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        metadata: { org_id: org.id },
      }, { idempotencyKey: `connect-account-${org.id}-${mintWindow}` });
      accountId = account.id;
      // Service-role write: 0161 pins these columns against the client on purpose.
      // AND CHECKED (audit v921) — this was a bare await, the very pattern startCheckout's comment
      // above points at as "the correct pattern". If the link doesn't land, the owner still gets
      // sent into Stripe to hand over identity and bank details for an account no org row names:
      // account.updated matches nothing, Connect status stays empty, and the next click mints
      // another Express account. Fail here instead, before the onboarding link.
      const admin = createServiceClient();
      const { data: linked, error: linkErr } = await admin
        .from("organizations")
        .update({ stripe_account_id: accountId, stripe_account_status: "pending" })
        .eq("id", org.id)
        .select("id");
      if (linkErr || !linked?.length) {
        throw new Error(`link-account: ${linkErr?.message ?? "the account wasn't saved to your company"}`);
      }
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      // Stripe expires these links quickly; both URLs come back here so a refresh
      // just mints a new one rather than dead-ending.
      refresh_url: `${siteUrl()}/settings?tab=getpaid&connect=refresh`,
      return_url: `${siteUrl()}/settings?tab=getpaid&connect=done`,
      type: "account_onboarding",
    });
    url = link.url;
  } catch (e: any) {
    // THE ONE FAILURE A CONTRACTOR CANNOT WORK AROUND: no Express account, no card payments,
    // no Tap to Pay on iPhone. It is also the exact call Stripe's Health panel caught failing.
    reportError("stripe:connect:onboard", e, { orgId: org.id, accountId: org.stripe_account_id ?? null });
    errMsg = e?.message ?? "Stripe error";
  }

  if (errMsg) redirect(`/settings?tab=getpaid&billing_error=${encodeURIComponent(errMsg)}`);
  redirect(url ?? "/settings");
}

/**
 * A LINK TO the contractor's own Stripe dashboard (payouts, refunds, disputes) — RETURNED, NOT
 * FOLLOWED.
 *
 * Erik, after finding the money: "i couldnt get back to the app from stripe screen."
 *
 * Every other door out of this app hands Stripe or Google a way home — checkout has
 * success_url/cancel_url, the billing portal has return_url, Connect onboarding has
 * return_url AND refresh_url, both OAuth callbacks land back on /settings. THIS one had none,
 * because Stripe's Express dashboard takes no return parameter and offers no link back: it is a
 * destination, not a detour. Redirecting the tab into it therefore replaced the app with a page
 * that cannot return — the NO DEAD ENDS law broken by the one door that had no way to obey it.
 *
 * So the app stops walking through this door. The action mints the link and hands it back; the
 * button opens it in a NEW tab (PayoutsLinkButton) and the app stays exactly where it was. On the
 * native shell connect.stripe.com is not in allowNavigation, so the same call hands it to the
 * system browser — again leaving the app running behind it.
 */
export async function payoutsDashboardLink(): Promise<{ url?: string; error?: string }> {
  const { org } = await loadOwnerOrg();
  if (!org.stripe_account_id) return { error: "Connect a Stripe account first." };
  try {
    const link = await getStripe().accounts.createLoginLink(org.stripe_account_id as string);
    return { url: link.url };
  } catch (e: any) {
    reportError("stripe:connect:login-link", e, { orgId: org.id, accountId: org.stripe_account_id });
    return { error: e?.message ?? "Stripe error" };
  }
}

/** Not exported: a "use server" module may only export async functions, and nothing outside this
 *  file needs the name — the Settings page infers it. */
type ConnectSync = {
  ok: boolean;
  chargesEnabled?: boolean;
  status?: string;
  error?: string;
};

/**
 * Pull the connected account's current state from Stripe and mirror it onto our columns.
 *
 * TWO THINGS WERE WRONG WITH THIS (audit finding 3).
 *
 * It swallowed everything. `catch {}` and a bare `{ ok: false }` meant a Stripe outage, a revoked
 * key, a deleted account and a mirror write that matched no row were all the same silent shrug —
 * the one Stripe call on this page that cn-v949 did not teach to say where it went. Every refusal
 * now reaches reportError with the account it was asking about, and comes back carrying a sentence
 * a contractor can act on instead of a bare false.
 *
 * And nothing called it. It exists precisely so the contractor coming back from Stripe onboarding
 * sees the truth immediately instead of waiting on the account.updated webhook — but no caller
 * existed anywhere in the app, so an account whose state changed in Stripe (documents accepted,
 * payouts disabled, a capability revoked) never re-mirrored until a webhook happened to arrive.
 * The Settings page now runs it on the return trip (connect=done) and offers a Refresh Status
 * button beside the card.
 */
export async function refreshConnectStatus(opts?: { revalidate?: boolean }): Promise<ConnectSync> {
  const { org } = await loadOwnerOrg();
  if (!org.stripe_account_id) return { ok: false, error: "Connect a Stripe account first." };
  try {
    const account = await getStripe().accounts.retrieve(org.stripe_account_id);
    const fields = accountUpdateFields(account);
    const admin = createServiceClient();
    // .select("id") — same reason as the link write above (audit v921): a mirror that didn't land
    // reported ok with Stripe's live numbers, so the badge said "Ready to take cards" off a row
    // that never changed.
    const { data: mirrored, error } = await admin
      .from("organizations")
      .update(fields)
      .eq("id", org.id)
      .select("id");
    if (error || !mirrored?.length) {
      // A zero-row update is a 204 (silent-write law). Stripe answered; our own row did not move,
      // which is a bug on our side and belongs in the ops log, not in a boolean.
      reportError("stripe:connect:status-mirror", error ?? new Error("the status update matched no organization row"), {
        orgId: org.id,
        accountId: org.stripe_account_id,
      });
      return {
        ok: false,
        error: "Stripe answered, but your payment status didn't save here. Try Refresh Status again in a minute.",
      };
    }
    // Skipped when the Settings page calls this from its own render: the page is force-dynamic, so
    // there is nothing cached to bust, and revalidating a route while rendering it is not allowed.
    if (opts?.revalidate !== false) revalidatePath("/settings");
    return { ok: true, chargesEnabled: fields.stripe_charges_enabled, status: fields.stripe_account_status };
  } catch (e: any) {
    reportError("stripe:connect:status-refresh", e, { orgId: org.id, accountId: org.stripe_account_id });
    return { ok: false, error: e?.message ?? "Stripe error" };
  }
}

/**
 * The Settings card's "Refresh Status" button. A form action, so it carries its answer back the way
 * every other door on this page does — on the URL, where the card renders it. The result is never
 * thrown away: ok or not, the contractor is told, and a failure already sits in the ops log.
 */
export async function refreshConnectStatusForm(): Promise<void> {
  const res = await refreshConnectStatus();
  redirect(
    res.ok
      ? "/settings?tab=getpaid&connect=refreshed"
      : `/settings?tab=getpaid&connect_error=${encodeURIComponent(
          res.error ?? "Could not check your status with Stripe.",
        )}`,
  );
}
