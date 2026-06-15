"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Home, Sun, Briefcase, CalendarDays, Users, Receipt, Settings, Sparkles, Wand2,
  Clock, ListChecks, List, Play, FileText, Columns3, ClipboardCheck, Map as MapIcon,
  Mail, Wallet, Tags, Boxes, Calculator, Stamp, HardHat, BookOpen, FileSpreadsheet,
  Wrench, CheckCircle2, Circle, ArrowLeft, ChevronRight, Loader2,
  type LucideIcon,
} from "lucide-react";
import type { NavTree, TreeNode } from "@/lib/nav-tree";

/** A node in a glass bloom. `children` drills in place; `run` performs a server
 *  action then navigates to hrefPrefix + the returned id; `href` navigates. */
export type BloomNode = {
  id: string;
  label: string;
  icon: LucideIcon;
  href?: string;
  run?: () => Promise<{ ok: boolean; id?: string; error?: string }>;
  hrefPrefix?: string;
  children?: BloomNode[];
  staffOnly?: boolean;
};

const ICONS: Record<string, LucideIcon> = {
  home: Home, sun: Sun, briefcase: Briefcase, calendar: CalendarDays, users: Users,
  receipt: Receipt, settings: Settings, sparkles: Sparkles, wand: Wand2, clock: Clock,
  listCheck: ListChecks, list: List, play: Play, fileText: FileText, layoutBoard: Columns3,
  clipboardCheck: ClipboardCheck, map: MapIcon, mail: Mail, wallet: Wallet, tags: Tags,
  boxes: Boxes, calculator: Calculator, stamp: Stamp, hardhat: HardHat, bookOpen: BookOpen,
  fileSpreadsheet: FileSpreadsheet, wrench: Wrench, checkbox: CheckCircle2,
};

