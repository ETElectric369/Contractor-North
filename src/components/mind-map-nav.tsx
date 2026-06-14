"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Home,
  Sun,
  Briefcase,
  CalendarDays,
  Users,
  Receipt,
  Settings,
  Sparkles,
  Wand2,
  Clock,
  ListChecks,
  List,
  Play,
  FileText,
  ClipboardCheck,
  Map as MapIcon,
  Mail,
  Wallet,
  Tags,
  Boxes,
  Calculator,
  Stamp,
  HardHat,
  BookOpen,
  FileSpreadsheet,
  Wrench,
  CheckCircle2,
  Columns3,
  Circle,
  ArrowLeft,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import type { NavTree, TreeNode } from "@/lib/nav-tree";

const ICONS: Record<string, LucideIcon> = {
  home: Home,
  sun: Sun,
  briefcase: Briefcase,
  calendar: CalendarDays,
  users: Users,
  receipt: Receipt,
  settings: Settings,
  sparkles: Sparkles,
  wand: Wand2,
  clock: Clock,
  listCheck: ListChecks,
  list: List,
  play: Play,
  fileText: FileText,
  layoutBoard: Columns3,
  clipboardCheck: ClipboardCheck,
  map: MapIcon,
  mail: Mail,
  wallet: Wallet,
  tags: Tags,
  boxes: Boxes,
  calculator: Calculator,
  stamp: Stamp,
  hardhat: HardHat,
  bookOpen: BookOpen,
  fileSpreadsheet: FileSpreadsheet,
  wrench: Wrench,
  checkbox: CheckCircle2,
};

function Ic({ k, className }: { k: string; className?: string }) {
  const I = ICONS[k] ?? Circle;
  return <I className={className} />;
}

/**
 * Recursive mind-map navigator. Tapping a hub drills into its mini-map (the hub
 * glides to center and its sub-options bloom out); leaves navigate. The center
 * node and breadcrumb walk back up. Reused by the dashboard, the global overlay,
 * and detail pages.
 */
export function MindMapNav({
  tree,
  counts,
  onNavigate,
}: {
  tree: NavTree;
  counts?: Record<string, number>;
  onNavigate?: (href: string) => void;
}) {
  const router = useRouter();
  const [path, setPath] = useState<TreeNode[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const focusNode = path.length ? path[path.length - 1] : null;
  const focusChildren = focusNode ? focusNode.children ?? [] : tree.nodes;
  const centerLabel = focusNode ? focusNode.label : tree.center.label;
  const centerIcon = focusNode ? focusNode.icon : tree.center.icon;

  function go(href: string) {
    if (onNavigate) onNavigate(href);
    else router.push(href);
  }
  function tapChild(n: TreeNode) {
    if (n.children && n.children.length) {
      setPath((p) => [...p, n]);
      return;
    }
    if (n.run) {
      runAction(n);
      return;
    }
    if (n.href) go(n.href);
  }
  async function runAction(n: TreeNode) {
    setBusyId(n.id);
    setErr(null);
    try {
      const res = await n.run!();
      if (res.ok && res.id && n.hrefPrefix) {
        go(`${n.hrefPrefix}${res.id}`);
        return;
      }
      if (res.ok) {
        if (n.href) go(n.href);
        else router.refresh();
        return;
      }
      setErr(res.error ?? "Couldn't do that.");
    } catch {
      setErr("Couldn't do that.");
    }
    setBusyId(null);
  }
  function tapCenter() {
    if (path.length) setPath((p) => p.slice(0, -1));
    else if (tree.center.href) go(tree.center.href);
  }

  const R = 38;
  const positioned = focusChildren.map((n, i) => {
    const a = (-90 + (i * 360) / Math.max(focusChildren.length, 1)) * (Math.PI / 180);
    return { n, x: 50 + R * Math.cos(a), y: 50 + R * Math.sin(a) };
  });

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-center gap-1.5 text-sm">
        <button
          onClick={() => setPath([])}
          className={path.length ? "text-slate-500 hover:text-slate-800" : "font-medium text-slate-900"}
        >
          {tree.center.label}
        </button>
        {path.map((n, i) => (
          <span key={n.id} className="flex items-center gap-1.5">
            <span className="text-slate-300">›</span>
            <button
              onClick={() => setPath((p) => p.slice(0, i + 1))}
              className={i === path.length - 1 ? "font-medium text-slate-900" : "text-slate-500 hover:text-slate-800"}
            >
              {n.label}
            </button>
          </span>
        ))}
      </div>

      <div key={focusNode?.id ?? "root"} className="relative mx-auto aspect-square w-full max-w-[520px]">
        <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" aria-hidden="true">
          {positioned.map((p) => (
            <line
              key={p.n.id}
              x1="50"
              y1="50"
              x2={p.x}
              y2={p.y}
              style={{ stroke: "var(--color-brand, #0b57c4)" }}
              strokeWidth="0.4"
              opacity="0.3"
            />
          ))}
        </svg>

        {positioned.map((p, i) => {
          const cnt = p.n.countKey ? counts?.[p.n.countKey] : undefined;
          const hasKids = !!(p.n.children && p.n.children.length);
          const isAction = !!p.n.run;
          const isBusy = busyId === p.n.id;
          return (
            <button
              key={p.n.id}
              onClick={() => tapChild(p.n)}
              className="mm-bloom absolute flex flex-col items-center gap-1"
              style={{ left: `${p.x}%`, top: `${p.y}%`, animationDelay: `${i * 28}ms` }}
            >
              <span className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-slate-200 bg-white shadow-sm transition-transform hover:scale-110 hover:border-brand">
                {isBusy ? (
                  <Loader2 className="h-6 w-6 animate-spin text-brand" />
                ) : (
                  <Ic k={p.n.icon} className="h-6 w-6 text-brand" />
                )}
                {typeof cnt === "number" && cnt > 0 && (
                  <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-brand px-1 text-[10px] font-semibold text-white">
                    {cnt}
                  </span>
                )}
                {hasKids && (
                  <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-slate-900 text-[10px] leading-none text-white">
                    +
                  </span>
                )}
                {isAction && (
                  <span className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-green-600 text-[10px] leading-none text-white">
                    +
                  </span>
                )}
              </span>
              <span className="max-w-[90px] text-center text-xs font-medium leading-tight text-slate-600">{p.n.label}</span>
            </button>
          );
        })}

        <button
          onClick={tapCenter}
          className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1"
        >
          <span className="flex h-20 w-20 items-center justify-center rounded-full bg-brand text-white shadow-lg transition-transform hover:scale-105">
            {path.length ? <ArrowLeft className="h-7 w-7" /> : <Ic k={centerIcon} className="h-8 w-8" />}
          </span>
          <span className="text-xs font-semibold text-slate-700">{path.length ? `Back · ${centerLabel}` : centerLabel}</span>
        </button>
      </div>
      {err && (
        <div className="mx-auto mt-3 max-w-sm rounded-lg bg-red-50 px-3 py-2 text-center text-sm text-red-700">{err}</div>
      )}
    </div>
  );
}
