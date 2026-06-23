"use client";

import { useEffect, useRef, useState } from "react";
import { Network } from "lucide-react";
import type { NavTree } from "@/lib/nav-tree";
import { GlassBloom, resolveNavTree } from "./app-shell/glass-bloom";

/** Blooms a specific entity's actions + relationships out of this button as the
 *  glass MindMeister map (same bloom the dock uses). Verbs run via executeAction;
 *  staff-only verbs hide when isStaff is false. */
export function SectionMapButton({
  tree,
  label = "Actions",
  isStaff = true,
}: {
  tree: NavTree;
  label?: string;
  isStaff?: boolean;
}) {
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
        title="See how this connects"
      >
        <Network className="h-4 w-4" /> {label}
      </button>
      {anchor && (
        <GlassBloom
          anchor={anchor}
          title={title}
          rootNodes={nodes}
          direction="right"
          isStaff={isStaff}
          onClose={() => setAnchor(null)}
        />
      )}
    </>
  );
}
