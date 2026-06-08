"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Zap } from "lucide-react";
import { NAV } from "@/lib/nav";
import { cn } from "@/lib/utils";
import { translator } from "@/lib/i18n";

export function Sidebar({
  onNavigate,
  branding,
  lang,
  role,
}: {
  onNavigate?: () => void;
  branding?: { name: string | null; logo: string | null };
  lang?: string;
  role?: string;
}) {
  const pathname = usePathname();
  const name = branding?.name || "Contractor North";
  const logo = branding?.logo;
  const t = translator(lang);
  const isStaff = role === "owner" || role === "admin" || role === "office";

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
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand text-white">
            <Zap className="h-5 w-5" />
          </div>
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
            <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              {t(section.title)}
            </div>
            <ul className="space-y-0.5">
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

      <div className="border-t border-slate-200 px-5 py-3 text-[11px] text-slate-400">
        Service · Integrity · Reliability
      </div>
    </aside>
  );
}
