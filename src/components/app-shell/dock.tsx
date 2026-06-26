"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOCK } from "@/lib/dock";

const basePath = (href: string) => href.split("?")[0];

/**
 * Desktop nav: the icon DOCK stays (one click = go to that section), and an inside-left
 * NAV column sits right beside it, listing the pages of whatever section you're in — no
 * bloom. The mobile bottom dock + slide-in drawer are the small-screen counterpart.
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
  const active =
    sections.find(
      (s) =>
        pathname === s.href ||
        pathname.startsWith(s.href + "/") ||
        s.children.some((c) => c.href && basePath(c.href) === pathname),
    ) ?? sections[0];
  const items = active.children.filter((c) => isStaff || !c.staffOnly);

  return (
    <div className="hidden h-full lg:flex">
      <aside className="glass relative z-[70] flex h-full w-[84px] flex-col items-center gap-1 border-r border-white/40 py-3">
        <Link href="/planner" className="mb-1 flex h-11 w-11 items-center justify-center rounded-2xl" aria-label={branding?.name ?? "Home"} title={branding?.name ?? "Contractor North"}>
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt="" className="h-10 w-10 rounded-xl object-contain" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/cn-logo.svg" alt="" className="h-9 w-9" />
          )}
        </Link>
        <div className="flex flex-1 flex-col items-center gap-0.5 overflow-y-auto">
          {sections.map((s) => {
            const Icon = s.icon;
            const on = s.key === active.key;
            const badge = s.children.reduce((sum, c) => sum + (c.href ? badges?.[c.href] ?? 0 : 0), 0);
            return (
              <Link
                key={s.key}
                href={s.href}
                title={s.label}
                className={`group relative flex w-[74px] flex-col items-center gap-0.5 rounded-2xl px-1 py-1.5 transition-transform ${
                  on ? "glass-tint glass-gloss" : "hover:scale-[1.05]"
                }`}
              >
                <span className={`flex h-9 w-9 items-center justify-center rounded-xl ${on ? "text-[color:rgb(var(--glass-ink))]" : "text-slate-600"}`}>
                  <Icon className="h-[21px] w-[21px]" />
                </span>
                <span className={`text-[10px] font-medium leading-none ${on ? "text-slate-900" : "text-slate-600"}`}>{s.short ?? s.label}</span>
                {badge > 0 && (
                  <span className="absolute right-1 top-1 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-amber-400 px-1 text-[9px] font-bold text-amber-900">
                    {badge}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      </aside>

      {/* The inside-left nav — Office only (its list is long). Every other section uses the
          top tabs (short, critical menus). */}
      {active.key === "office" && items.length > 1 && (
        <nav className="flex h-full w-[186px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-slate-200/80 bg-white/55 px-2.5 py-3 backdrop-blur-sm">
          <div className="px-2 pb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">{active.label}</div>
          {items.map((c) => {
            const CIcon = c.icon;
            if (c.header || !c.href) {
              return (
                <div key={c.id} className="mt-2 flex items-center gap-1.5 px-2.5 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  <CIcon className="h-3.5 w-3.5 shrink-0" />
                  {c.label}
                </div>
              );
            }
            const cur = basePath(c.href) === pathname;
            return (
              <Link
                key={c.id}
                href={c.href}
                className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                  cur ? "bg-brand text-white shadow-sm" : "text-slate-600 hover:bg-white/70"
                }`}
              >
                <CIcon className="h-4 w-4 shrink-0" />
                <span className="truncate">{c.label}</span>
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
}
