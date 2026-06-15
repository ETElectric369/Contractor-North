import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppNav } from "@/components/app-shell/app-nav";
import { Topbar } from "@/components/app-shell/topbar";
import { GlobalVoiceButton } from "@/components/global-voice-button";
import { GlobalQuickAdd } from "@/components/global-quick-add";
import { CommandBar } from "@/components/command-bar";
import { BottomNav } from "@/components/bottom-nav";
import { MindMapOverlay } from "@/components/mind-map-overlay";
import { billingEnabled } from "@/lib/stripe";
import { hasActiveAccess } from "@/lib/subscription";
import type { Profile } from "@/lib/types";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();

  // No organization yet → finish onboarding before entering the app.
  if (!profile?.org_id) redirect("/onboarding");

  const { data: org } = await supabase
    .from("organizations")
    .select("name, logo_url, brand_color, subscription_status, trial_ends_at")
    .eq("id", profile.org_id)
    .maybeSingle();

  // Billing gate (only when Stripe is configured): trial expired & not subscribed.
  if (billingEnabled && org && !hasActiveAccess(org as any)) {
    redirect("/subscribe");
  }

  // Apply the org's brand color across the app shell (white-label).
  const brand = org?.brand_color || "#0b57c4";
  const branding = { name: org?.name ?? null, logo: org?.logo_url ?? null };

  // Attention counts surfaced as sidebar badges.
  const { count: organizeCount } = await supabase
    .from("organized_items")
    .select("id", { count: "exact", head: true })
    .eq("status", "needs_review");
  const badges = { "/organize": organizeCount ?? 0 };

  return (
    <div
      className="app-backdrop flex h-dvh overflow-hidden"
      style={
        {
          "--color-brand": brand,
          "--color-brand-dark": brand,
        } as React.CSSProperties
      }
    >
      <AppNav branding={branding} lang={profile.language} role={profile.role} badges={badges} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar profile={(profile as Profile) ?? null} branding={branding} lang={profile.language} role={profile.role} badges={badges} />
        <main className="flex-1 overflow-y-auto bg-slate-50/70 p-4 pb-[calc(6rem+env(safe-area-inset-bottom))] lg:p-6 lg:pb-6">
          {children}
        </main>
      </div>
      <GlobalVoiceButton lang={profile.language} />
      <GlobalQuickAdd />
      <CommandBar />
      <BottomNav />
      <MindMapOverlay />
    </div>
  );
}
