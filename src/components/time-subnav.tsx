"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Play, CalendarClock } from "lucide-react";

/** Sub-nav that unifies Timeclock + Timecards as one "Time" area — the two pages
 *  share this tab bar, so they read as a single page with two tabs. Techs only have
 *  Timeclock (Timecards is office-only), so the bar hides for them. */
export function TimeSubnav({ isStaff }: { isStaff?: boolean }) {
  const pathname = usePathname();
  if (!isStaff) return null;
  const tabs = [
    { label: "Timeclock", href: "/timeclock", icon: Play },
    { label: "Timecards", href: "/timecards", icon: CalendarClock },
  ];
  return (
    <div className="mb-4 inline-flex gap-1 rounded-xl border border-slate-200 bg-white p-1">
      {tabs.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(tab.href + "/");
        const Icon = tab.icon;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
              active ? "bg-brand text-white" : "text-slate-600 hover:bg-slate-50"
            }`}
          >
            <Icon className="h-4 w-4" /> {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
