"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Briefcase, CalendarDays, Search, Sparkles, type LucideIcon } from "lucide-react";

type Tab = { label: string; icon: LucideIcon; href?: string; action?: "search" };

const TABS: Tab[] = [
  { label: "Home", href: "/dashboard", icon: LayoutDashboard },
  { label: "Jobs", href: "/jobs", icon: Briefcase },
  { label: "Schedule", href: "/schedule", icon: CalendarDays },
  { label: "Search", icon: Search, action: "search" },
  { label: "Assistant", href: "/assistant", icon: Sparkles },
];

/** Thumb-reachable bottom navigation for the installed/mobile app (hidden on desktop). */
export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-slate-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
      {TABS.map((t) => {
        const active = t.href ? pathname === t.href || pathname.startsWith(t.href + "/") : false;
        const cls = `flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium ${active ? "text-brand" : "text-slate-500"}`;
        const Icon = t.icon;
        if (t.action === "search") {
          return (
            <button key="search" onClick={() => window.dispatchEvent(new Event("cn:command"))} className={cls} aria-label="Search and commands">
              <Icon className="h-5 w-5" />
              {t.label}
            </button>
          );
        }
        return (
          <Link key={t.href} href={t.href!} className={cls}>
            <Icon className="h-5 w-5" />
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
