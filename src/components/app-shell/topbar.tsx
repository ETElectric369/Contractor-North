"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { Menu, X, LogOut, ArrowLeft, ArrowRight, LayoutDashboard, ListTodo, Sparkles, Wand2, Search } from "lucide-react";
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
  const pathname = usePathname();

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
          onClick={() => {
            // router.back() does nothing (looks "frozen") when there's no app
            // history — e.g. you opened a link straight into a page. Fall back home.
            if (typeof window !== "undefined" && window.history.length > 1) router.back();
            else router.push("/dashboard");
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

        {/* Big one-tap destinations — solid buttons that hand themselves back
            to the sidebar one by one as the screen narrows. */}
        <nav className="flex flex-1 items-center justify-center gap-1.5 sm:gap-2">
          {[
            { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, show: "flex" },
            { href: "/tasks", label: "Tasks", icon: ListTodo, show: "hidden min-[480px]:flex" },
            { href: "/assistant", label: "Assistant", icon: Sparkles, show: "hidden sm:flex" },
            { href: "/organize", label: "Organize", icon: Wand2, show: "hidden md:flex" },
          ].map((d) => {
            const active = pathname === d.href || pathname.startsWith(d.href + "/");
            return (
              <Link
                key={d.href}
                href={d.href}
                className={`${d.show} items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-white shadow-sm transition-colors ${
                  active ? "bg-brand-dark ring-2 ring-brand-light" : "bg-brand hover:bg-brand-dark"
                }`}
                title={d.label}
              >
                <d.icon className="h-4.5 w-4.5" />
                <span className="hidden min-[560px]:inline">{d.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-3">
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
