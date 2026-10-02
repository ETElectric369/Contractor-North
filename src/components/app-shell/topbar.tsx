"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { isStaffRole } from "@/lib/actions/perms";
import { ArrowLeft, AudioLines, Search, Square } from "lucide-react";
import { GlobalAssistant } from "@/components/global-assistant";
import { GlobalQuickAdd } from "@/components/global-quick-add";
import { NotificationBell } from "@/components/app-shell/notification-bell";
import { AccountMenu } from "@/components/account-menu";
import { hasInAppHistory } from "@/components/back-link";
import { featureOn, type FeatureMap } from "@/lib/features";
import { useEstimator } from "@/lib/estimator-store";
import { setupWaiting, talkToNort } from "@/lib/onboarding/help-rows";
import { isApplePlatform, modKeyLabel } from "@/lib/mod-key";
import type { Answers } from "@/lib/playbook/types";
import type { Profile } from "@/lib/types";

/**
 * THE TOP BAR: Back · logo · Search Or Ask · Nort · + · Bell · Avatar — the same controls for every
 * role and every company (W1-09), each a 44px target, with nothing scrolling sideways at 375px (the
 * company logo gives way first). Nort off, his button isn't drawn and the bar is one control shorter.
 *
 * SEARCH OR ASK is one door where there were two (the Search button and the graduation cap). It
 * opens the command bar (cn:command): search anything; with Nort on, Talk To Nort is its first row,
 * typing a question and pressing Enter asks him, and the setup rows (Start Here, Finish Setting Up,
 * Show Me How, Take The Setup Again) sit inside it for staff. With Nort off it reads Search, and the
 * setup rows move under Help in the avatar menu.
 *
 * NORT'S BUTTON, ONE TAP (Erik, 2026-09-27: "theres not Nort button anymore"). He is an intercom,
 * used hands-busy in the truck — one tap or it isn't safe — so a menu row alone buried him. The
 * button runs talkToNort(), the very call Search Or Ask's Talk To Nort row makes, inside its own
 * click so the mic starts inside the tap (iOS). While Nort listens, thinks or speaks it IS the red
 * Stop Nort, so the bar keeps exactly one voice control and one Stop.
 *
 * Forward is gone (back already falls back to /planner), and Sign out / language / the estimate QR
 * / Office / Tools live behind the ONE account seek door (<AccountMenu>, far right).
 */