/** Convert a string-iconed NavTree (lib/nav-tree) into component-iconed BloomNodes. */
export function resolveNavTree(tree: NavTree): { title: string; nodes: BloomNode[] } {
  const conv = (ns: TreeNode[]): BloomNode[] =>
    ns.map((n) => ({
      id: n.id,
      label: n.label,
      icon: ICONS[n.icon] ?? Circle,
      href: n.href,
      run: n.run,
      hrefPrefix: n.hrefPrefix,
      children: n.children ? conv(n.children) : undefined,
    }));
  return { title: tree.center.label, nodes: conv(tree.nodes) };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

const PANEL_W = 196;
const PAD = 6;
const HEADER = 26;
const ROW_H = 34;
const ROW_GAP = 2;

/**
 * The glass bloom: a frosted dark-glass cut-corner panel holding a section's
 * items as a tight list of light glass tiles, with thin sea-glass branch lines
 * running from the dock icon to each row. Drills hubs in place, runs conversion
 * actions, or navigates. Used by the left dock (`direction="right"`) and the
 * mobile bottom dock (`direction="up"`, panel sits above the icon).
 */
export function GlassBloom({
  anchor,
  title,
  rootNodes,
  direction = "right",
  isStaff = true,
  onClose,
  onEnter,
  onLeave,
}: {
  anchor: { x: number; y: number };
  title: string;
  rootNodes: BloomNode[];
  direction?: "right" | "up";
  isStaff?: boolean;
  onClose: () => void;
  onEnter?: () => void;
  onLeave?: () => void;
}) {
  const router = useRouter();
  const [path, setPath] = useState<BloomNode[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const focus = path.length ? path[path.length - 1] : null;
  const nodes = (focus ? focus.children ?? [] : rootNodes).filter((n) => !n.staffOnly || isStaff);
  const heading = focus ? focus.label : title;

  function go(href: string) {
    onClose();
    router.push(href);
  }
  async function runAction(n: BloomNode) {
    setBusyId(n.id);
    setErr(null);
    try {
      const res = await n.run!();
      if (res.ok && res.id && n.hrefPrefix) return go(`${n.hrefPrefix}${res.id}`);
      if (res.ok) {
        if (n.href) return go(n.href);
        router.refresh();
        onClose();
        return;
      }
      setErr(res.error ?? "Couldn't do that.");
    } catch {
      setErr("Couldn't do that.");
    }
    setBusyId(null);
  }
  function pick(n: BloomNode) {
    if (n.children && n.children.length) setPath((p) => [...p, n]);
    else if (n.run) runAction(n);
    else if (n.href) go(n.href);
  }

  const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const n = nodes.length;
  // Shrink the rows just enough that the whole list always fits the viewport
  // (so you can always see every item, never a cut-off panel).
  const availList = vh - 24 - PAD * 2 - HEADER;
  const baseListH = n * ROW_H + Math.max(0, n - 1) * ROW_GAP;
  const scale = baseListH > availList ? availList / baseListH : 1;
  const rowH = Math.max(28, ROW_H * scale);
  const gap = Math.max(1, ROW_GAP * scale);
  const step = rowH + gap;
  const listH = n * rowH + Math.max(0, n - 1) * gap;
  const panelH = PAD * 2 + HEADER + listH;

  const panelLeft =
    direction === "up"
      ? clamp(anchor.x - PANEL_W / 2, 8, vw - PANEL_W - 8)
      : clamp(anchor.x + 52, 8, vw - PANEL_W - 8);
  const panelTop =
    direction === "up"
      ? clamp(anchor.y - 18 - panelH, 8, vh - panelH - 8)
      : clamp(anchor.y - panelH / 2, 8, vh - panelH - 8);

  const rowW = PANEL_W - PAD * 2;
  const rowTop = (i: number) => panelTop + PAD + HEADER + i * step;
  const rowCY = (i: number) => rowTop(i) + rowH / 2;

  function branch(by: number) {
    const bx = panelLeft;
    const mx = anchor.x + (bx - anchor.x) * 0.5;
    return `M${anchor.x} ${anchor.y} C ${mx} ${anchor.y}, ${mx} ${by}, ${bx} ${by}`;
  }

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-label={`${heading} menu`}>
      <button
        className="absolute inset-0 cursor-default"
        aria-label="Close menu"
        onClick={onClose}
        style={{ background: "rgba(15, 23, 42, 0.16)" }}
      />

      <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
        {nodes.map((node, i) => (
          <path
            key={node.id}
            d={branch(rowCY(i))}
            fill="none"
            stroke="rgb(var(--glass-tint))"
            strokeWidth="1.5"
            strokeLinecap="round"
            opacity="0.85"
          />
        ))}
      </svg>

      {/* Backing panel — a frosted dark rounded box; clicking inside it never
          closes the bloom (only the backdrop does). */}
      <div
        className="cn-fade absolute rounded-2xl border border-white/15"
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        style={{
          left: panelLeft,
          top: panelTop,
          width: PANEL_W,
          height: panelH,
          pointerEvents: "auto",
          background: "rgba(30, 41, 59, 0.62)",
          WebkitBackdropFilter: "blur(16px) saturate(1.3)",
          backdropFilter: "blur(16px) saturate(1.3)",
        }}
      >
        {focus ? (
          <button
            onClick={() => setPath((p) => p.slice(0, -1))}
            className="absolute left-2 right-2 top-1.5 flex h-[20px] items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-white/85"
          >
            <ArrowLeft className="h-3 w-3" /> {heading}
          </button>
        ) : (
          <div className="absolute left-3 right-2 top-1.5 h-[20px] text-[11px] font-semibold uppercase tracking-wide text-white/70">
            {heading}
          </div>
        )}

        {nodes.map((node, i) => {
          const Icon = node.icon;
          const hasKids = !!(node.children && node.children.length);
          const busy = busyId === node.id;
          return (
            <button
              key={node.id}
              onClick={() => pick(node)}
              className="cn-fade glass-gloss flex items-center gap-2 rounded-xl border border-white/70 pl-1.5 pr-2.5 text-left transition-transform hover:scale-[1.03]"
              style={{
                position: "absolute", // beat .glass-gloss's position:relative
                left: PAD,
                top: PAD + HEADER + i * step,
                width: rowW,
                height: rowH,
                animationDelay: `${i * 26}ms`,
                background: "rgba(232, 251, 247, 0.96)",
              }}
            >
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-[color:rgb(var(--glass-ink))]"
                style={{ background: "rgb(var(--glass-tint) / 0.2)" }}
              >
                {busy ? <Loader2 className="h-[15px] w-[15px] animate-spin" /> : <Icon className="h-[15px] w-[15px]" />}
              </span>
              <span className="flex-1 truncate text-[13px] font-medium text-slate-800">{node.label}</span>
              {hasKids && <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />}
            </button>
          );
        })}

        {err && (
          <div className="absolute inset-x-2 bottom-1.5 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700">
            {err}
          </div>
        )}
      </div>
    </div>
  );
}
