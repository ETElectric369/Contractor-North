"use client";

import { Network } from "lucide-react";
import type { NavTree } from "@/lib/nav-tree";

/** Opens the mind-map overlay for a specific entity's sections (its own tree). */
export function SectionMapButton({ tree, label = "Map" }: { tree: NavTree; label?: string }) {
  return (
    <button
      onClick={() => window.dispatchEvent(new CustomEvent("cn:mindmap", { detail: { tree } }))}
      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
      title="Open this as a mind-map"
    >
      <Network className="h-4 w-4" /> {label}
    </button>
  );
}
