"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, LayoutGrid } from "lucide-react";
import { NAV } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { translator } from "@/lib/i18n";

export function Sidebar({
  onNavigate,
  branding,
  lang,
  role,
  badges,
  onFlip,
}: {
  onNavigate?: () => void;
  branding?: { name: string | null; logo: string | null };
  lang?: string;
  role?: string;
  /** href → count, shown as an attention chip (e.g. Organize My needs-review). */
  badges?: Record<string, number>;
  /** Switch back to the new glass dock (desktop only). */
  onFlip?: () => void;
}) {
  const pathname = usePathname();
  const name = branding?.name || "Contractor North";
  const logo = branding?.logo;
  const t = translator(lang);
  const isStaff = role === "owner" || role === "admin" || role === "office";
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      const saved = localStorage.getItem("nav-collapsed");
      // First-time users land with the back-office groups collapsed so the
      // sidebar reads as ~7 everyday items; once they toggle anything, their
      // saved preference wins.
      setCollapsed(saved === null ? { Money: true, Office: true } : JSON.parse(saved));
    } catch {
      /* ignore */
    }
  }, []);
  function toggleSection(title: string) {
    setCollapsed((c) => {
      const next = { ...c, [title]: !c[title] };
      try {
        localStorage.setItem("nav-collapsed", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  return (
    <aside className="flex h-full w-64 flex-col border-r border-slate-200 bg-white">
      <div className="flex h-16 items-center gap-2.5 border-b border-slate-200 px-5">
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={logo}
            alt={name}
            className="h-9 w-9 shrink-0 rounded-lg object-contain"
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src="/cn-logo.svg" alt="Contractor North" className="h-9 w-9 shrink-0" />
        )}
        <div className="min-w-0 leading-tight">
          <div className="truncate text-sm font-bold text-slate-900">{name}</div>
          <div className="text-[11px] text-slate-400">
            {branding?.name ? "Powered by Contractor North" : "CED Field Platform"}
          </div>
        </div>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
        {NAV.map((section) => (
          <div key={section.title}>
            <button
              onClick={() => toggleSection(section.title)}
              className="flex w-full items-center justify-between px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400 hover:text-slate-600"
            >
              {t(section.title)}
              <ChevronDown
                className={cn("h-3.5 w-3.5 transition-transform", collapsed[section.title] && "-rotate-90")}
              />
            </button>
            <ul className={cn("space-y-0.5", collapsed[section.title] && "hidden")}>
              {section.items
                .filter((item) => !item.staffOnly || isStaff)
                .map((item) => {
                const active =
                  pathname === item.href || pathname.startsWith(item.href + "/");
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      className={cn(
                        "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                        active
                          ? "bg-brand-light text-brand-dark"
                          : "text-slate-600 hover:bg-slate-50 hover:text-slate-900",
                      )}
                    >
                      <Icon
                        className={cn(
                          "h-4.5 w-4.5 shrink-0",
                          active ? "text-brand" : "text-slate-400 group-hover:text-slate-600",
                        )}
                      />
                      <span className="flex-1">{t(item.label)}</span>
                      {(badges?.[item.href] ?? 0) > 0 && (
                        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                          {badges![item.href]}
                        </span>
                      )}
                      {item.comingSoon && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-400">
                          soon
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {onFlip && (
        <button
          onClick={onFlip}
          className="mx-3 mb-1 flex items-center justify-center gap-2 rounded-lg border border-slate-200 py-2 text-xs font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-800"
        >
          <LayoutGrid className="h-4 w-4" /> Glass dock
        </button>
      )}
      <div className="border-t border-slate-200 px-5 py-3 text-[11px] text-slate-400">
        Service · Integrity · Reliability
      </div>
    </aside>
  );
}
