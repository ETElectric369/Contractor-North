"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { DOCK, type DockSection } from "@/lib/dock";
import { GlassBloom } from "./app-shell/glass-bloom";

/**
 * The dock, slid to the bottom for phones: the same glass sections, tapping one
 * blooms its line-items UPWARD over the page (the desktop left-dock and this are
 * one structure at two screen sizes). Hidden on desktop, where the left dock runs.
 */
export function BottomNav({ role }: { role?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const isStaff = role === "owner" || role === "admin" || role === "office";

  const [active, setActive] = useState<DockSection | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const tileRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  function open(section: DockSection) {
    const el = tileRefs.current[section.key];
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAnchor({ x: r.left + r.width / 2, y: r.top });
    setActive(section);
  }
  function close() {
    setActive(null);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Close the bloom whenever the route changes (a leaf was tapped).
  useEffect(() => {
    close();
  }, [pathname]);

  return (
    <>
      <nav className="glass fixed inset-x-2 bottom-2 z-[70] flex rounded-2xl border-white/40 px-0.5 pb-[env(safe-area-inset-bottom)] lg:hidden">
        {DOCK.map((section) => {
          const Icon = section.icon;
          const isOn = active?.key === section.key;
          const onRoute = pathname === section.href || pathname.startsWith(section.href + "/");
          return (
            <button
              key={section.key}
              ref={(el) => {
                tileRefs.current[section.key] = el;
              }}
              onClick={() => (isOn ? (close(), router.push(section.href)) : open(section))}
              className={`flex flex-1 flex-col items-center gap-0.5 rounded-xl py-2 text-[9px] font-medium ${
                isOn || onRoute ? "text-[color:rgb(var(--glass-ink))]" : "text-slate-600"
              }`}
              aria-label={section.label}
            >
              <Icon className="h-5 w-5" />
              {section.label}
            </button>
          );
        })}
      </nav>

      {active && anchor && (
        <GlassBloom
          key={active.key}
          anchor={anchor}
          title={active.label}
          rootNodes={active.children}
          direction="up"
          isStaff={isStaff}
          onClose={close}
        />
      )}
    </>
  );
}
