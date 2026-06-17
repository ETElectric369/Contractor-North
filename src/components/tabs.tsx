"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TabDef {
  id: string;
  label: string;
  count?: number;
  icon?: React.ReactNode;
  /** Hidden from non-staff (techs). */
  staffOnly?: boolean;
  /** "overflow" tabs collapse into the "More" menu; "primary" stays visible.
   *  If no tab sets a tier, the strip auto-overflows past `maxVisible`. */
  tier?: "primary" | "overflow";
  /** Optional — omit in controlled "strip-only" mode where the page renders the
   *  panels itself (e.g. a large form heavy view). */
  content?: React.ReactNode;
}

/**
 * The one in-page tab bar — the navigation analogue of <ModalActions>. Shows one
 * panel at a time, deep-links the active tab (`urlSync`, ON by default), gates
 * `staffOnly` tabs, and on a narrow strip collapses secondary tabs into a "More"
 * menu with a scroll-fade affordance — so a phone never hides tabs off-screen.
 * Single source of truth: every tabbed page points here.
 */
export function Tabs({
  tabs,
  urlSync = true,
  paramKey = "tab",
  viewerIsStaff = true,
  maxVisible = 6,
  activeId,
  onChange,
}: {
  tabs: TabDef[];
  urlSync?: boolean;
  paramKey?: string;
  viewerIsStaff?: boolean;
  maxVisible?: number;
  /** Controlled mode: the page owns the active id (and usually renders the
   *  panels itself). Pass both to take control; urlSync is ignored. */
  activeId?: string;
  onChange?: (id: string) => void;
}) {
  const shown = tabs.filter((t) => !t.staffOnly || viewerIsStaff);
  if (activeId !== undefined) {
    return <TabView tabs={shown} activeId={activeId} onSelect={onChange ?? (() => {})} maxVisible={maxVisible} />;
  }
  if (urlSync) return <UrlSyncedTabs tabs={shown} paramKey={paramKey} maxVisible={maxVisible} />;
  return <StatefulTabs tabs={shown} maxVisible={maxVisible} />;
}

function StatefulTabs({ tabs, maxVisible }: { tabs: TabDef[]; maxVisible: number }) {
  const [active, setActive] = useState(tabs[0]?.id);
  return <TabView tabs={tabs} activeId={active} onSelect={setActive} maxVisible={maxVisible} />;
}

function UrlSyncedTabs({ tabs, paramKey, maxVisible }: { tabs: TabDef[]; paramKey: string; maxVisible: number }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const fromUrl = searchParams.get(paramKey);
  const initial = tabs.some((t) => t.id === fromUrl) ? (fromUrl as string) : tabs[0]?.id;
  const [active, setActive] = useState(initial);

  function onSelect(id: string) {
    setActive(id);
    // Reflect the tab in the URL without a navigation/refetch — keeps switching
    // instant while making the tab shareable + reload-safe. Rebuild the query so
    // other params survive.
    const params = new URLSearchParams(searchParams.toString());
    params.set(paramKey, id);
    window.history.replaceState(null, "", `${pathname}?${params.toString()}`);
  }

  return <TabView tabs={tabs} activeId={active} onSelect={onSelect} maxVisible={maxVisible} />;
}

function TabView({
  tabs,
  activeId,
  onSelect,
  maxVisible,
}: {
  tabs: TabDef[];
  activeId?: string;
  onSelect: (id: string) => void;
  maxVisible: number;
}) {
  const current = tabs.find((t) => t.id === activeId) ?? tabs[0];

  // Split into always-visible vs overflow. Explicit tiers win; otherwise the
  // strip auto-overflows everything past `maxVisible`.
  const hasTiers = tabs.some((t) => t.tier);
  let primary: TabDef[];
  let overflow: TabDef[];
  if (hasTiers) {
    primary = tabs.filter((t) => t.tier !== "overflow");
    overflow = tabs.filter((t) => t.tier === "overflow");
  } else if (tabs.length > maxVisible) {
    primary = tabs.slice(0, maxVisible);
    overflow = tabs.slice(maxVisible);
  } else {
    primary = tabs;
    overflow = [];
  }
  // Hoist the active overflow tab into the strip so it's never hidden.
  const activeInOverflow = !!current && overflow.some((t) => t.id === current.id);
  const strip = activeInOverflow ? [...primary, current!] : primary;

  return (
    <div>
      <div className="mb-5 flex items-end gap-1 border-b border-slate-200">
        <ScrollStrip tabs={strip} activeId={current?.id} onSelect={onSelect} />
        {overflow.length > 0 && <MoreMenu tabs={overflow} activeId={current?.id} onSelect={onSelect} />}
      </div>
      {current?.content != null && <div>{current.content}</div>}
    </div>
  );
}

/** The horizontally-scrollable run of tabs, with edge fades when it overflows. */
function ScrollStrip({ tabs, activeId, onSelect }: { tabs: TabDef[]; activeId?: string; onSelect: (id: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      setFade({
        left: el.scrollLeft > 4,
        right: el.clientWidth > 0 && el.scrollLeft + el.clientWidth < el.scrollWidth - 4,
      });
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [tabs.length]);

  return (
    <div className="relative min-w-0 flex-1">
      {fade.left && <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-white to-transparent" />}
      <div ref={ref} className="flex gap-1 overflow-x-auto scrollbar-none">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            className={cn(
              "flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors",
              activeId === t.id ? "border-brand text-brand" : "border-transparent text-slate-500 hover:text-slate-800",
            )}
          >
            {t.icon}
            {t.label}
            {typeof t.count === "number" && t.count > 0 && (
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                  activeId === t.id ? "bg-brand-light text-brand-dark" : "bg-slate-100 text-slate-500",
                )}
              >
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>
      {fade.right && <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-white to-transparent" />}
    </div>
  );
}

/** The trailing "More ▾" menu holding overflow tabs (always visible, never faded). */
function MoreMenu({ tabs, activeId, onSelect }: { tabs: TabDef[]; activeId?: string; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const activeHere = tabs.some((t) => t.id === activeId);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
          activeHere ? "border-brand text-brand" : "border-transparent text-slate-500 hover:text-slate-800",
        )}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        More <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 min-w-[180px] overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                onSelect(t.id);
                setOpen(false);
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
                t.id === activeId ? "bg-brand-light/40 font-medium text-brand-dark" : "text-slate-700 hover:bg-slate-50",
              )}
            >
              {t.icon}
              <span className="flex-1">{t.label}</span>
              {typeof t.count === "number" && t.count > 0 && (
                <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">{t.count}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
