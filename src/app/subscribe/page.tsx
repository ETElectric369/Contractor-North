import { redirect } from "next/navigation";
import { NO_INDEX } from "@/lib/no-index";
import { Zap, LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { billingEnabled } from "@/lib/stripe";
import { accessState, hasActiveAccess, isCompedOrg, type BillingOrg } from "@/lib/subscription";
import { canPickPlan, stripeSubscriptionLive, subscribeHeadline } from "@/lib/lapse-doors";
import { ownerFirstName } from "@/lib/lapse-words";
import { startCheckout, openPortal } from "@/app/(app)/settings/billing-actions";
import { PLANS, INCLUDED_EVERYWHERE, plansConfigured } from "@/lib/plans";
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
 * THE WALL'S OWN PAGE (cn-v1137). The headline comes from the one access rule (accessState → the
 * reason), never re-derived from the columns. An owner/admin gets ONE door: Manage Billing when a
 * Stripe subscription is live (update the card, change the plan — Checkout beside it would bill
 * twice), the plan cards otherwise (a canceled subscription cannot be restarted from the portal; a
 * customer Stripe knows is reused by Checkout). Everyone else is told who holds the key, by name.
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

  // If billing is off, the org is comped (the env list, or comped_until through hasActiveAccess),
  // or access is fine, no need to be here.
  if (!billingEnabled || isCompedOrg(profile.org_id) || (org && hasActiveAccess(org))) {
    redirect("/planner");
  }

  const isAdmin = canPickPlan(profile.role);
  const state = org ? accessState(org) : null;
  const headline = state ? subscribeHeadline(state.reason) : "Your Plan Needs Attention";
  // The portal is the door only while a subscription is live; otherwise Checkout (one rule,
  // lib/lapse-doors, the same one startCheckout refuses on).
  const portal = !!org && stripeSubscriptionLive(org);

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
        ? "Your card or plan needs a look."
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
            ) : plansConfigured() ? (
              <>
                {/* GATE ON COST, NEVER ON LEVERAGE. Every tier ships the whole product to the
                    whole crew. What changes is how much genuinely expensive work is included —
                    plan reading and researched estimates — because that's the only thing that
                    actually costs more to serve. Never a feature, never a head count. */}
                <div className="grid gap-4 text-left sm:grid-cols-3">
                  {PLANS.map((plan) => (
                    <form key={plan.tier} action={startCheckout} className="flex flex-col rounded-xl border border-slate-200 p-5">
                      <input type="hidden" name="tier" value={plan.tier} />
                      <input type="hidden" name="cadence" value="monthly" />
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{plan.name}</div>
                      <div className="mt-1 text-3xl font-bold tabular-nums text-slate-900">
                        ${plan.monthly}
                        <span className="text-sm font-medium text-slate-400">/mo</span>
                      </div>
                      <p className="mt-1 text-xs text-slate-500">{plan.blurb}</p>
                      <p className="mt-3 text-sm text-slate-600">{plan.included}</p>
                      {/* The second axis, and the honest one: our TIME. It scales with a
                          customer's size without ever counting their people. */}
                      <p className="mt-2 flex-1 text-sm text-slate-500">{plan.support}</p>
                      <Button type="submit" className="mt-4 w-full">Choose {plan.name}</Button>
                    </form>
                  ))}
                </div>
                <div className="mt-5 text-xs text-slate-400">
                  <p className="font-medium text-slate-500">On every plan, at every price:</p>
                  <ul className="mt-1 space-y-0.5">
                    {INCLUDED_EVERYWHERE.map((line) => (
                      <li key={line}>· {line}</li>
                    ))}
                  </ul>
                  {/* Say the honest thing about the metered part rather than letting someone
                      discover it. Running out never stops work — it gets simpler, not gone. */}
                  <p className="mt-2">
                    Reading plans and researching live prices costs us real money each time, so that&rsquo;s the
                    one thing the plans count. Go past it and estimates keep working — they just get simpler
                    until the month turns. Nothing locks, and your crew never stops.
                  </p>
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

// Never index auth/utility chrome — on a tenant's custom domain this page previously leaked a
// "Contractor North" title into crawlers with no noindex (the SEO vendor's "hosted on
// contractornorth" ammunition). Both layers per the no-index doctrine: this metadata + robots.txt.
export const metadata = { title: "Subscribe", robots: NO_INDEX };
