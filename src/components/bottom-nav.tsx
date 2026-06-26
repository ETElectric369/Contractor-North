"use client";

import { useRouter, usePathname } from "next/navigation";
import { DOCK, type DockSection } from "@/lib/dock";

const basePath = (href: string) => href.split("?")[0];

/**
 * The phone bottom dock: every section title is ONE TAP straight to its main page (no bloom)
 * — the top-of-page strip shows that section's pages. A raised center "+" creates. Hidden on
 * desktop, where the left sidebar runs.
 */
export function BottomNav({ role }: { role?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const isStaff = role === "owner" || role === "admin" || role === "office";

  const sections = DOCK.filter((s) => isStaff || !s.staffOnly);

  const tile = (section: DockSection) => {
    const Icon = section.icon;
    const onRoute =
      pathname === section.href ||
      pathname.startsWith(section.href + "/") ||
      section.children.some((c) => basePath(c.href) === pathname);
    return (
      <button
        key={section.key}
        onClick={() => router.push(section.href)}
        className={`flex flex-1 flex-col items-center gap-0.5 rounded-xl py-2 text-[9px] font-medium ${
          onRoute ? "text-[color:rgb(var(--glass-ink))]" : "text-slate-600"
        }`}
        aria-label={section.label}
      >
        <Icon className="h-5 w-5 shrink-0" />
        <span className="whitespace-nowrap leading-none">{section.short ?? section.label}</span>
      </button>
    );
  };

  return (
    <nav
      // transform:translateZ(0) promotes the bar to its own GPU layer so iOS Safari stops
      // letting it drift during momentum / rubber-band scroll.
      style={{ transform: "translateZ(0)", WebkitBackfaceVisibility: "hidden" }}
      className="app-bottom-nav glass fixed inset-x-2 bottom-2 z-[70] flex items-center rounded-2xl border-white/40 px-0.5 pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {sections.map(tile)}
    </nav>
  );
}
