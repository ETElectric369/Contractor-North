"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutDashboard, Briefcase, CalendarDays, Network, Sparkles, type LucideIcon } from "lucide-react";

type Tab = { label: string; icon: LucideIcon; href?: string; action?: "map" };

const TABS: Tab[] = [
  { label: "Home", href: "/dashboard", icon: LayoutDashboard },
  { label: "Jobs", href: "/jobs", icon: Briefcase },
  { label: "Map", icon: Network, action: "map" },
  { label: "Schedule", href: "/schedule", icon: CalendarDays },
  { label: "Assistant", href: "/assistant", icon: Sparkles },
];

/** Thumb-reachable bottom navigation for the installed/mobile app (hidden on desktop). */
export function BottomNav() {
  const pathname = usePathname();
  return (
    <nav className="glass fixed inset-x-2 bottom-2 z-30 flex rounded-2xl border-white/40 pb-[env(safe-area-inset-bottom)] lg:hidden">
      {TABS.map((t) => {
        const active = t.href ? pathname === t.href || pathname.startsWith(t.href + "/") : false;
        const cls = `flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[10px] font-medium ${active ? "text-[color:rgb(var(--glass-ink))]" : "text-slate-600"}`;
        const Icon = t.icon;
        if (t.action === "map") {
          return (
            <button key="map" onClick={() => window.dispatchEvent(new Event("cn:mindmap"))} className={cls} aria-label="Open the navigator">
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
