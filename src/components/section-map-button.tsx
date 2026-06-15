"use client";

import { useEffect, useRef, useState } from "react";
import { Network } from "lucide-react";
import type { NavTree } from "@/lib/nav-tree";
import { GlassBloom, resolveNavTree } from "./app-shell/glass-bloom";

/** Blooms a specific entity's relationships + conversions out of this button as
 *  the glass MindMeister map (same bloom the dock uses). */
export function SectionMapButton({ tree, label = "Map" }: { tree: NavTree; label?: string }) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const { title, nodes } = resolveNavTree(tree);

  function toggle() {
    if (anchor) {
      setAnchor(null);
      return;
    }
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setAnchor({ x: r.right - 8, y: r.bottom + 4 });
  }

  useEffect(() => {
    function onResize() {
      setAnchor(null);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        title="Open this as a map"
      >
        <Network className="h-4 w-4" /> {label}
      </button>
      {anchor && (
        <GlassBloom
          anchor={anchor}
          title={title}
          rootNodes={nodes}
          direction="right"
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}
