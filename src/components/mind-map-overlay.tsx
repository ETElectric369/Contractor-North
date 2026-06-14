"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { MindMapNav } from "./mind-map-nav";
import { NAV_TREE } from "@/lib/nav-tree";

/**
 * Full-screen mind-map navigator, openable from anywhere via the `cn:mindmap`
 * window event (the topbar map button + the mobile bottom-nav). Esc or the X
 * closes it; tapping a leaf navigates and closes.
 */
export function MindMapOverlay() {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onEvt() {
      setOpen(true);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("cn:mindmap", onEvt as EventListener);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("cn:mindmap", onEvt as EventListener);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex flex-col bg-white/95 p-4 backdrop-blur">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-500">Navigator</span>
        <button
          onClick={() => setOpen(false)}
          className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"
          aria-label="Close navigator"
        >
          <X className="h-6 w-6" />
        </button>
      </div>
      <div className="flex flex-1 items-center justify-center overflow-auto py-4">
        <div className="w-full">
          <MindMapNav
            tree={NAV_TREE}
            onNavigate={(href) => {
              setOpen(false);
              router.push(href);
            }}
          />
        </div>
      </div>
    </div>
  );
}
