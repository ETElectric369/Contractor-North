import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { NO_INDEX } from "@/lib/no-index";
import { shellFromUserAgent } from "@/lib/native-shell";
import { PICK_PLAN_WEB_ONLY } from "@/app/(app)/settings/billing-doors";
import { Zap, LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { billingEnabled } from "@/lib/stripe";
import { accessState, isCompedOrg, type AccessState, type BillingOrg } from "@/lib/subscription";
import { canPickPlan, stripeSubscriptionLive, subscribeHeadline } from "@/lib/lapse-doors";
import { ownerFirstName } from "@/lib/lapse-words";
import { startCheckout, openPortal } from "@/app/(app)/settings/billing-actions";
import { PLANS, INCLUDED_EVERYWHERE, plansConfigured, priceIdFor } from "@/lib/plans";
import { signOut } from "@/app/login/actions";
import { Button } from "@/components/ui/button";
import { reportError } from "@/lib/observe";

export const dynamic = "force-dynamic";

/** The columns this page decides from: the billing spine's plus the two Stripe ids. */
type SubscribeOrg = BillingOrg & {
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
};

/**
 * THE WALL'S OWN PAGE (cn-v1137), AND PICK A PLAN (cn-v1140). The headline comes from the one
 * access rule (accessState → the reason), never re-derived from the columns. An owner/admin gets
 * ONE door: Manage Billing when a Stripe subscription is live (update the card, change the plan —
 * Checkout beside it would bill twice), the plan cards otherwise (a canceled subscription cannot be
 * restarted from the portal; a customer Stripe knows is reused by Checkout). Everyone else is told
 * who holds the key, by name.
 *
 * WHO LANDS HERE (cn-v1140): the plan card's Upgrade door sends a trial or a lapsed company here, so
 * a standing company is no longer bounced to /planner — a trial reads "Pick A Plan", a lapsed
 * company its reason, and an ACTIVE live subscriber the one door that switches a plan (the portal).
 * Only a comped company (the column or the env list) and an install with billing off have nothing
 * to pick, and go home. Each plan card posts its tier AND its cadence: monthly, or yearly at the
 * monthly-equivalent price PLANS carries — and only the cadences the install has a price for.
 *
 * INSIDE THE APP STORE APP (Apple 3.1.1) the page sells nothing: no plan cards, no Subscribe Now —
 * one line, "Pick a plan on the web at app.contractornorth.com." Manage Billing (the portal) stands
 * there as it does on the plan card; startCheckout refuses a form posted from the shell in the same
 * words.
 */
export default async function SubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ billing_error?: string }>;
}) {
  const { billing_error } = await searchParams;
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
  if (!profile?.org_id) redirect("/onboarding");

  const { data: orgRow, error: orgErr } = await supabase
    .from("organizations")
    .select("*")
    .eq("id", profile.org_id)
    .maybeSingle();
  // A failed read is said (in the sink here, on the page below) — never a confident wrong headline.
  if (orgErr) reportError("subscribe:org-read", orgErr, { orgId: profile.org_id });
  const org = (orgRow as SubscribeOrg | null) ?? null;

  const state = org ? accessState(org) : null;
  // If billing is off or the company is comped (the env list, or comped_until through the one
  // access rule), there is nothing to pick: home. A trial, a lapsed company and a live subscriber
  // all have a door here (cn-v1140).
  if (!billingEnabled || isCompedOrg(profile.org_id) || state?.reason === "comped") {
    redirect("/planner");
  }

  const isAdmin = canPickPlan(profile.role);
  const inShell = shellFromUserAgent((await headers()).get("user-agent")).native;
  // The portal is the door only while a subscription is live; otherwise Checkout (one rule,
  // lib/lapse-doors, the same one startCheckout refuses on).
  const portal = !!org && stripeSubscriptionLive(org);
  const headline = state ? headlineFor(state, portal) : "Your Plan Needs Attention";

  // WHO HOLDS THE KEY, for everyone who cannot pick a plan: the company's active owner, by first
  // name, through THE one owner read every paused door uses (lib/lapse-words ownerFirstName — the
  // service client, so a tech's RLS cannot hide the owner's row; a failed read is filed there and
  // reads "the owner"). Read only for someone who cannot pick a plan.
  const ownerFirst = isAdmin ? "the owner" : ((await ownerFirstName(profile.org_id)) ?? "the owner");

  const subline = !org
    ? "We couldn't read your plan just now — try again in a moment."
    : !isAdmin
      ? `Ask ${ownerFirst} to pick a plan.`
      : portal
        ? state?.active && state.reason === "active"
          ? "Switch plans or update the card there."
          : "Your card or plan needs a look."
        : inShell
          ? PICK_PLAN_WEB_ONLY
          : "Pick a plan to keep using Contractor North.";

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand to-brand-dark px-4">
      <div className="w-full max-w-3xl">
        <div className="mb-8 text-center text-white">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/15 backdrop-blur">
            <Zap className="h-7 w-7" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">{headline}</h1>
          <p className="mt-1 text-sm text-white/80">{subline}</p>
        </div>

        <div className="rounded-2xl bg-white p-8 shadow-xl text-center">
          {billing_error && (
            <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
              {billing_error}
            </div>
          )}

          {!org ? (
            // The plan could not be read: one action, and nothing decided on a guess.
            <a href="/subscribe" className="inline-flex min-h-11 items-center justify-center rounded-xl bg-slate-900 px-5 text-sm font-semibold text-white">
              Try Again
            </a>
          ) : isAdmin ? (
            portal ? (
              <>
                <form action={openPortal}>
                  <Button type="submit" size="lg" className="w-full">Manage Billing</Button>
                </form>
                <p className="mt-3 text-sm text-slate-600">Update the card or pick a plan there.</p>
              </>
            ) : inShell ? (
              // The App Store app sells nothing (Apple 3.1.1): the one line, and no form at all.
              <p className="text-sm text-slate-600">{PICK_PLAN_WEB_ONLY}</p>
            ) : plansConfigured() ? (
              <>
                {/* GATE ON COST, NEVER ON LEVERAGE. Every tier ships the whole product to the
                    whole crew. What changes is the month's Usage — the model spend a plan includes
                    (1× / 3× / 8×, lib/plans) — because that's the only thing that actually costs
                    more to serve. Never a feature, never a head count. */}
                <div className="grid gap-4 text-left sm:grid-cols-3">
                  {PLANS.map((plan) => {
                    // ONE FORM, TWO CADENCES: the tier rides hidden; the button pressed posts its
                    // cadence (a submit button's name=value is part of the form data). A cadence the
                    // install has no price for draws no door — never a button that leads to a refusal.
                    const monthly = !!priceIdFor(plan.tier, "monthly");
                    const annual = !!priceIdFor(plan.tier, "annual");
                    return (
                      <form key={plan.tier} action={startCheckout} className="flex flex-col rounded-xl border border-slate-200 p-5">
                        <input type="hidden" name="tier" value={plan.tier} />
                        <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{plan.name}</div>
                        <div className="mt-1 text-3xl font-bold tabular-nums text-slate-900">
                          ${plan.monthly}
                          <span className="text-sm font-medium text-slate-400">/mo</span>
                        </div>
                        {annual && (
                          <p className="text-xs tabular-nums text-slate-500">
                            ${plan.annual}/mo billed yearly
                          </p>
                        )}
                        <p className="mt-1 text-xs text-slate-500">{plan.blurb}</p>
                        <p className="mt-3 text-sm text-slate-600">{plan.included}</p>
                        {/* The second axis, and the honest one: our TIME. It scales with a
                            customer's size without ever counting their people. */}
                        <p className="mt-2 flex-1 text-sm text-slate-500">{plan.support}</p>
                        {monthly && (
                          <Button type="submit" name="cadence" value="monthly" className="mt-4 w-full">
                            Choose {plan.name}
                          </Button>
                        )}
                        {annual && (
                          <Button type="submit" name="cadence" value="annual" variant="outline" className="mt-2 w-full">
                            Yearly At ${plan.annual}/mo
                          </Button>
                        )}
                      </form>
                    );
                  })}
                </div>
                <div className="mt-5 text-xs text-slate-400">
                  <p className="font-medium text-slate-500">On every plan, at every price:</p>
                  <ul className="mt-1 space-y-0.5">
                    {INCLUDED_EVERYWHERE.map((line) => (
                      <li key={line}>· {line}</li>
                    ))}
                  </ul>
                  {/* Say the honest thing about the metered part rather than letting someone
                      discover it. Running out never stops work — it runs lighter, not gone. */}
                  <p className="mt-2">Usage resets on the 1st. Past it, things run lighter — nothing stops.</p>
                </div>
              </>
            ) : (
              <form action={startCheckout}>
                <Button type="submit" size="lg" className="w-full">Subscribe Now</Button>
              </form>
            )
          ) : (
            <p className="text-sm text-slate-600">
              Nothing is lost. Your work is here the moment a plan is picked.
            </p>
          )}

          {/* THE DOOR THE LAPSED NOTICE PROMISED (skeptic #43, S7): "Download For Your Accountant stays
              open" — so the page the wall lands on links it, for the people the wall lets through. */}
          {org && isAdmin && (
            <p className="mt-4">
              <a href="/analytics/accountant" className="inline-flex min-h-11 items-center justify-center text-sm font-medium text-brand hover:underline">
                Download For Your Accountant
              </a>
            </p>
          )}

          <form action={signOut} className="mt-4">
            <button className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-700">
              <LogOut className="h-4 w-4" /> Sign Out
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

/**
 * The headline: a lapsed company's reason (cn-v1137 subscribeHeadline); a standing company's door —
 * "Pick A Plan" for a trial (or any standing company with no live Stripe subscription), "Change Your
 * Plan" for an active live subscriber (the portal is the door), and the reason's own words for a
 * card in its grace window ("Your Plan Needs Attention": the portal, to update the card).
 */
function headlineFor(state: AccessState, portal: boolean): string {
  if (!state.active) return subscribeHeadline(state.reason);
  if (state.reason === "grace") return subscribeHeadline(state.reason);
  return portal ? "Change Your Plan" : "Pick A Plan";
}

// Never index auth/utility chrome — on a tenant's custom domain this page previously leaked a
// "Contractor North" title into crawlers with no noindex (the SEO vendor's "hosted on
// contractornorth" ammunition). Both layers per the no-index doctrine: this metadata + robots.txt.
export const metadata = { title: "Subscribe", robots: NO_INDEX };
