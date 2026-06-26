"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { X } from "lucide-react";
import { DOCK, type DockSection } from "@/lib/dock";

const basePath = (href: string) => href.split("?")[0];

/**
 * The phone bottom dock. Tapping a tile GOES to that section's main page AND slides in the
 * inside-left nav — a clean vertical list of the section's pages (no bloom; ideal for the
 * long Office / Money-admin menus). Hidden on desktop, where the left column runs.
 */
export function BottomNav({ role }: { role?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const isStaff = role === "owner" || role === "admin" || role === "office";
  const sections = DOCK.filter((s) => isStaff || !s.staffOnly);
  const [drawer, setDrawer] = useState<DockSection | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setDrawer(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function tap(s: DockSection) {
    router.push(s.href); // go to the page…
    setDrawer(s); // …and show that section's inside-left nav
  }

  const tile = (s: DockSection) => {
    const Icon = s.icon;
    const onRoute =
      pathname === s.href ||
      pathname.startsWith(s.href + "/") ||
      s.children.some((c) => basePath(c.href) === pathname);
    return (
      <button
        key={s.key}
        onClick={() => tap(s)}
        className={`flex flex-1 flex-col items-center gap-0.5 rounded-xl py-2 text-[9px] font-medium ${
          onRoute ? "text-[color:rgb(var(--glass-ink))]" : "text-slate-600"
        }`}
        aria-label={s.label}
      >
        <Icon className="h-5 w-5 shrink-0" />
        <span className="whitespace-nowrap leading-none">{s.short ?? s.label}</span>
      </button>
    );
  };

  const drawerItems = drawer ? drawer.children.filter((c) => isStaff || !c.staffOnly) : [];

  return (
    <>
      <nav
        // transform:translateZ(0) keeps the bar from drifting during iOS momentum scroll.
        style={{ transform: "translateZ(0)", WebkitBackfaceVisibility: "hidden" }}
        className="app-bottom-nav glass fixed inset-x-2 bottom-2 z-[70] flex items-center rounded-2xl border-white/40 px-0.5 pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        {sections.map(tile)}
      </nav>

      {drawer && (
        <div className="fixed inset-0 z-[78] lg:hidden">
          <div className="absolute inset-0 bg-slate-900/30" onClick={() => setDrawer(null)} />
          <nav className="glass absolute bottom-0 left-0 top-0 flex w-64 max-w-[80%] flex-col gap-0.5 overflow-y-auto rounded-r-2xl border-r border-white/40 px-3 py-4">
            <div className="mb-1 flex items-center justify-between px-1">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{drawer.label}</span>
              <button onClick={() => setDrawer(null)} aria-label="Close">
                <X className="h-4 w-4 text-slate-400" />
              </button>
            </div>
            {drawerItems.map((c) => {
              const cur = basePath(c.href) === pathname;
              const CIcon = c.icon;
              return (
                <Link
                  key={c.id}
                  href={c.href}
                  onClick={() => setDrawer(null)}
                  className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium ${
                    cur ? "bg-brand text-white" : "text-slate-700 hover:bg-white/60"
                  }`}
                >
                  <CIcon className="h-4 w-4 shrink-0" />
                  <span className="truncate">{c.label}</span>
                </Link>
              );
            })}
          </nav>
        </div>
      )}
    </>
  );
}
