"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft, Search } from "lucide-react";
import { GlobalAssistant } from "@/components/global-assistant";
import { GlobalQuickAdd } from "@/components/global-quick-add";
import { AccountMenu } from "@/components/account-menu";
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
}: {
  profile: Profile | null;
  lang?: string;
}) {
  const router = useRouter();
  // Staff = owner/admin/office — the same rule the layout uses (it already
  // passes the full profile, so no extra plumbing). Gates the staff-only
  // quick-add verbs to match the dock/strip/palette filtering.
  const isStaff = ["owner", "admin", "office"].includes(profile?.role ?? "");

  return (
    // Sea-glass top bar via a TRANSLUCENT bg only — deliberately NO backdrop-filter. A
    // backdrop-filter (or transform/filter) here would make the header the containing block
    // for its position:fixed descendants, which trapped Nort's floating panel inside the bar
    // (it rendered behind the section pills — cn-v344 regression). The bar never overlaps the
    // scrolling content, so a blur had nothing to frost anyway; the translucency reads glassy.
    <header className="flex h-16 items-center justify-between gap-2 border-b border-white/50 bg-[rgba(255,255,255,0.8)] px-4 lg:px-6">
      <button
        className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100"
        onClick={() => {
          // router.back() does nothing (looks "frozen") when there's no app
          // history — e.g. you opened a link straight into a page. Fall back home.
          if (typeof window !== "undefined" && window.history.length > 1) router.back();
          else router.push("/planner");
        }}
        aria-label="Go back"
        title="Back"
      >
        <ArrowLeft className="h-5 w-5" />
      </button>

      <div className="flex-1" />

      <div className="flex items-center gap-2 sm:gap-3">
        {/* ONE assistant — voice + chat + actions — reachable from every screen. */}
        <GlobalAssistant />
        <GlobalQuickAdd placement="topbar" isStaff={isStaff} />
        <button
          onClick={() => window.dispatchEvent(new Event("cn:command"))}
          className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-2 text-slate-500 hover:bg-slate-50 sm:px-3"
          title="Search & commands (⌘K)"
          aria-label="Search and commands"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="hidden text-sm md:inline">Search</span>
          <span className="hidden rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-400 md:inline">⌘K</span>
        </button>
        {/* The account seek door — always visible, far right: Sign out, language,
            estimate QR. See account-menu.tsx for THE MODAL RULE it hosts. */}
        <AccountMenu profile={profile} lang={lang} />
      </div>
    </header>
  );
}
