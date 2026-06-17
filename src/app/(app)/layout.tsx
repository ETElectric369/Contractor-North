import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Dock } from "@/components/app-shell/dock";
import { Topbar } from "@/components/app-shell/topbar";
import { CommandBar } from "@/components/command-bar";
import { BottomNav } from "@/components/bottom-nav";
import { billingEnabled } from "@/lib/stripe";
import { hasActiveAccess } from "@/lib/subscription";
import { getOrgSettings } from "@/lib/org-settings";
import { getActionItemsCount } from "@/lib/action-items/query";
import { todayStrInTz } from "@/lib/tz";
import type { Profile } from "@/lib/types";

/** "#1b9488" → "27 148 136" (the space-separated rgb our --glass-tint expects). */
function hexToRgbTriplet(hex: string): string {
  const h = (hex || "").replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n) || full.length !== 6) return "27 148 136";
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}
function darken(triplet: string, f = 0.62): string {
  return triplet.split(" ").map((c) => Math.round(Number(c) * f)).join(" ");
}

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
    .select("name, logo_url, brand_color, subscription_status, trial_ends_at, settings")
    .eq("id", profile.org_id)
    .maybeSingle();

  // Billing gate (only when Stripe is configured): trial expired & not subscribed.
  if (billingEnabled && org && !hasActiveAccess(org as any)) {
    redirect("/subscribe");
  }

  // Apply the org's brand color across the app shell (white-label).
  const brand = org?.brand_color || "#0b57c4";
  const branding = { name: org?.name ?? null, logo: org?.logo_url ?? null };
  // The glass tint is a separate per-org chrome accent (documents keep brand_color).
  const glassTint = hexToRgbTriplet(getOrgSettings((org as any)?.settings).glass_tint);

  // The unified "Needs action" inbox count, surfaced on the dock Home icon (it
  // already includes the organize/needs-review captures, so no separate badge).
  const tz = getOrgSettings((org as any)?.settings).timezone || "America/Los_Angeles";
  const isStaff = ["owner", "admin", "office"].includes(profile.role);
  const needsAction = await getActionItemsCount({
    todayStr: todayStrInTz(tz),
    isStaff,
    userId: user.id,
  });
  const badges = { "/planner": needsAction };

  return (
    <div
      className="app-backdrop flex h-dvh overflow-hidden"
      style={
        {
          "--color-brand": brand,
          "--color-brand-dark": brand,
          "--glass-tint": glassTint,
          "--glass-ink": darken(glassTint),
        } as React.CSSProperties
      }
    >
      <Dock branding={branding} role={profile.role} badges={badges} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar profile={(profile as Profile) ?? null} lang={profile.language} />
        <main className="flex-1 overflow-y-auto bg-slate-50/70 p-4 pb-[calc(6rem+env(safe-area-inset-bottom))] lg:p-6 lg:pb-6">
          {children}
        </main>
      </div>
      <CommandBar />
      <BottomNav role={profile.role} />
    </div>
  );
}
