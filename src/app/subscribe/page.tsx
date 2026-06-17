import { redirect } from "next/navigation";
import { Zap, LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { billingEnabled } from "@/lib/stripe";
import { hasActiveAccess } from "@/lib/subscription";
import { startCheckout } from "@/app/(app)/settings/billing-actions";
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

  // If billing is off or access is fine, no need to be here.
  if (!billingEnabled || (org && hasActiveAccess(org as Organization))) {
    redirect("/planner");
  }

  const isAdmin = profile.role === "owner" || profile.role === "admin";

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand to-brand-dark px-4">
      <div className="w-full max-w-md">
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
            <form action={startCheckout}>
              <Button type="submit" size="lg" className="w-full">
                Subscribe now
              </Button>
            </form>
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
