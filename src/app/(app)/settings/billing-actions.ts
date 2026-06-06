"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getStripe, STRIPE_PRICE_ID } from "@/lib/stripe";

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
