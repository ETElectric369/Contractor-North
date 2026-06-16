"use client";

import { useRouter } from "next/navigation";
import { LogOut, ArrowLeft, ArrowRight, Search } from "lucide-react";
import { LanguageSwitcher } from "@/components/language-switcher";
import { GlobalVoiceButton } from "@/components/global-voice-button";
import { GlobalQuickAdd } from "@/components/global-quick-add";
import { initials } from "@/lib/utils";
import { signOut } from "@/app/login/actions";
import type { Profile } from "@/lib/types";

export function Topbar({
  profile,
  lang,
}: {
  profile: Profile | null;
  lang?: string;
}) {
  const router = useRouter();

  return (
    <>
      <header className="flex h-16 items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 lg:px-6">
        <button
          className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
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
        <button
          className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
          onClick={() => router.forward()}
          aria-label="Go forward"
          title="Forward"
        >
          <ArrowRight className="h-5 w-5" />
        </button>

        <div className="flex-1" />

        <div className="flex items-center gap-2 sm:gap-3">
          {/* Assistant (voice) + quick-add — permanent, reachable while driving. */}
          <GlobalVoiceButton placement="topbar" lang={lang} />
          <GlobalQuickAdd placement="topbar" />
          <button
            onClick={() => window.dispatchEvent(new Event("cn:command"))}
            className="flex items-center gap-2 rounded-lg border border-slate-200 px-2.5 py-2 text-slate-500 hover:bg-slate-50 sm:px-3"
            title="Search & commands (⌘K)"
            aria-label="Search and commands"
          >
            <Search className="h-4 w-4" />
            <span className="hidden text-sm md:inline">Search</span>
            <span className="hidden rounded border border-slate-200 px-1.5 py-0.5 text-[10px] text-slate-400 md:inline">⌘K</span>
          </button>
          <LanguageSwitcher current={lang} />
          <div className="hidden text-right sm:block">
            <div className="text-sm font-medium text-slate-900">
              {profile?.full_name ?? "—"}
            </div>
            <div className="text-xs capitalize text-slate-400">
              {profile?.role ?? "user"}
            </div>
          </div>
          {profile?.avatar_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={profile.avatar_url}
              alt=""
              className="h-9 w-9 rounded-full object-cover"
            />
          ) : (
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand text-sm font-semibold text-white">
              {initials(profile?.full_name)}
            </div>
          )}
          <form action={signOut}>
            <button
              className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut className="h-5 w-5" />
            </button>
          </form>
        </div>
      </header>
    </>
  );
}
