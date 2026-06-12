"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, ListTodo, Briefcase, FileText, Receipt, Camera, X } from "lucide-react";

const ACTIONS = [
  { label: "New task", href: "/tasks", icon: ListTodo },
  { label: "New job", href: "/jobs", icon: Briefcase },
  { label: "New quote / estimate", href: "/quotes/new", icon: FileText },
  { label: "New invoice", href: "/billing", icon: Receipt },
  { label: "Snap & file (Organize My)", href: "/organize", icon: Camera },
];

/** Movable floating "+" — always on screen, opens quick-create shortcuts. */
export function GlobalQuickAdd() {
  const router = useRouter();
  const [pos, setPos] = useState({ x: 20, y: 84 }); // from bottom-right, above the mic
  const [open, setOpen] = useState(false);
  const drag = useRef<{ sx: number; sy: number; bx: number; by: number; moved: boolean } | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("cn_quickadd_pos");
      if (saved) setPos(JSON.parse(saved));
    } catch {}
  }, []);

  return (
    <>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className="fixed z-50 w-60 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-xl"
            style={{ right: pos.x, bottom: pos.y + 56 }}
          >
            {ACTIONS.map((a) => (
              <button
                key={a.href}
                onClick={() => {
                  setOpen(false);
                  router.push(a.href);
                }}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-50"
              >
                <a.icon className="h-4 w-4 text-brand" /> {a.label}
              </button>
            ))}
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
