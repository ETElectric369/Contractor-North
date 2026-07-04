import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Dock } from "@/components/app-shell/dock";
import { Topbar } from "@/components/app-shell/topbar";
import { CommandBar } from "@/components/command-bar";
import { billingEnabled } from "@/lib/stripe";
import { hasActiveAccess, isCompedOrg } from "@/lib/subscription";
import { getOrgSettings } from "@/lib/org-settings";
import { getActionItemsCount } from "@/lib/action-items/query";
import { todayStrInTz } from "@/lib/tz";
import { GeofenceMonitor } from "@/components/geofence-monitor";
import { BugReporter } from "@/components/bug-reporter";
import { SectionSubnav } from "@/components/section-subnav";
import { ToastProvider } from "@/components/toast";
import { Suspense } from "react";
import type { Profile, GeoPoint } from "@/lib/types";

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
/** Mix each channel toward white — for the soft `brand-light` background tint. */
function lighten(triplet: string, f = 0.88): string {
  return triplet.split(" ").map((c) => Math.round(Number(c) + (255 - Number(c)) * f)).join(" ");
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

  // Created with a handed-out temp password (crew import / add-employee) → force them to
  // pick their own before they can use the app, so the temp can't be reused indefinitely.
  if (profile.must_reset_password) redirect("/set-password");

  // Deactivated → locked out. `active=false` used to only hide a member from assignee
  // pickers while they could still sign in and use the app; this is the choke point that
  // makes deactivation actually bar access. The deactivated screen ends their session.
  // Reversible: an owner/admin flipping active back lets them in again.
  if (profile.active === false) redirect("/account-deactivated");

  const { data: org } = await supabase
    .from("organizations")
    .select("name, logo_url, subscription_status, trial_ends_at, settings")
    .eq("id", profile.org_id)
    .maybeSingle();

  const settings = getOrgSettings((org as any)?.settings);

  // Geofence: if the user is on the clock, mount the exit monitor. The clock-in GPS
  // is the fence anchor when it exists; entries WITHOUT one mount too (My Day and the
  // job-page clock buttons punch with gps:null, and the timeclock punch can outrun the
  // iOS permission dialog) — the monitor adopts an anchor from its first good fix near
  // clock-in. Requiring gps_in here is what silently disabled the geofence for most
  // punches (the 30-hour open shift).
  let openEntry:
    | { id: string; gps_in: GeoPoint | null; clock_in: string; job: { job_number: string; name: string } | null }
    | null = null;
  if (settings.geofence_logout) {
    const { data: oe } = await supabase
      .from("time_entries")
      .select("id, gps_in, clock_in, job:job_id(job_number, name)")
      .eq("profile_id", user.id)
      .eq("status", "open")
      .maybeSingle();
    if (oe) openEntry = oe as any;
  }

  // Billing gate (only when Stripe is configured): trial expired & not subscribed.
  // The operator's own house org (COMPED_ORG_IDS) is never paywalled.
  if (billingEnabled && org && !hasActiveAccess(org as any) && !isCompedOrg(profile.org_id)) {
    redirect("/subscribe");
  }

  const branding = { name: org?.name ?? null, logo: org?.logo_url ?? null };
  // ONE per-org color source: the sea-glass tint. `brand` (the solid accent used by
  // bg-brand / text-brand across the app AND on documents) now DERIVES from the tint —
  // there is no separate company blue anymore. Ink = the strong fill (matches the CTA
  // button); brand-light = a soft tint background. The org's chosen tint recolors the
  // whole app + its invoices in one knob (Settings → the tint picker).
  const glassTint = hexToRgbTriplet(settings.glass_tint);
  const brandInk = darken(glassTint);
  const brandInkDark = darken(glassTint, 0.45);
  const brandLight = lighten(glassTint);

  // The unified "Needs action" inbox count, surfaced on the dock Home icon (it
  // already includes the organize/needs-review captures, so no separate badge).
  const tz = settings.timezone || "America/Los_Angeles";
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
          "--color-brand": `rgb(${brandInk})`,
          "--color-brand-dark": `rgb(${brandInkDark})`,
          "--color-brand-light": `rgb(${brandLight})`,
          "--glass-tint": glassTint,
          "--glass-ink": brandInk,
        } as React.CSSProperties
      }
    >
      <Dock branding={branding} role={profile.role} badges={badges} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar profile={(profile as Profile) ?? null} lang={profile.language} />
        <main className="flex-1 overflow-y-auto bg-slate-50/70 p-4 pb-[calc(7.5rem+env(safe-area-inset-bottom))] lg:p-6 lg:pb-6">
          <Suspense fallback={null}>
            <SectionSubnav isStaff={isStaff} />
          </Suspense>
          <ToastProvider>{children}</ToastProvider>
        </main>
      </div>
      <CommandBar isStaff={isStaff} />
      {isStaff && <BugReporter orgId={profile.org_id} />}
      {openEntry && (
        <GeofenceMonitor
          entryId={openEntry.id}
          gpsIn={openEntry.gps_in}
          clockInIso={openEntry.clock_in}
          radiusM={settings.geofence_radius_m}
          jobLabel={openEntry.job ? `${openEntry.job.job_number} · ${openEntry.job.name}` : "the job site"}
        />
      )}
    </div>
  );
}
