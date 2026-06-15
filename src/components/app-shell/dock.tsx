"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { PanelLeft, ChevronRight, ArrowLeft } from "lucide-react";
import { DOCK, type DockSection, type DockNode } from "@/lib/dock";

// Sea-glass-led branch palette (MindMeister-style multi-color).
const BRANCH = ["#1b9488", "#2f7dd0", "#7f77dd", "#ba7517", "#d4537e", "#0f9e75"];

type Anchor = { x: number; y: number };

/**
 * The Mac-style glass dock. Hovering or clicking a section icon blooms its
 * line-items out over the page — curved branches rooted at the icon, each node
 * an individually translucent glass tile. Leaves navigate; a hub (Tasks) drills
 * in place. Retracts on mouse-leave / Esc / click-away. Desktop only — the
 * mobile bottom-nav covers phones.
 */
export function Dock({
  branding,
  role,
  badges,
  onFlip,
}: {
  branding?: { name: string | null; logo: string | null };
  role?: string;
  badges?: Record<string, number>;
  onFlip?: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const isStaff = role === "owner" || role === "admin" || role === "office";
  const logo = branding?.logo;

  const [active, setActive] = useState<DockSection | null>(null);
  const [drill, setDrill] = useState<DockNode | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const tileRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function open(section: DockSection) {
    const el = tileRefs.current[section.key];
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAnchor({ x: r.right - 6, y: r.top + r.height / 2 });
    setActive(section);
    setDrill(null);
  }
  function close() {
    setActive(null);
    setDrill(null);
  }
  function cancelClose() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }
  function scheduleClose() {
    cancelClose();
    closeTimer.current = setTimeout(close, 300);
  }
  function go(href: string) {
    close();
    router.push(href);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    // The bloom's branches are pinned to a captured icon position; a resize
    // would leave them dangling, so just retract on resize.
    function onResize() {
      close();
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const nodes = (drill ? drill.children ?? [] : active?.children ?? []).filter(
    (n) => !n.staffOnly || isStaff,
  );

  return (
    <>
      <aside
        onMouseLeave={scheduleClose}
        onMouseEnter={cancelClose}
        className="glass relative z-[70] hidden h-full w-[88px] flex-col items-center gap-1.5 border-r border-white/40 py-3 lg:flex"
      >
        <button
          onClick={() => router.push("/dashboard")}
          className="mb-1 flex h-11 w-11 items-center justify-center rounded-2xl"
          aria-label={branding?.name ?? "Home"}
          title={branding?.name ?? "Contractor North"}
        >
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt="" className="h-10 w-10 rounded-xl object-contain" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src="/cn-logo.svg" alt="" className="h-9 w-9" />
          )}
        </button>

        <div className="flex flex-1 flex-col items-center gap-0.5">
          {DOCK.map((section) => {
            const Icon = section.icon;
            const isOn = active?.key === section.key;
            const onRoute =
              pathname === section.href || pathname.startsWith(section.href + "/");
            const badge = section.children.reduce(
              (sum, c) => sum + (c.href ? badges?.[c.href] ?? 0 : 0),
              0,
            );
            return (
              <button
                key={section.key}
                ref={(el) => {
                  tileRefs.current[section.key] = el;
                }}
                onMouseEnter={() => {
                  cancelClose();
                  // Re-entering the already-open section must not reset a drill.
                  if (active?.key !== section.key) open(section);
                }}
                onClick={() => (isOn ? go(section.href) : open(section))}
                className={`group relative flex w-[76px] flex-col items-center gap-0.5 rounded-2xl px-1 py-1 transition-transform ${
                  isOn ? "glass-tint glass-gloss scale-[1.06]" : "hover:scale-[1.06]"
                }`}
                title={section.label}
              >
                <span
                  className={`flex h-10 w-10 items-center justify-center rounded-xl ${
                    isOn || onRoute ? "text-[color:rgb(var(--glass-ink))]" : "text-slate-600"
                  }`}
                >
                  <Icon className="h-[22px] w-[22px]" />
                </span>
                <span
                  className={`text-[11px] font-medium leading-none ${
                    isOn || onRoute ? "text-slate-900" : "text-slate-600"
                  }`}
                >
                  {section.label}
                </span>
                {badge > 0 && (
                  <span className="absolute right-1.5 top-1.5 flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-amber-400 px-1 text-[9px] font-bold text-amber-900">
                    {badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <button
          onClick={onFlip}
          className="mt-1 flex flex-col items-center gap-0.5 rounded-xl px-2 py-1.5 text-[10px] text-slate-500 hover:text-slate-800"
          title="Switch to the classic menu"
        >
          <PanelLeft className="h-4 w-4" />
          Classic
        </button>
      </aside>

      {active && anchor && (
        <Bloom
          anchor={anchor}
          title={drill ? drill.label : active.label}
          nodes={nodes}
          onEnter={cancelClose}
          onLeave={scheduleClose}
          onClose={close}
          onBack={drill ? () => setDrill(null) : undefined}
          onPick={(n) => {
            if (n.children && n.children.length) setDrill(n);
            else if (n.href) go(n.href);
          }}
        />
      )}
    </>
  );
}

function Bloom({
  anchor,
  title,
  nodes,
  onEnter,
  onLeave,
  onClose,
  onBack,
  onPick,
}: {
  anchor: Anchor;
  title: string;
  nodes: DockNode[];
  onEnter: () => void;
  onLeave: () => void;
  onClose: () => void;
  onBack?: () => void;
  onPick: (n: DockNode) => void;
}) {
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const GAP = 62;
  const nodeX = anchor.x + 64;
  const span = (nodes.length - 1) * GAP;
  let start = anchor.y - span / 2;
  start = Math.min(Math.max(start, 84), Math.max(vh - 84 - span, 84));
  const ys = nodes.map((_, i) => start + i * GAP);

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-label={`${title} menu`}>
      <button
        className="absolute inset-0 cursor-default"
        aria-label="Close menu"
        onClick={onClose}
      />
      <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
        {nodes.map((n, i) => {
          const y = ys[i];
          const dx = nodeX - anchor.x;
          const d = `M${anchor.x} ${anchor.y} C ${anchor.x + dx * 0.5} ${anchor.y}, ${nodeX - dx * 0.5} ${y}, ${nodeX} ${y}`;
          return (
            <path
              key={n.id}
              d={d}
              fill="none"
              stroke={BRANCH[i % BRANCH.length]}
              strokeWidth="2.5"
              strokeLinecap="round"
              opacity="0.9"
            />
          );
        })}
      </svg>

      <div className="absolute inset-0" style={{ pointerEvents: "none" }}>
        {onBack && (
          <button
            onClick={onBack}
            onMouseEnter={onEnter}
            onMouseLeave={onLeave}
            className="glass glass-gloss absolute flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium text-slate-700"
            style={{ left: anchor.x + 4, top: anchor.y - 13, pointerEvents: "auto" }}
          >
            <ArrowLeft className="h-3.5 w-3.5" /> {title}
          </button>
        )}
        {nodes.map((n, i) => {
          const Icon = n.icon;
          const hasKids = !!(n.children && n.children.length);
          const color = BRANCH[i % BRANCH.length];
          return (
            <button
              key={n.id}
              onClick={() => onPick(n)}
              onMouseEnter={onEnter}
              onMouseLeave={onLeave}
              className="cn-bloom-node glass glass-gloss absolute flex items-center gap-2.5 rounded-xl py-2 pl-2.5 pr-3 text-left transition-transform hover:scale-[1.04]"
              style={{
                left: nodeX,
                top: ys[i],
                transform: "translateY(-50%)",
                pointerEvents: "auto",
                animationDelay: `${i * 30}ms`,
                borderLeft: `3px solid ${color}`,
              }}
            >
              <span
                className="flex h-7 w-7 items-center justify-center rounded-lg"
                style={{ color }}
              >
                <Icon className="h-[18px] w-[18px]" />
              </span>
              <span className="whitespace-nowrap text-[13px] font-medium text-slate-800">
                {n.label}
              </span>
              {hasKids && <ChevronRight className="h-4 w-4 text-slate-500" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}
