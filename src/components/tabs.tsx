"use client";

import { isValidElement, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ChevronDown, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** A tab in the shared strip. `href` makes it a <Link> (server-rendered/link
 *  switchers); otherwise it's a button driven by onSelect (client switchers). */
export interface TabBarItem {
  id: string;
  label: string;
  count?: number;
  /** Two shapes, two homes: an already-rendered ELEMENT (e.g. <Archive className=… />)
   *  shows inline in the strip as before; a LucideIcon COMPONENT reference shows ONLY
   *  in the "More" panel as a chamfered glass chip — width-neutral for the strip and
   *  its measuring ghost, so passing it never changes how many tabs fit. */
  icon?: React.ReactNode | LucideIcon;
  /** Cluster header in the "More" overflow (uppercase rail-style row). Ungrouped
   *  items list first; groups follow in first-appearance order. */
  group?: string;
  href?: string;
  /** Hidden from non-staff (techs). */
  staffOnly?: boolean;
  /** "overflow" tabs collapse into the "More" menu; "primary" stays visible.
   *  If no tab sets a tier, the strip auto-overflows past `maxVisible`. */
  tier?: "primary" | "overflow";
}

/** A component reference (vs a rendered element) is menu-only chrome. Lucide icons
 *  are forwardRef exotics (objects, not functions), so check both shapes. */
function componentIcon(icon: TabBarItem["icon"]): LucideIcon | null {
  if (icon == null || typeof icon === "string" || typeof icon === "number" || typeof icon === "boolean") return null;
  if (isValidElement(icon) || Array.isArray(icon)) return null;
  if (typeof icon === "function" || typeof icon === "object") return icon as LucideIcon;
  return null;
}

/** What the strip (and its measuring ghost) renders — element icons only. */
function inlineIcon(icon: TabBarItem["icon"]): React.ReactNode {
  return componentIcon(icon) ? null : (icon as React.ReactNode);
}

export interface TabDef extends TabBarItem {
  /** Optional — omit in controlled "strip-only" mode where the page renders the
   *  panels itself (e.g. a large form-heavy view). */
  content?: React.ReactNode;
}

/**
 * The one in-page tab bar — the navigation analogue of <ModalActions>. Shows one
 * panel at a time, deep-links the active tab (`urlSync`, ON by default), gates
 * `staffOnly` tabs, and on a narrow strip collapses secondary tabs into a "More"
 * menu with a scroll-fade affordance. Single source of truth: every tabbed page
 * points here. For server-rendered/link switchers (e.g. the scheduler) use the
 * exported <TabBar> with `href` items directly.
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
  return (
    <div>
      <TabBar items={tabs} activeId={current?.id} onSelect={onSelect} maxVisible={maxVisible} />
      {current?.content != null && <div>{current.content}</div>}
    </div>
  );
}

/**
 * The shared tab STRIP — the single source of truth for tab styling. Used by the
 * client <Tabs> (onSelect) AND by server-rendered/link switchers (items carry an
 * `href`). Underline style, count badges, a "More" overflow menu, and edge-fades
 * so a phone never hides tabs off-screen.
 */
export function TabBar({
  items,
  activeId,
  onSelect,
  viewerIsStaff = true,
  maxVisible = 6,
}: {
  items: TabBarItem[];
  activeId?: string;
  onSelect?: (id: string) => void;
  viewerIsStaff?: boolean;
  maxVisible?: number;
}) {
  const shown = items.filter((t) => !t.staffOnly || viewerIsStaff);
  // `tier` is a PRIORITY hint — primaries prefer to stay visible, overflow prefer
  // the More menu — but the real split is MEASURED against the available width, so
  // the strip fits any screen (more tabs on a wide monitor, fewer on a phone) with
  // the overflow collapsing into More, instead of a fixed count that scrolls.
  const hasTiers = shown.some((t) => t.tier);
  const ordered = hasTiers
    ? [...shown.filter((t) => t.tier !== "overflow"), ...shown.filter((t) => t.tier === "overflow")]
    : shown;

  const wrapRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const [visN, setVisN] = useState(Math.min(ordered.length, maxVisible));
  const sig = ordered.map((t) => `${t.id}:${t.count ?? ""}`).join("|");

  useEffect(() => {
    const wrap = wrapRef.current;
    const ghost = ghostRef.current;
    if (!wrap || !ghost) return;
    const measure = () => {
      const avail = wrap.clientWidth;
      if (!avail) return;
      const tabEls = Array.from(ghost.querySelectorAll<HTMLElement>("[data-gtab]"));
      const moreW = (ghost.querySelector<HTMLElement>("[data-gmore]")?.offsetWidth ?? 60) + 4;
      let used = 0;
      let n = 0;
      for (let i = 0; i < tabEls.length; i++) {
        used += tabEls[i].offsetWidth + 4; // gap-1 = 4px
        const willOverflow = i < tabEls.length - 1;
        if (used + (willOverflow ? moreW : 0) <= avail) n = i + 1;
        else break;
      }
      setVisN(Math.max(1, n)); // always show at least one tab
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [sig, maxVisible]);

  const primary = ordered.slice(0, visN);
  const overflow = ordered.slice(visN);
  const activeItem = shown.find((t) => t.id === activeId);
  const activeInOverflow = !!activeItem && overflow.some((t) => t.id === activeItem.id);
  const strip = activeInOverflow ? [...primary, activeItem!] : primary;

  return (
    <div ref={wrapRef} className="relative mb-5 flex items-end gap-1 border-b border-slate-200">
      <ScrollStrip items={strip} activeId={activeId} onSelect={onSelect} />
      {overflow.length > 0 && <MoreMenu items={overflow} activeId={activeId} onSelect={onSelect} />}
      {/* Hidden measuring row: every tab + a More button at natural width, so we can
          compute how many fit without affecting layout (absolute, off-screen). */}
      <div ref={ghostRef} aria-hidden className="invisible pointer-events-none absolute -left-[9999px] top-0 flex gap-1">
        {ordered.map((t) => (
          <span key={t.id} data-gtab className={TAB_CLS}>
            {inlineIcon(t.icon)}
            {t.label}
            <CountBadge count={t.count} active={false} />
          </span>
        ))}
        <span data-gmore className="flex items-center gap-1 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium">
          More <ChevronDown className="h-3.5 w-3.5" />
        </span>
      </div>
    </div>
  );
}

function CountBadge({ count, active }: { count?: number; active: boolean }) {
  if (typeof count !== "number" || count <= 0) return null;
  return (
    <span
      className={cn(
        "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
        // Active badge picks up the sea-glass tint + ink (matches the active tab), not brand blue.
        active ? "bg-[rgb(var(--glass-tint))]/15 text-[rgb(var(--glass-ink))]" : "bg-slate-100 text-slate-500",
      )}
    >
      {count}
    </span>
  );
}

const TAB_CLS =
  "flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors";

/** The horizontally-scrollable run of tabs, with edge fades when it overflows.
 *  Each item renders as a <Link> when it has an href, else a <button>. */
function ScrollStrip({ items, activeId, onSelect }: { items: TabBarItem[]; activeId?: string; onSelect?: (id: string) => void }) {
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
  }, [items.length]);

  return (
    <div className="relative min-w-0 flex-1">
      {fade.left && <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-white to-transparent" />}
      <div ref={ref} className="flex gap-1 overflow-x-auto scrollbar-none">
        {items.map((t) => {
          const active = activeId === t.id;
          const inner = (
            <>
              {inlineIcon(t.icon)}
              {t.label}
              <CountBadge count={t.count} active={active} />
            </>
          );
          // Active tab is sea-glass, not brand blue: dark-teal ink text + a matching
          // ink underline (the tab grammar keeps the underline strip). Resting tabs warm
          // to ink-teal on hover so mouse-over is consistent with the dock/nav.
          const cls = cn(
            TAB_CLS,
            active
              ? "border-[rgb(var(--glass-ink))] text-[rgb(var(--glass-ink))]"
              : "border-transparent text-slate-500 hover:text-[rgb(var(--glass-ink))]",
          );
          return t.href ? (
            <Link key={t.id} href={t.href} scroll={false} className={cls}>
              {inner}
            </Link>
          ) : (
            <button key={t.id} onClick={() => onSelect?.(t.id)} className={cls}>
              {inner}
            </button>
          );
        })}
      </div>
      {fade.right && <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-6 bg-gradient-to-l from-white to-transparent" />}
    </div>
  );
}

/** The trailing "More ▾" menu holding overflow tabs (always visible, never faded).
 *  Skinned with the glass-menu recipe (the + quick-add / ⋯ actions grammar); items
 *  with a `group` render under uppercase cluster headers — the dock rail's exact
 *  header style — ungrouped items first, groups in first-appearance order. */
function MoreMenu({ items, activeId, onSelect }: { items: TabBarItem[]; activeId?: string; onSelect?: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const activeHere = items.some((t) => t.id === activeId);

  useEffect(() => {
    if (!open) return;
    // THE MODAL RULE: the app's Modal is in-place (not portaled), so never close —
    // and thereby unmount panel contents — while one is open. Its z-[120] overlay
    // covers this panel; bail until body.modal-open clears.
    const onDoc = (e: MouseEvent) => {
      if (document.body.classList.contains("modal-open")) return;
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (document.body.classList.contains("modal-open")) return;
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Ungrouped items lead (no header), then each group in first-appearance order.
  const sections: { group?: string; items: TabBarItem[] }[] = [{ items: items.filter((t) => !t.group) }];
  for (const t of items) {
    if (!t.group) continue;
    const s = sections.find((x) => x.group === t.group);
    if (s) s.items.push(t);
    else sections.push({ group: t.group, items: [t] });
  }

  // relative z-10 lifts rows above the .glass-gloss sheen (its ::before overlays inset-0).
  const itemCls = (active: boolean) =>
    cn(
      "relative z-10 flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
      // Active row is sea-glass tint + ink (the app-wide active look), not brand blue.
      active
        ? "bg-[rgb(var(--glass-tint))]/20 font-medium text-[rgb(var(--glass-ink))]"
        : "text-slate-700 hover:bg-[rgb(var(--glass-tint))]/15",
    );

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
          // "More" mirrors the active tab: sea-glass ink underline + text when an overflow
          // tab is active; ink-teal on hover otherwise. Never brand blue.
          activeHere
            ? "border-[rgb(var(--glass-ink))] text-[rgb(var(--glass-ink))]"
            : "border-transparent text-slate-500 hover:text-[rgb(var(--glass-ink))]",
        )}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        More <ChevronDown className="h-3.5 w-3.5" />
      </button>
      {open && (
        // position set inline because .glass-gloss forces position:relative, which
        // would override a Tailwind `absolute` (the SectionActionsMenu gotcha).
        <div
          style={{ position: "absolute", right: 0, top: "calc(100% + 0.25rem)" }}
          className="glass glass-gloss glass-menu z-30 min-w-[180px] overflow-hidden rounded-xl py-1 shadow-xl"
        >
          {/* Opaque backing — the job-manage-menu.tsx pattern (cn-v315's "ghost Edit
              pill" root cause). glass-menu's 40% white let the page's cards/buttons
              read straight through the panel wherever a backdrop-filter ancestor (the
              job hub's sticky glass dock, any glass card) breaks the panel's own blur
              (a nested backdrop root can't sample the page). Near-solid white + tint
              behind the rows, under the .glass-gloss sheen (-z-10 vs the z-10 rows). */}
          <div aria-hidden className="absolute inset-0 -z-10 bg-white/85" />
          <div aria-hidden className="absolute inset-0 -z-10 bg-[rgb(var(--glass-tint))]/10" />
          {sections.map(
            (s, si) =>
              s.items.length > 0 && (
                <div key={s.group ?? "ungrouped"}>
                  {s.group && (
                    <div
                      className={cn(
                        "relative z-10 px-3 pb-0.5 pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400",
                        // Breathing room, but only when rows rendered above this header.
                        (sections[0].items.length > 0 || si > 1) && "mt-2",
                      )}
                    >
                      {s.group}
                    </div>
                  )}
                  {s.items.map((t) => {
                    const active = t.id === activeId;
                    const MenuIcon = componentIcon(t.icon);
                    const inner = (
                      <>
                        {MenuIcon ? (
                          // The bloom node grammar: a chamfered glass-tint chip.
                          <span className="cn-cut glass-tint flex h-7 w-7 shrink-0 items-center justify-center">
                            <MenuIcon className="h-3.5 w-3.5 text-[rgb(var(--glass-ink))]" />
                          </span>
                        ) : (
                          inlineIcon(t.icon)
                        )}
                        <span className="flex-1">{t.label}</span>
                        {typeof t.count === "number" && t.count > 0 && (
                          <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500">{t.count}</span>
                        )}
                      </>
                    );
                    return t.href ? (
                      <Link key={t.id} href={t.href} scroll={false} className={itemCls(active)} onClick={() => setOpen(false)}>
                        {inner}
                      </Link>
                    ) : (
                      <button
                        key={t.id}
                        onClick={() => {
                          onSelect?.(t.id);
                          setOpen(false);
                        }}
                        className={itemCls(active)}
                      >
                        {inner}
                      </button>
                    );
                  })}
                </div>
              ),
          )}
        </div>
      )}
    </div>
  );
}
