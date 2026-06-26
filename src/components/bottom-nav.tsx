"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Plus } from "lucide-react";
import { DOCK, type DockSection } from "@/lib/dock";
import { GlassBloom } from "./app-shell/glass-bloom";

/**
 * The phone bottom dock: four one-tap DESTINATIONS (Today / Jobs / Clock / Money) plus a
 * "More" drawer, with a raised center "+" to create. Tapping a destination goes straight
 * there — the top-of-page sub-nav shows its siblings, so there's no two-tap bloom while
 * driving. Only "More" still blooms (it's a grab-bag with no single home). Hidden on
 * desktop, where the left dock runs.
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
  // Close the More bloom whenever the route changes (a leaf was tapped).
  useEffect(() => {
    close();
  }, [pathname]);

  const sections = DOCK.filter((s) => isStaff || !s.staffOnly);
  // The center "+" sits in the MIDDLE: e.g. [Today][Jobs][Clock] (+) [Sales][Money][More].
  const split = Math.floor(sections.length / 2);
  const left = sections.slice(0, split);
  const right = sections.slice(split);

  const tile = (section: DockSection) => {
    const Icon = section.icon;
    const isOn = active?.key === section.key;
    const onRoute = pathname === section.href || pathname.startsWith(section.href + "/");
    const isMore = section.key === "more";
    return (
      <button
        key={section.key}
        ref={(el) => {
          tileRefs.current[section.key] = el;
        }}
        onClick={() => {
          // Destinations are ONE TAP — straight there. Only "More" opens a menu.
          if (isMore) {
            isOn ? close() : open(section);
          } else {
            close();
            router.push(section.href);
          }
        }}
        className={`flex flex-1 flex-col items-center gap-0.5 rounded-xl py-2 text-[9px] font-medium ${
          isOn || onRoute ? "text-[color:rgb(var(--glass-ink))]" : "text-slate-600"
        }`}
        aria-label={section.label}
      >
        <Icon className="h-5 w-5 shrink-0" />
        <span className="whitespace-nowrap leading-none">{section.label}</span>
      </button>
    );
  };

  return (
    <>
      <nav
        // transform:translateZ(0) promotes the bar to its own GPU layer so iOS Safari
        // stops letting it drift during momentum / rubber-band scroll.
        style={{ transform: "translateZ(0)", WebkitBackfaceVisibility: "hidden" }}
        className="app-bottom-nav glass fixed inset-x-2 bottom-2 z-[70] flex items-center rounded-2xl border-white/40 px-0.5 pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        {left.map(tile)}
        <button
          onClick={() => window.dispatchEvent(new Event("cn:quick-add"))}
          aria-label="Create"
          title="Create"
          className="btn-gloss mx-0.5 -mt-5 flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-brand text-white shadow-lg"
        >
          <Plus className="h-6 w-6" />
        </button>
        {right.map(tile)}
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
