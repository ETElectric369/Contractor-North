"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { PanelLeft } from "lucide-react";
import { DOCK, type DockSection } from "@/lib/dock";
import { GlassBloom } from "./glass-bloom";

/**
 * The Mac-style glass dock (desktop). Hovering or clicking a section icon blooms
 * its line-items out over the page via the shared GlassBloom — curved branches
 * rooted at the icon, each node an individually translucent glass tile. Leaves
 * navigate; a hub (Tasks) drills in place. Retracts on mouse-leave / Esc / resize
 * / click-away. The mobile bottom dock is the same dock, slid to the bottom.
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
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const tileRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function open(section: DockSection) {
    const el = tileRefs.current[section.key];
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAnchor({ x: r.right - 6, y: r.top + r.height / 2 });
    setActive(section);
  }
  function close() {
    setActive(null);
  }
  function cancelClose() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }
  function scheduleClose() {
    cancelClose();
    closeTimer.current = setTimeout(close, 300);
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
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
            const onRoute = pathname === section.href || pathname.startsWith(section.href + "/");
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
                  if (active?.key !== section.key) open(section);
                }}
                onClick={() => (isOn ? (close(), router.push(section.href)) : open(section))}
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
        <GlassBloom
          key={active.key}
          anchor={anchor}
          title={active.label}
          rootNodes={active.children}
          direction="right"
          isStaff={isStaff}
          onClose={close}
          onEnter={cancelClose}
          onLeave={scheduleClose}
        />
      )}
    </>
  );
}
