import { redirect } from "next/navigation";
import { NO_INDEX } from "@/lib/no-index";
import { Zap, LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { billingEnabled } from "@/lib/stripe";
import { hasActiveAccess, isCompedOrg } from "@/lib/subscription";
import { startCheckout } from "@/app/(app)/settings/billing-actions";
import { PLANS, plansConfigured } from "@/lib/plans";
import { signOut } from "@/app/login/actions";
import { Button } from "@/components/ui/button";
import type { Organization } from "@/lib/types";

export const dynamic = "force-dynamic";

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

  const { data: org } = await supabase
    .from("organizations")
    .select("*")
    .eq("id", profile.org_id)
    .maybeSingle();

  // If billing is off, the org is comped, or access is fine, no need to be here.
  if (!billingEnabled || isCompedOrg(profile.org_id) || (org && hasActiveAccess(org as Organization))) {
    redirect("/planner");
  }

  const isAdmin = profile.role === "owner" || profile.role === "admin";

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand to-brand-dark px-4">
      <div className="w-full max-w-3xl">
        <div className="mb-8 text-center text-white">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/15 backdrop-blur">
            <Zap className="h-7 w-7" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Your trial has ended</h1>
          <p className="mt-1 text-sm text-white/80">
            Subscribe to keep using Contractor North.
          </p>
        </div>

        <div className="rounded-2xl bg-white p-8 shadow-xl text-center">
          {billing_error && (
            <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
              {billing_error}
            </div>
          )}

          {isAdmin ? (
            plansConfigured() ? (
              <>
                {/* EVERY tier ships the whole product. What changes is how much
                    autonomous work Nort does — never features, never per-person. */}
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
                      <p className="mt-3 flex-1 text-sm text-slate-600">{plan.autonomy}</p>
                      <Button type="submit" className="mt-4 w-full">Choose {plan.name}</Button>
                    </form>
                  ))}
                </div>
                <p className="mt-5 text-xs text-slate-400">
                  Every plan includes everything — unlimited crew, no per-person charge, and no cut of your work.
                </p>
              </>
            ) : (
              <form action={startCheckout}>
                <Button type="submit" size="lg" className="w-full">Subscribe now</Button>
              </form>
            )
          ) : (
            <p className="text-sm text-slate-600">
              Ask your company owner to renew the subscription to regain access.
            </p>
          )}

          <form action={signOut} className="mt-4">
            <button className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-slate-700">
              <LogOut className="h-4 w-4" /> Sign out
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
