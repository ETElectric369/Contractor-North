"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, ListTodo, Briefcase, CalendarPlus, FileText, Receipt, Camera, UserPlus, X } from "lucide-react";

const ACTIONS = [
  { label: "New task", href: "/tasks", icon: ListTodo },
  { label: "New customer", href: "/crm?new=1", icon: UserPlus },
  { label: "New job", href: "/jobs", icon: Briefcase },
  { label: "New appointment", href: "/schedule?view=appointments", icon: CalendarPlus },
  { label: "New quote / estimate", href: "/quotes/new", icon: FileText },
  { label: "New invoice", href: "/billing", icon: Receipt },
  { label: "Snap & file (Organize My)", href: "/organize", icon: Camera },
];

/** Quick "+" create menu. `placement="topbar"` renders an inline button with a
 *  dropdown; the default is a movable floating FAB. */
export function GlobalQuickAdd({ placement = "fab" }: { placement?: "fab" | "topbar" }) {
  const router = useRouter();
  const [pos, setPos] = useState({ x: 20, y: 168 }); // above the mic, clearing the floating glass bottom nav
  const [open, setOpen] = useState(false);
  const drag = useRef<{ sx: number; sy: number; bx: number; by: number; moved: boolean } | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("cn_quickadd_pos");
      if (saved) setPos(JSON.parse(saved));
    } catch {}
  }, []);

  const items = ACTIONS.map((a) => (
    <button
      key={a.href}
      onClick={() => {
        setOpen(false);
        router.push(a.href);
      }}
      className="relative z-10 flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-[rgb(var(--glass-tint))]/15"
    >
      <a.icon className="h-4 w-4 text-[rgb(var(--glass-ink))]" /> {a.label}
    </button>
  ));

  // Top-bar variant: inline + button with a dropdown anchored below it.
  if (placement === "topbar") {
    return (
      <div className="relative">
        <button
          onClick={() => setOpen((v) => !v)}
          aria-label="Quick add"
          title="Quick add"
          className="btn-gloss inline-flex h-10 w-10 items-center justify-center rounded-full bg-slate-900 text-white shadow-sm hover:bg-slate-700"
        >
          {open ? <X className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-[80]" onClick={() => setOpen(false)} />
            {/* Anchored to the VIEWPORT, not the button: the topbar can scroll/
                offset, which dragged an absolute menu up behind the bar so "New
                task" was unreachable. position is set INLINE because .glass-gloss
                forces position:relative (for its ::before sheen), which would
                override a Tailwind `fixed`. top 4.5rem clears the 4rem header. */}
            <div
              style={{ position: "fixed", top: "4.5rem", right: "0.5rem" }}
              className="glass glass-gloss z-[90] w-60 overflow-hidden rounded-2xl py-1.5 shadow-xl"
            >
              {items}
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <>
      {open && (
        <>
          <div className="fixed inset-0 z-[80]" onClick={() => setOpen(false)} />
          <div
            className="glass glass-gloss fixed z-[90] w-60 overflow-hidden rounded-2xl py-1.5 shadow-xl"
            style={{ right: pos.x, bottom: pos.y + 56 }}
          >
            {items}
          </div>
        </>
      )}
      <button
        onPointerDown={(e) => {
          drag.current = { sx: e.clientX, sy: e.clientY, bx: pos.x, by: pos.y, moved: false };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const dx = e.clientX - drag.current.sx;
          const dy = e.clientY - drag.current.sy;
          if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.current.moved = true;
          setPos({ x: Math.max(8, drag.current.bx - dx), y: Math.max(8, drag.current.by - dy) });
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (d && !d.moved) setOpen((v) => !v);
          else if (d) {
            try {
              localStorage.setItem("cn_quickadd_pos", JSON.stringify(pos));
            } catch {}
          }
        }}
        style={{ right: pos.x, bottom: pos.y }}
        title="Quick add — tap for shortcuts; drag to move"
        className="fixed z-40 flex h-12 w-12 touch-none items-center justify-center rounded-full bg-slate-900 text-white shadow-lg hover:bg-slate-700"
      >
        {open ? <X className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
      </button>
    </>
  );
}
