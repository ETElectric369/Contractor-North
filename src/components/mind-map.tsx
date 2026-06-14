"use client";

import Link from "next/link";
import {
  Sparkles,
  Sun,
  Briefcase,
  CalendarDays,
  Users,
  FileText,
  Receipt,
  Circle,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  assistant: Sparkles,
  planner: Sun,
  jobs: Briefcase,
  schedule: CalendarDays,
  crm: Users,
  quotes: FileText,
  billing: Receipt,
};

export type MindNode = { key: string; label: string; href: string; count?: number };

/**
 * The "mind map" home — the org's hubs as a node graph radiating from the
 * Assistant, every node tappable. A visual launcher that matches how the IA was
 * conceived (the Assistant as the connective center). Toggleable with the normal
 * dashboard via DashboardViewToggle.
 */
export function MindMap({
  center,
  nodes,
}: {
  center: { label: string; href: string };
  nodes: MindNode[];
}) {
  const R = 38; // spoke radius, % of the square
  const positioned = nodes.map((n, i) => {
    const a = (-90 + (i * 360) / Math.max(nodes.length, 1)) * (Math.PI / 180);
    return { ...n, x: 50 + R * Math.cos(a), y: 50 + R * Math.sin(a) };
  });
  const CenterIcon = ICONS.assistant;

  return (
    <div className="relative mx-auto aspect-square w-full max-w-[560px]">
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" aria-hidden="true">
        {positioned.map((n) => (
          <line
            key={n.key}
            x1="50"
            y1="50"
            x2={n.x}
            y2={n.y}
            style={{ stroke: "var(--color-brand, #0b57c4)" }}
            strokeWidth="0.4"
            opacity="0.3"
          />
        ))}
      </svg>

      {positioned.map((n) => {
        const Icon = ICONS[n.key] ?? Circle;
        return (
          <Link
            key={n.key}
            href={n.href}
            className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
            style={{ left: `${n.x}%`, top: `${n.y}%` }}
          >
            <span className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-slate-200 bg-white shadow-sm transition-transform hover:scale-105 hover:border-brand">
              <Icon className="h-6 w-6 text-brand" />
              {typeof n.count === "number" && n.count > 0 && (
                <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold text-white">
                  {n.count}
                </span>
              )}
            </span>
            <span className="text-xs font-medium text-slate-600">{n.label}</span>
          </Link>
        );
      })}

      <Link
        href={center.href}
        className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
        style={{ left: "50%", top: "50%" }}
      >
        <span className="flex h-20 w-20 items-center justify-center rounded-full bg-brand text-white shadow-lg transition-transform hover:scale-105">
          <CenterIcon className="h-8 w-8" />
        </span>
        <span className="text-xs font-semibold text-slate-700">{center.label}</span>
      </Link>
    </div>
  );
}
