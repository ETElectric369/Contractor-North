"use client";

import { useRouter } from "next/navigation";
import { isStaffRole } from "@/lib/actions/perms";
import { ArrowLeft, Search } from "lucide-react";
import { GlobalAssistant } from "@/components/global-assistant";
import { GlobalQuickAdd } from "@/components/global-quick-add";
import { NotificationBell } from "@/components/app-shell/notification-bell";
import { AccountMenu } from "@/components/account-menu";
import { SetupButton } from "@/components/setup-button";
import { hasInAppHistory } from "@/components/back-link";
import type { Answers } from "@/lib/playbook/types";
import type { Profile } from "@/lib/types";

/**
 * The topbar diet: back · Nort · + · search · account — five controls with
 * slack at 375px. Forward is gone (back already falls back to /planner), and
 * Sign out / language / the estimate QR live behind the ONE account seek door
 * (<AccountMenu>, far right) instead of crowding the bar as impulse buttons.
 */
export function Topbar({
  profile,
  lang,
  branding,
  setup,
  onboarded,
}: {
  profile: Profile | null;
  lang?: string;
  branding?: { name: string | null; logo: string | null };
  /** What the company has and hasn't said about itself, in the setup playbook's keys. Comes from
   *  the layout, which already reads org settings for branding — so the door costs no extra query. */
  setup?: Answers;
  /** profiles.onboarded_at (0180) — has THIS PERSON been walked through, not "are the fields full". */
  onboarded?: boolean;
}) {
  const router = useRouter();
  // Staff = owner/admin/office — the same rule the layout uses (it already
  // passes the full profile, so no extra plumbing). Gates the staff-only
  // quick-add verbs to match the dock/strip/palette filtering.
  const isStaff = isStaffRole(profile?.role ?? "");

  return (
    // Sea-glass top bar via a TRANSLUCENT bg only — deliberately NO backdrop-filter. A
    // backdrop-filter (or transform/filter) here would make the header the containing block
    // for its position:fixed descendants, which trapped Nort's floating panel inside the bar
    // (it rendered behind the section pills — cn-v344 regression). The bar never overlaps the
    // scrolling content, so a blur had nothing to frost anyway; the translucency reads glassy.
    <header className="flex h-[calc(4rem+var(--sat,0px))] items-center justify-between gap-2 border-b border-white/50 bg-[rgba(255,255,255,0.8)] px-4 pt-[var(--sat,0px)] shell:px-6">
      <button
        className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
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
          Matters most on mobile, where the branded dock/sidebar isn't visible. */}
      {branding?.logo ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={branding.logo} alt={branding.name ?? "Company"} className="ml-1 h-8 w-auto max-w-[160px] object-contain" />
      ) : branding?.name ? (
        <span className="ml-1 truncate text-base font-extrabold tracking-tight text-[rgb(var(--glass-ink))]">{branding.name}</span>
      ) : null}

      <div className="flex-1" />

      <div className="flex items-center gap-2 sm:gap-3">
        {/* ONE assistant — voice + chat + actions — reachable from every screen. */}
        {/* data-tour anchors: the spotlight finds these by attribute at step time. A wrapper span
            rather than a prop on each component — no component has to know a tour exists. */}
        <span data-tour="nort" className="inline-flex"><GlobalAssistant /></span>
        {/* THE INTERVIEW, beside the speak button, on every screen (cn-v633). It used to be a card
            on My Day that hid itself once setup was done — correct for a card, wrong for this:
            the moment somebody wants to change what they said, the thing they used has evaporated.
            Loud while it matters, quiet forever after, never gone. */}
        {setup && <SetupButton initial={setup} isStaff={isStaff} onboarded={!!onboarded} />}
        <span data-tour="quickadd" className="inline-flex"><GlobalQuickAdd placement="topbar" isStaff={isStaff} /></span>
        <button
          onClick={() => window.dispatchEvent(new Event("cn:command"))}
          className="flex items-center gap-2 rounded-lg border border-slate-200 h-11 px-2.5 sm:px-3 text-slate-500 hover:bg-slate-50 sm:px-3"
          data-tour="search"
          title="Search & commands (⌘K)"
          aria-label="Search and commands"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="hidden text-sm md:inline">Search</span>
          <span className="hidden rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-400 md:inline">⌘K</span>
        </button>
        {/* The in-app bell — the always-works notification channel (push-independent). */}
        <span data-tour="bell" className="inline-flex"><NotificationBell /></span>
        {/* The account seek door — always visible, far right: Sign out, language,
            estimate QR. See account-menu.tsx for THE MODAL RULE it hosts. */}
        <span data-tour="account" className="inline-flex"><AccountMenu profile={profile} lang={lang} /></span>
      </div>
    </header>
  );
}
