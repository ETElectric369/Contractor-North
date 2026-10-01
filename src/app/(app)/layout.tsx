import { PROFILE_SAFE_COLS } from "@/lib/profile-columns";
import { redirect } from "next/navigation";
import { isStaffRole } from "@/lib/actions/perms";
import { createClient } from "@/lib/supabase/server";
import { Dock } from "@/components/app-shell/dock";
import { Topbar } from "@/components/app-shell/topbar";
import { CommandBar } from "@/components/command-bar";
import { SetupHost } from "@/components/setup-host";
import { billingEnabled } from "@/lib/stripe";
import { hasActiveAccess, isCompedOrg, graceDaysLeft } from "@/lib/subscription";
import { getOrgSettings } from "@/lib/org-settings";
import { orgTrade } from "@/lib/org-trade";
import { getActionItemsCount } from "@/lib/action-items/query";
import { readReconcileWork } from "@/app/(app)/reconcile/reconcile-read";
import { reconcileBadge } from "@/lib/reconcile-kinds";
import { reportError } from "@/lib/observe";
import { todayStrInTz } from "@/lib/tz";
import { GeofenceMonitor } from "@/components/geofence-monitor";
import { OfflineDrain } from "@/components/offline-drain";
import { ShellNavigationWatch } from "@/components/shell-navigation-watch";
import { PageOpenCounter } from "@/components/page-open-counter";
import { BugReporter } from "@/components/bug-reporter";
import { isPlatformAdmin } from "@/lib/platform-admin";
import { countOpenBugs } from "@/lib/bug-watch-count";
import { NativePushBridge } from "@/components/native-push-bridge";
import { TapToPayWarmup } from "@/components/tap-to-pay/warmup";
import { TapToPayAwareness } from "@/components/tap-to-pay/awareness";
import { SectionSubnav } from "@/components/section-subnav";
import { RouteOffLine } from "@/components/route-off-line";
import { ToastProvider } from "@/components/toast";
import { offFeatureKey } from "@/lib/features";
import { countTeammates, shellDoors } from "@/lib/feature-doors";
import { Suspense } from "react";
import type { Profile, GeoPoint } from "@/lib/types";
import { jobLabel } from "@/lib/schedule-options";
import { loadShiftChains } from "@/lib/shift-chain";

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
    .select(PROFILE_SAFE_COLS)
    .eq("id", user.id)
    .single();

  // DEACTIVATED IS CHECKED FIRST (audit v921 high). A revoked site collaborator has active=false
  // AND org_id=null (revokeSiteCollaborator sets both), so the org-less redirect below fired
  // first and sent them to /onboarding — where they could create a BRAND-NEW org and be back in.
  // Lock the door before offering the room. The deactivated screen ends their session; reversible.
  if (profile?.active === false) redirect("/account-deactivated");

  // No organization yet → finish onboarding before entering the app.
  if (!profile?.org_id) redirect("/onboarding");

  // Created with a handed-out temp password (crew import / add-employee) → force them to
  // pick their own before they can use the app, so the temp can't be reused indefinitely.
  if (profile.must_reset_password) redirect("/set-password");

  // THE PROJECTION LAW, on the paywall itself. graceDaysLeft counts forward from
  // current_period_end and treats a MISSING one as "no period recorded → don't lock them out",
  // which is the right call for an org Stripe never billed. But this select never asked for the
  // column, so every past_due org looked like that org: graceDaysLeft returned the full 10 days
  // forever, hasActiveAccess stayed true forever, and the grace window could never close. A
  // declined card was permanent free access. The `as any` at the call site below is what let a
  // missing column through the type checker — so the shape is named here and the cast is gone.
  type OrgLite = {
    name: string | null;
    logo_url: string | null;
    subscription_status: string | null;
    trial_ends_at: string | null;
    current_period_end: string | null;
    settings: unknown;
  };
  const isStaff = isStaffRole(profile.role);

  // TWO STAGES, NOT FIVE SERIAL HOPS (audit v921). This shell re-renders on every hard load,
  // every router.refresh and every revalidatePath in the app, and its reads used to run one after
  // another — ~100–200ms of pure round-trip added to time-to-first-byte before the page's own
  // queries started. Only ONE dependency is real: the org row feeds `settings`, which gates the
  // geofence read and hands the action-items count (and the lead badge) its timezone. So the org
  // and its neighbours together here, {open entry, action items} together below. Each keeps its own
  // try/catch — one failing read still degrades on its own and never takes the shell down.
  const orgP = (async (): Promise<OrgLite | null> => {
    try {
      const { data } = await supabase
        .from("organizations")
        .select("name, logo_url, subscription_status, trial_ends_at, current_period_end, settings")
        .eq("id", profile.org_id)
        .maybeSingle();
      return (data as OrgLite | null) ?? null;
    } catch (e) {
      // A transient org-read failure must not tear down the whole shell — degrade to
      // defaults (branding → nulls, settings → DEFAULT_SETTINGS below, billing gate is
      // already guarded on `org &&`). Logged so it's visible in the ops sink.
      reportError("app-layout:org", e);
      return null;
    }
  })();
  // THE RED DOT ANDREW ASKED FOR: uncontacted leads on the Sales icon. The dock's badge sum
  // already reads per-href counts (dock.tsx:75) — this was wired for exactly one href since the
  // day it shipped. A count is cosmetic, never a crash.
  //
  // ONLY THE LEADS DUE NOW (NY-feeders): a lead snoozed from Needs You waits for its day, and so
  // does its dot, so the badge and the row agree. "Now" is the company's today, so this starts the
  // moment the org read gives the timezone; it never holds the shell up (the dock gets it with the
  // other badges, unresolved), and it never rejects.
  const freshLeadsP: Promise<number> = (async () => {
    if (!isStaff) return 0;
    try {
      const today = todayStrInTz(getOrgSettings((await orgP)?.settings).timezone || "America/Los_Angeles");
      const { count } = await supabase
        .from("inquiries")
        .select("id", { count: "exact", head: true })
        .eq("status", "new")
        .is("converted_at", null)
        .or(`next_follow_up_at.is.null,next_follow_up_at.lte.${today}`);
      return count ?? 0;
    } catch (e) {
      reportError("app-layout:lead-badge", e);
      return 0;
    }
  })();
  const [org, platformAdmin, teammates, hasPettyCash] = await Promise.all([
    orgP,
    // North's own team (0176): Bug Watch in the avatar menu, and triage inside Report A Problem.
    // In this first stage, beside the org read, so it costs no extra hop; false on any failure.
    isPlatformAdmin(supabase),
    // CREW & PAYROLL IS QUIET UNTIL A SECOND PERSON (the switch board, rule j): how many active
    // members aren't the owner. Anyone else looking IS one, so only the owner's view needs the
    // read; a failed read is null, which shows the doors exactly as before.
    (async (): Promise<number | null> => {
      try {
        return await countTeammates(supabase, profile);
      } catch (e) {
        reportError("app-layout:teammates", e);
        return null;
      }
    })(),
    // PETTY CASH LEFT THE MENU (W1-34), and a company that has petty-cash rows keeps a way in: Search
    // Or Ask's Petty Cash row. One row at most, this company's, staff only (a tech never reads it);
    // a failed read offers no row and says so in the ops sink (the job's Petty Cash figure still links).
    (async (): Promise<boolean> => {
      if (!isStaff) return false;
      try {
        const { data, error } = await supabase.from("petty_cash").select("id").eq("org_id", profile.org_id).limit(1);
        if (error) {
          reportError("app-layout:petty-cash", error);
          return false;
        }
        return (data ?? []).length > 0;
      } catch (e) {
        reportError("app-layout:petty-cash", e);
        return false;
      }
    })(),
  ]);

  // BUG WATCH COUNTS ITS OWN (NY-list part): the open reports, counted the Bugs page's way (a null
  // status is open), for North's own team only — asked after isPlatformAdmin resolved, so nobody
  // else pays the round trip. Handed to the avatar menu UNRESOLVED, like the dock's badges: a count
  // never holds up the shell, and a failed one is no number (lib/bug-watch-count).
  const bugCount: Promise<number | null> | null = platformAdmin ? countOpenBugs(supabase) : null;

  const settings = getOrgSettings((org as any)?.settings);
  // THE SWITCH BOARD, read ONCE here and handed down (0352): `features` is the company's switches
  // (the Off line reads them), `doors` is what the shell draws from (the same map, with Crew &
  // Payroll quiet until a second person). No stored map = everything on = the shell as it was.
  const features = settings.features;
  const doors = shellDoors(features, teammates);
  const isOwner = profile.role === "owner";

  // Billing gate (only when Stripe is configured): trial expired & not subscribed.
  // The operator's own house org (COMPED_ORG_IDS) is never paywalled.
  if (billingEnabled && org && !hasActiveAccess(org) && !isCompedOrg(profile.org_id)) {
    redirect("/subscribe");
  }

  // Inside the grace window after a declined card: the crew keeps working, but the
  // owner must SEE it — a silent countdown that ends in a locked-out morning is the
  // worst possible version of this. Escalates as the days run down.
  const graceLeft =
    billingEnabled && org && !isCompedOrg(profile.org_id) ? graceDaysLeft(org) : 0;

  const branding = { name: org?.name ?? null, logo: org?.logo_url ?? null };
  // WHAT THE COMPANY STILL HASN'T SAID ABOUT ITSELF, in the setup playbook's own keys — read off
  // the settings this layout already loaded, so the setup rows (Search Or Ask's, or Help's with
  // Nort off) and their dot cost no query.
  // The trade comes through the ONE reader (lib/org-trade): the words, else the sign-up key's own
  // words, so a company that picked its trade at sign-up is never asked it again.
  const setup = {
    full_name: profile.full_name ?? null,
    trade: orgTrade(settings).label || null,
    city: settings.public_city || null,
    service_area: settings.service_area || null,
    labor_rate: settings.default_labor_rate > 0 ? settings.default_labor_rate : null,
  };
  // profiles.onboarded_at (0180): has THIS PERSON been walked through (Start Here until then).
  const onboarded = !!(profile as { onboarded_at?: string | null }).onboarded_at;
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
  // STAGE TWO (audit v921): the two reads that actually needed `settings` — the geofence gate and
  // this count's timezone — go together instead of one after the other.
  type OpenEntry = {
    id: string;
    gps_in: GeoPoint | null;
    clock_in: string;
    job_id: string | null;
    job: { job_number: string; name: string } | null;
    /** 0288: a Switch Job's piece points at the shift's first entry and says 'live'. */
    split_from?: string | null;
    split_how?: string | null;
  };
  // Geofence: if the user is on the clock, mount the exit monitor. The clock-in GPS
  // is the fence anchor when it exists; entries WITHOUT one mount too (My Day and the
  // job-page clock buttons punch with gps:null, and the timeclock punch can outrun the
  // iOS permission dialog) — the monitor adopts an anchor from its first good fix near
  // clock-in. Requiring gps_in here is what silently disabled the geofence for most
  // punches (the 30-hour open shift).
  let openEntry: OpenEntry | null = null;
  // THE SHIFT, NOT THE PIECE (audit v994 SW1): the monitor's "past twelve hours" counts from the
  // first piece of a switched shift (lib/shift-chain). One extra read, only for a switched clock.
  let openShiftStart: string | null = null;
  if (settings.geofence_logout) {
    try {
      const { data: oe } = await supabase
        .from("time_entries")
        .select("id, gps_in, clock_in, job_id, split_from, split_how, job:job_id(job_number, name)")
        .eq("profile_id", user.id)
        .eq("status", "open")
        .maybeSingle();
      openEntry = (oe as any) ?? null;
      if (openEntry?.split_from) {
        const chains = await loadShiftChains(
          supabase as any,
          [{ id: openEntry.id, profile_id: user.id, clock_in: openEntry.clock_in, split_from: openEntry.split_from }],
          profile.org_id ?? null,
        );
        openShiftStart = chains.get(openEntry.id)?.startIso ?? null;
      }
    } catch (e) {
      // Degrade: the geofence monitor just won't mount this render. Never crash the shell.
      reportError("app-layout:open-entry", e);
    }
  }

  // A BADGE MAY NOT HOLD UP THE APP (2026-09-08 — Erik: "taking a super long time to load
  // anything on the phone app and the lag was making it tough to wait for").
  //
  // getActionItemsCount runs the whole Needs-action union — ~31 queries in five serial waves —
  // and this layout AWAITED it. A layout's body runs to completion BEFORE React renders its
  // children, so that fan-out was a prerequisite of every single page in the app: nothing on
  // /jobs, /timeclock or a job hub even started fetching until a cosmetic amber dot had its
  // number. On a phone over LTE that is most of the wait.
  //
  // Now the promise is HANDED to the dock unresolved. The shell and the page render and stream
  // immediately; the count arrives in a later chunk and the dot appears a beat afterwards, which
  // is exactly what a badge is worth. Rejection is swallowed here (a count is never a crash) and
  // still reported to the ops sink, so nothing awaits a promise that can throw.
  // ── RECONCILE'S DOT: HOW MANY KINDS, NEVER HOW MANY ROWS ────────────────────────────────────
  //
  // A reconcile pile is undated and unbounded by construction — twenty-six papers under five
  // spellings wait as long as nobody sorts them — and the badge invariant (action-items/types.ts)
  // forbids counting a set like that on chrome. So this is a ROLLUP, like the no-job hours line:
  // the number of KINDS of disagreement with anything open, bounded at the size of the ReconcileKind
  // union, zero drawing nothing. Each kind's own count is plain text inside its heading on the page,
  // where the deciding happens.
  //
  // IT READS THE SAME FUNCTION THE PAGE READS (readReconcileWork), so the dot and the page can never
  // say different things — the never-disagree doctrine. Staff only, so a tech's shell never spends a
  // query on it, and it rides inside the badges promise the shell hands over UNRESOLVED: nothing on
  // any page waits for it. It is deliberately NOT routed through getActionItemsCount — that is the
  // Needs You engine, and Erik stopped opening My Day because it stockpiled what he could not act on.
  const reconcileP: Promise<number> = (async () => {
    if (!isStaff || !profile.org_id) return 0;
    try {
      const work = await readReconcileWork(supabase, profile.org_id, null);
      return reconcileBadge(work.counts);
    } catch (e) {
      reportError("app-layout:reconcile-badge", e);
      return 0;
    }
  })();

  const badges: Promise<Record<string, number>> = (async () => {
    try {
      const needsAction = await getActionItemsCount({
        todayStr: todayStrInTz(tz),
        // Pass the tz (audit v921 review blocker): /planner passes it, and without it here the
        // badge counts on UTC day-cuts while the list it links to counts on the org's — a badge
        // whose number doesn't match its own list.
        tz,
        isStaff,
        userId: user.id,
        // The switches as ONE plain string, the same one /planner passes, so the two callers
        // share one fan-out (cache() keys on primitives) and the badge counts the list it opens.
        off: offFeatureKey(features),
      });
      // The lead count ran beside this one (it started with the org read, and never rejects).
      const freshLeads = await freshLeadsP;
      // "/leads" dots only a Leads row that's drawn: with Leads off the dock has none to sum.
      return { "/planner": needsAction, "/leads": freshLeads, "/reconcile": await reconcileP };
    } catch (e) {
      reportError("app-layout:action-items", e);
      return { "/planner": 0, "/leads": await freshLeadsP, "/reconcile": await reconcileP };
    }
  })();

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
      <Dock branding={branding} role={profile.role} badges={badges} features={doors} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Topbar profile={(profile as Profile) ?? null} lang={profile.language} branding={branding} setup={setup} onboarded={onboarded} platformAdmin={platformAdmin} features={doors} bugCount={bugCount} />
        {graceLeft > 0 && (
          <div
            className={`no-print px-4 py-2 text-center text-sm font-medium ${
              graceLeft <= 3 ? "bg-red-600 text-white" : "bg-amber-100 text-amber-900"
            }`}
          >
            Your card was declined — update it in Settings. The crew keeps working for{" "}
            {graceLeft} more day{graceLeft === 1 ? "" : "s"}.
          </div>
        )}
        <main className="flex-1 overflow-y-auto bg-slate-50/70 p-4 pb-[calc(7.5rem+env(safe-area-inset-bottom))] shell:p-6 shell:pb-6">
          <Suspense fallback={null}>
            <SectionSubnav isStaff={isStaff} features={doors} />
          </Suspense>
          {/* A page whose feature is switched off still opens from a link, with the Off line on top. */}
          <RouteOffLine features={features} isOwner={isOwner} />
          {/* One count per page open, ids stripped, no user id (0353). Suspense: it reads ?tab=. */}
          <Suspense fallback={null}>
            <PageOpenCounter />
          </Suspense>
          <ToastProvider>{children}</ToastProvider>
        </main>
      </div>
      {/* Search Or Ask's sheet: with nothing typed, Talk To Nort and (staff) the setup rows. */}
      <CommandBar isStaff={isStaff} features={doors} setup={setup} onboarded={onboarded} hasPettyCash={hasPettyCash} />
      {/* The setup screens (the tour, the questions, a lesson), mounted ONCE here and opened by the
          setup rows through cn:setup, so closing the sheet a row sat in never kills a lesson. */}
      <SetupHost initial={setup} isStaff={isStaff} onboarded={onboarded} features={doors} />
      {/* Queued field work files itself from ANY screen, and says so (audit 9). */}
      <OfflineDrain userId={profile.id} />
      <ShellNavigationWatch />
      {/* In the App Store app: a tapped notification opens the thing it is about, and the APNs
          device token is refreshed on launch so alerts can't quietly stop. No-op on the web. */}
      <NativePushBridge />
      {/* Tap to Pay on iPhone, in the App Store app only: the reader warms up at launch and on
          every return to the foreground (Apple 1.5), and every eligible person gets the once-only
          intro card (Apple 3.1–3.3). Both render nothing and no-op on the web. */}
      <TapToPayWarmup />
      <TapToPayAwareness />
      {/* Report A Problem is everyone's (Wave 0): a tech hits the bugs first. */}
      <BugReporter orgId={profile.org_id} platformAdmin={platformAdmin} />
      {openEntry && (
        <GeofenceMonitor
          // A Switch Job closes the running entry and opens the next one (0288): a new entry is a
          // new fence, so the monitor starts fresh instead of carrying the old site's trip state.
          key={openEntry.id}
          entryId={openEntry.id}
          gpsIn={openEntry.gps_in}
          clockInIso={openEntry.clock_in}
          radiusM={settings.geofence_radius_m}
          // The entry's CURRENT job — a job-less start re-points on a switch, and the monitor
          // must retire the old site's anchor + trip state instead of fencing on it.
          jobId={openEntry.job_id ?? null}
          jobLabel={openEntry.job ? jobLabel(openEntry.job) : "the job site"}
          // The piece began at a Switch Job (0288 cut): its anchor window is the wider post-switch
          // one (audit v994 SW2), and "long" counts from the shift's first piece (SW1).
          startedBySwitch={openEntry.split_how === "live"}
          shiftStartIso={openShiftStart}
          tz={tz}
        />
      )}
    </div>
  );
}
