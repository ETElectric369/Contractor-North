"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOCK } from "@/lib/dock";

const basePath = (href: string) => href.split("?")[0];

/**
 * The desktop LEFT SIDEBAR (replaced the icon-dock + glass bloom). Every section title is
 * one click to its main page; the active section expands its pages inline below it — a
 * readable vertical nav, ideal for the long Office / Money-admin lists. Keeps the sea-glass
 * skin. The mobile bottom dock is the small-screen counterpart.
 */
export function Dock({
  branding,
  role,
  badges,
}: {
  branding?: { name: string | null; logo: string | null };
  role?: string;
  badges?: Record<string, number>;
}) {
  const pathname = usePathname();
  const isStaff = role === "owner" || role === "admin" || role === "office";
  const logo = branding?.logo;
  const sections = DOCK.filter((s) => isStaff || !s.staffOnly);

  const sectionActive = (href: string, children: { href: string }[]) =>
    pathname === href ||
    pathname.startsWith(href + "/") ||
    children.some((c) => basePath(c.href) === pathname);

  return (
    <aside className="glass relative z-[70] hidden h-full w-[212px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-white/40 px-2.5 py-3 lg:flex">
      <Link href="/planner" className="mb-2 flex items-center gap-2 px-1" aria-label={branding?.name ?? "Home"}>
        {logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logo} alt="" className="h-9 w-9 rounded-xl object-contain" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src="/cn-logo.svg" alt="" className="h-8 w-8" />
        )}
        {branding?.name && <span className="truncate text-sm font-semibold text-slate-800">{branding.name}</span>}
      </Link>

      {sections.map((s) => {
        const Icon = s.icon;
        const active = sectionActive(s.href, s.children);
        const kids = s.children.filter((c) => isStaff || !c.staffOnly);
        const badge = s.children.reduce((sum, c) => sum + (badges?.[c.href] ?? 0), 0);
        return (
          <div key={s.key}>
            <Link
              href={s.href}
              className={`group flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-medium transition-colors ${
                active ? "glass-tint text-[color:rgb(var(--glass-ink))]" : "text-slate-600 hover:bg-white/40"
              }`}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" />
              <span className="flex-1 truncate">{s.label}</span>
              {badge > 0 && (
                <span className="flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-amber-400 px-1 text-[9px] font-bold text-amber-900">
                  {badge}
                </span>
              )}
            </Link>
            {active && kids.length > 1 && (
              <div className="mb-1 ml-[18px] mt-0.5 flex flex-col gap-0.5 border-l border-slate-300/60 pl-2.5">
                {kids.map((c) => {
                  const on = basePath(c.href) === pathname;
                  const CIcon = c.icon;
                  return (
                    <Link
                      key={c.id}
                      href={c.href}
                      className={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] transition-colors ${
                        on ? "bg-white/60 font-medium text-slate-900" : "text-slate-500 hover:bg-white/40"
                      }`}
                    >
                      <CIcon className="h-3.5 w-3.5 shrink-0 opacity-70" />
                      <span className="truncate">{c.label}</span>
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </aside>
  );
}
