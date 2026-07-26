"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient, createServiceClient } from "@/lib/supabase/server";
import { getStripe, STRIPE_PRICE_ID } from "@/lib/stripe";
import { accountUpdateFields } from "@/lib/stripe-connect";

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
    .select("org_id, role")
    .eq("id", user.id)
    .maybeSingle();

  if (!profile?.org_id || !["owner", "admin"].includes(profile.role)) {
    redirect("/settings?billing_error=Only an owner or admin can manage billing.");
  }

  const { data: org } = await supabase
    .from("organizations")
    .select("*")
    .eq("id", profile!.org_id)
    .single();

  return { supabase, org };
}

export async function startCheckout() {
  const { supabase, org } = await loadOwnerOrg();
  let url: string | null = null;
  let errMsg: string | null = null;

  if (!STRIPE_PRICE_ID) {
    errMsg = "STRIPE_PRICE_ID is not configured.";
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
        await supabase
          .from("organizations")
          .update({ stripe_customer_id: customerId })
          .eq("id", org.id);
      }

      const session = await stripe.checkout.sessions.create({
        mode: "subscription",
        customer: customerId,
        line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
        success_url: `${siteUrl()}/settings?billing=success`,
        cancel_url: `${siteUrl()}/settings?billing=cancelled`,
        metadata: { org_id: org.id },
        subscription_data: { metadata: { org_id: org.id } },
      });
      url = session.url;
    } catch (e: any) {
      errMsg = e?.message ?? "Stripe error";
    }
  }

  // Redirects live OUTSIDE the try so they aren't swallowed by the catch.
  if (errMsg) redirect(`/settings?billing_error=${encodeURIComponent(errMsg)}`);
  redirect(url ?? "/settings?billing_error=Could not start checkout.");
}

export async function openPortal() {
  const { org } = await loadOwnerOrg();
  let url: string | null = null;
  let errMsg: string | null = null;

  if (!org.stripe_customer_id) {
    errMsg = "No billing account yet — subscribe first.";
  } else {
    try {
      const stripe = getStripe();
      const session = await stripe.billingPortal.sessions.create({
        customer: org.stripe_customer_id,
        return_url: `${siteUrl()}/settings`,
      });
      url = session.url;
    } catch (e: any) {
      errMsg = e?.message ?? "Stripe error";
    }
  }

  if (errMsg) redirect(`/settings?billing_error=${encodeURIComponent(errMsg)}`);
  redirect(url ?? "/settings");
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
      });
      accountId = account.id;
      // Service-role write: 0161 pins these columns against the client on purpose.
      const admin = createServiceClient();
      await admin
        .from("organizations")
        .update({ stripe_account_id: accountId, stripe_account_status: "pending" })
        .eq("id", org.id);
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      // Stripe expires these links quickly; both URLs come back here so a refresh
      // just mints a new one rather than dead-ending.
      refresh_url: `${siteUrl()}/settings?connect=refresh`,
      return_url: `${siteUrl()}/settings?connect=done`,
      type: "account_onboarding",
    });
    url = link.url;
  } catch (e: any) {
    errMsg = e?.message ?? "Stripe error";
  }

  if (errMsg) redirect(`/settings?billing_error=${encodeURIComponent(errMsg)}`);
  redirect(url ?? "/settings");
}

/** Open the contractor's own Stripe dashboard (payouts, refunds, disputes). */
export async function openPayoutsDashboard() {
  const { org } = await loadOwnerOrg();
  let url: string | null = null;
  let errMsg: string | null = null;

  if (!org.stripe_account_id) {
    errMsg = "Connect a Stripe account first.";
  } else {
    try {
      const link = await getStripe().accounts.createLoginLink(org.stripe_account_id);
      url = link.url;
    } catch (e: any) {
      errMsg = e?.message ?? "Stripe error";
    }
  }

  if (errMsg) redirect(`/settings?billing_error=${encodeURIComponent(errMsg)}`);
  redirect(url ?? "/settings");
}

/**
 * Pull the connected account's current state from Stripe and mirror it locally.
 * Called when the contractor returns from onboarding, so the UI is correct
 * immediately instead of waiting for the account.updated webhook to arrive.
 */
export async function refreshConnectStatus(): Promise<{ ok: boolean; chargesEnabled?: boolean }> {
  const { org } = await loadOwnerOrg();
  if (!org.stripe_account_id) return { ok: false };
  try {
    const account = await getStripe().accounts.retrieve(org.stripe_account_id);
    const fields = accountUpdateFields(account);
    const admin = createServiceClient();
    await admin.from("organizations").update(fields).eq("id", org.id);
    revalidatePath("/settings");
    return { ok: true, chargesEnabled: fields.stripe_charges_enabled };
  } catch {
    return { ok: false };
  }
}