export function Topbar({
  profile,
  lang,
  branding,
  setup,
  onboarded,
  platformAdmin = false,
  features,
  bugCount,
}: {
  profile: Profile | null;
  lang?: string;
  branding?: { name: string | null; logo: string | null };
  /** What the company has and hasn't said about itself, in the setup playbook's keys. Comes from
   *  the layout, which already reads org settings for branding — so the dot costs no extra query. */
  setup?: Answers;
  /** profiles.onboarded_at (0180) — has THIS PERSON been walked through, not "are the fields full". */
  onboarded?: boolean;
  /** North's own team (is_platform_admin, 0176): the avatar menu adds Bug Watch. */
  platformAdmin?: boolean;
  /** The shell's switch map (the switch board, 0352), read once by the layout. Left out = all on. */
  features?: FeatureMap;
  /** Bug Watch's open count, for a platform admin only (null for everyone else, or when the count
   *  failed). May arrive as a promise so it never holds up the shell. */
  bugCount?: number | null | Promise<number | null>;
}) {
  const router = useRouter();
  // Staff = owner/admin/office — the same rule the layout uses (it already
  // passes the full profile, so no extra plumbing). Gates the staff-only
  // quick-add verbs to match the dock/strip/palette filtering.
  const isStaff = isStaffRole(profile?.role ?? "");
  // Nort off: his panel and the ?debrief= / ?attention= openers it hosts aren't mounted, and the
  // door reads Search. The bell STAYS whatever the switches say: it is the record of every push (Erik).
  const nortOn = featureOn(features, "nort");
  // Nort is working (listening, thinking or talking): his button becomes Stop Nort (the chat
  // publishes these to the shared store even while its panel is collapsed).
  const { listening, streaming, speaking } = useEstimator();
  const nortBusy = nortOn && (listening || streaming || speaking);
  // NOTHING SILENT: a person not yet walked through, or a company with setup questions open, gets a
  // dot on the door that holds the setup rows (a mark, never a count). With Nort off those rows are
  // under Help in the avatar menu, so the dot goes there instead.
  const waiting = setupWaiting({ isStaff, onboarded: !!onboarded, setup });
  // The shortcut's name on THIS computer, after mount (the server render says ⌘K, as before).
  const [modKey, setModKey] = useState("⌘K");
  useEffect(() => setModKey(modKeyLabel(isApplePlatform())), []);

  return (
    // Sea-glass top bar via a TRANSLUCENT bg only — deliberately NO backdrop-filter. A
    // backdrop-filter (or transform/filter) here would make the header the containing block
    // for its position:fixed descendants, which trapped Nort's floating panel inside the bar
    // (it rendered behind the section pills — cn-v344 regression). The bar never overlaps the
    // scrolling content, so a blur had nothing to frost anyway; the translucency reads glassy.
    // `app-topbar`: turned sideways on a phone the notch is on the SIDE, so globals.css pads this
    // bar past it — same bar, same controls, same places, just not under the camera.
    <header className="app-topbar flex h-[calc(4rem+var(--sat,0px))] items-center justify-between gap-2 border-b border-white/50 bg-[rgba(255,255,255,0.8)] px-4 pt-[var(--sat,0px)] shell:px-6">
      <button
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
        onClick={() => {
          // router.back() does nothing (looks "frozen") when there's no app
          // history — e.g. you opened a link straight into a page — and EXITS
          // the app when the previous entry is another site (history.length
          // can't tell the difference). Same detector as <BackLink>.
          if (hasInAppHistory()) router.back();
          else router.push("/planner");
        }}
        aria-label="Go back"
        title="Back"
      >
        <ArrowLeft className="h-5 w-5" />
      </button>

      {/* Org skin — the company's own logo (or name) top-left, so the app wears their brand.
          Matters most on mobile, where the branded dock/sidebar isn't visible. min-w-0 + shrink:
          the brand gives way before any control does, so the bar never scrolls sideways. */}
      {branding?.logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={branding.logo} alt={branding.name ?? "Company"} className="ml-1 h-8 w-auto min-w-0 max-w-[160px] shrink object-contain" />
      ) : branding?.name ? (
        <span className="ml-1 min-w-0 max-w-[160px] shrink truncate text-base font-extrabold tracking-tight text-[rgb(var(--glass-ink))]">{branding.name}</span>
      ) : null}

      <div className="flex-1" />

      {/* THE CHROME DOES NOT MOVE WHEN THE PHONE TURNS (Erik, 2026-10-01). A phone held sideways is
          ~700–930px wide, which trips sm: and md: — so this group would have widened its gaps and
          the Search button below would have grown a text label, in the one place he said nothing may
          change. `turned:` puts the phone's own measurements back. */}
      <div className="flex shrink-0 items-center gap-2 sm:gap-3 turned:gap-2">
        {/* Nort's panel and deep-link openers — no DOM of its own in the bar (the panel floats). */}
        {nortOn && <GlobalAssistant />}
        <button
          onClick={() => window.dispatchEvent(new Event("cn:command"))}
          data-tour="ask"
          aria-label={nortOn ? "Search Or Ask" : "Search"}
          title={`${nortOn ? "Search or ask Nort" : "Search"} (${modKey})${nortOn && waiting ? " — setup is waiting inside" : ""}`}
          className="relative flex h-11 w-11 items-center justify-center gap-2 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 md:w-auto md:px-3 turned:w-11 turned:px-0"
        >
          <Search className="h-5 w-5 shrink-0" />
          <span className="hidden text-sm md:inline turned:hidden">{nortOn ? "Search Or Ask" : "Search"}</span>
          {/* The shortcut only where there is a keyboard to press it on. */}
          <span className="hidden rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-400 md:pointer-fine:inline">{modKey}</span>
          {nortOn && waiting && (
            <span data-x="setup-dot" className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-rose-500 ring-2 ring-white" />
          )}
        </button>
        {/* NORT, ONE TAP: Talk To Nort, or the red Stop Nort while he works. Nort off: not drawn. */}
        {nortOn &&
          (nortBusy ? (
            <button
              onClick={() => window.dispatchEvent(new Event("cn:assistant-stop"))}
              // The same anchor as Talk To Nort: it is the same button, in its other state.
              data-tour="nort"
              aria-label="Stop Nort"
              title="Stop Nort"
              className="btn-gloss inline-flex h-11 w-11 items-center justify-center rounded-full bg-red-600 text-white shadow-sm transition-colors hover:bg-red-700"
            >
              <Square className="h-4 w-4 shrink-0 fill-current" />
            </button>
          ) : (
            <button
              // SYNCHRONOUS, ON PURPOSE: talkToNort() (the same call as Search Or Ask's Talk To Nort
              // row) dispatches cn:nort-talk, and GlobalAssistant's launch() starts the mic before
              // this click returns — inside the tap, as iOS needs. Never put an await in front of it.
              onClick={talkToNort}
              data-tour="nort"
              aria-label="Talk To Nort"
              title="Talk To Nort"
              className="btn-gloss inline-flex h-11 w-11 items-center justify-center rounded-full bg-brand text-white shadow-sm transition-colors hover:bg-brand-dark"
            >
              <AudioLines className="h-5 w-5 shrink-0" />
            </button>
          ))}
        {/* The + tour anchor is this wrapper span (lane 3 rewrites the component inside it). */}
        <span data-tour="quickadd" className="inline-flex"><GlobalQuickAdd placement="topbar" isStaff={isStaff} features={features} /></span>
        {/* The in-app bell — the always-works notification channel (push-independent). */}
        <span data-tour="bell" className="inline-flex"><NotificationBell /></span>
        {/* The account seek door — always visible, far right: Settings, Office, Tools, Sign out,
            language, estimate QR (and Help with Nort off). See account-menu.tsx for THE MODAL RULE. */}
        <span data-tour="account" className="inline-flex">
          <AccountMenu
            profile={profile}
            lang={lang}
            platformAdmin={platformAdmin}
            features={features}
            setup={setup}
            onboarded={!!onboarded}
            setupDot={!nortOn && waiting}
            bugCount={bugCount}
          />
        </span>
      </div>
    </header>
  );
}
