"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Zap, ListTodo, Briefcase, CalendarPlus, FileText, Receipt, UserPlus, UserSearch, X, type LucideIcon } from "lucide-react";
import { QuickCaptureSheet } from "@/components/quick-capture";
import { GLASS_MENU_CLASS } from "@/components/ui/glass-menu";

// Add-cost is NOT here — it lives on My Day's Now card + the job header (job-scoped,
// works cleanly). A self-loading copy in this dropdown was redundant + fiddly.
// "Snap & file (Organize My)" is gone too: it was a second door into the same
// organized_items inbox "Capture anything" already feeds — one capture door;
// /organize stays one dock tap away under Today.
// Every verb lands on the CREATE affordance, not a list to hunt through: a
// ?new=1 param the target page reads to auto-open its "new" modal (the pattern
// /crm already uses), or a route that IS the form (/quotes/new). Don't drop the
// user on a list and make them find the + again.
// staffOnly mirrors the dock/strip/palette gating — a tech tapping "New appointment"
// was silently redirected to /planner by the staff gate; techs create tasks + jobs.
const ACTIONS: { label: string; href: string; icon: LucideIcon; staffOnly?: boolean }[] = [
  { label: "New Task", href: "/tasks?new=1", icon: ListTodo },
  { label: "New Lead", href: "/leads?new=1", icon: UserSearch, staffOnly: true },
  { label: "New Customer", href: "/crm?new=1", icon: UserPlus, staffOnly: true },
  { label: "New Job", href: "/jobs?new=1", icon: Briefcase },
  { label: "New Appointment", href: "/schedule?new=appointment", icon: CalendarPlus, staffOnly: true },
  { label: "New Estimate", href: "/quotes/new", icon: FileText, staffOnly: true },
  { label: "New Invoice", href: "/billing?new=1", icon: Receipt, staffOnly: true },
];

/** Quick "+" create menu. `placement="topbar"` renders an inline button with a
 *  dropdown; the default is a movable floating FAB. `isStaff` gates the staff-only
 *  creates the same way the dock/strip/palette already do (defaults to false —
 *  the mount site passes the role, so an unwired mount never over-shows). */
export function GlobalQuickAdd({
  placement = "fab",
  isStaff = false,
}: {
  placement?: "fab" | "topbar";
  isStaff?: boolean;
}) {
  const router = useRouter();
  const [pos, setPos] = useState({ x: 20, y: 168 }); // above the mic, clearing the floating glass bottom nav
  const [open, setOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const drag = useRef<{ sx: number; sy: number; bx: number; by: number; moved: boolean } | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("cn_quickadd_pos");
      if (saved) setPos(JSON.parse(saved));
    } catch {}
  }, []);

  const items = (
    <>
      {/* The one-field front door — FIRST, above the typed creates: any fragment is a
          valid record. Opens the capture sheet IN PLACE (a client sheet, not a nav),
          so the thought is saved before it can evaporate on a page load. */}
      <button
        onClick={() => {
          setOpen(false);
          setCaptureOpen(true);
        }}
        className="relative z-10 flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-[rgb(var(--glass-tint))]/15"
      >
        <Zap className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> Capture Anything
      </button>
      {ACTIONS.filter((a) => isStaff || !a.staffOnly).map((a) => (
        <button
          key={a.href}
          onClick={() => {
            setOpen(false);
            router.push(a.href);
          }}
          className="relative z-10 flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-[rgb(var(--glass-tint))]/15"
        >
          <a.icon className="h-4 w-4 shrink-0 text-[rgb(var(--glass-ink))]" /> {a.label}
        </button>
      ))}
    </>
  );

  // Rendered in BOTH placements (Modal renders null while closed — costless).
  const captureSheet = <QuickCaptureSheet open={captureOpen} onClose={() => setCaptureOpen(false)} />;

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
              className={`${GLASS_MENU_CLASS} w-60`}
            >
              {items}
            </div>
          </>
        )}
        {captureSheet}
      </div>
    );
  }

  return (
    <>
      {open && (
        <>
          <div className="fixed inset-0 z-[80]" onClick={() => setOpen(false)} />
          <div
            className="glass glass-gloss glass-menu fixed z-[90] w-60 overflow-hidden rounded-lg py-1.5 shadow-xl"
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
      {captureSheet}
    </>
  );
}
