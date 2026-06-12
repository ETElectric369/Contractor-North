"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Menu, X, LogOut, ArrowLeft, ArrowRight } from "lucide-react";
import { Sidebar } from "./sidebar";
import { LanguageSwitcher } from "@/components/language-switcher";
import { initials } from "@/lib/utils";
import { signOut } from "@/app/login/actions";
import type { Profile } from "@/lib/types";

export function Topbar({
  profile,
  branding,
  lang,
  role,
  badges,
}: {
  profile: Profile | null;
  branding?: { name: string | null; logo: string | null };
  lang?: string;
  role?: string;
  badges?: Record<string, number>;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  return (
    <>
      <header className="flex h-16 items-center justify-between gap-2 border-b border-slate-200 bg-white px-4 lg:px-6">
        <button
          className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 lg:hidden"
          onClick={() => setOpen(true)}
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        <button
          className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
          onClick={() => router.back()}
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

        <div className="flex items-center gap-3">
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

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-slate-900/40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-64">
            <button
              className="absolute -right-10 top-4 rounded-lg bg-white/90 p-2 text-slate-700"
              onClick={() => setOpen(false)}
              aria-label="Close menu"
            >
              <X className="h-5 w-5" />
            </button>
            <Sidebar onNavigate={() => setOpen(false)} branding={branding} lang={lang} role={role} badges={badges} />
          </div>
        </div>
      )}
    </>
  );
}
