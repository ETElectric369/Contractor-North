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

/**
 * A glass MindMeister-style bloom: curved branches grow from an anchor point
 * into individually-translucent glass nodes floating over the page. Drills into
 * hub nodes in place, runs conversion actions, or navigates. Used by the left
 * dock (`direction="right"`), the mobile bottom dock (`direction="up"`), and the
 * per-entity convert/map buttons.
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
  const MAX_GAP = 42;
  const NODE_W = 168;

  // Compress the gap so the whole column always fits the viewport height (no
  // nodes marching off the top/bottom on short or zoomed screens).
  const count = nodes.length;
  const gap = count > 1 ? Math.min(MAX_GAP, (vh - 160) / (count - 1)) : 0;
  const span = (count - 1) * gap;
  // Fan right of the anchor, unless it sits too close to the right edge — then
  // fan left so the column stays attached to its button.
  const fitsRight = anchor.x + 60 + NODE_W <= vw - 8;
  const colLeft = fitsRight ? anchor.x + 60 : clamp(anchor.x - 60 - NODE_W, 8, vw - NODE_W - 8);

  const placed = nodes.map((node, i) => {
    if (direction === "up") {
      const left = clamp(anchor.x - NODE_W / 2, 8, vw - NODE_W - 8);
      let firstCy = anchor.y - 74;
      if (firstCy - span < 80) firstCy = 80 + span; // keep the topmost node on screen
      const cy = firstCy - i * gap;
      return { n: node, left, cy, bx: left + 18, by: cy };
    }
    const startC = clamp(anchor.y - span / 2, 80, vh - 80 - span);
    const cy = startC + i * gap;
    return { n: node, left: colLeft, cy, bx: fitsRight ? colLeft : colLeft + NODE_W, by: cy };
  });

  function branch(bx: number, by: number) {
    if (direction === "up") {
      const my = anchor.y + (by - anchor.y) * 0.5;
      return `M${anchor.x} ${anchor.y} C ${anchor.x} ${my}, ${bx} ${my}, ${bx} ${by}`;
    }
    const mx = anchor.x + (bx - anchor.x) * 0.5;
    return `M${anchor.x} ${anchor.y} C ${mx} ${anchor.y}, ${mx} ${by}, ${bx} ${by}`;
  }

  const backLeft = clamp(anchor.x - 20, 8, vw - 200);
  const backTop = direction === "up" ? clamp(anchor.y - 36, 8, vh - 40) : anchor.y - 13;

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-label={`${heading} menu`}>
      <button className="absolute inset-0 cursor-default" aria-label="Close menu" onClick={onClose} />
      <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
        {placed.map((p) => (
          <path
            key={p.n.id}
            d={branch(p.bx, p.by)}
            fill="none"
            stroke="rgb(var(--glass-tint))"
            strokeWidth="1.5"
            strokeLinecap="round"
            opacity="0.85"
          />
        ))}
      </svg>

      <div className="absolute inset-0" style={{ pointerEvents: "none" }}>
        {focus && (
          <button
            onClick={() => setPath((p) => p.slice(0, -1))}
            onMouseEnter={onEnter}
            onMouseLeave={onLeave}
            className="glass glass-gloss absolute flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-medium text-slate-700"
            style={{ left: backLeft, top: backTop, pointerEvents: "auto" }}
          >
            <ArrowLeft className="h-3.5 w-3.5" /> {heading}
          </button>
        )}
        {placed.map((p, i) => {
          const Icon = p.n.icon;
          const hasKids = !!(p.n.children && p.n.children.length);
          const busy = busyId === p.n.id;
          return (
            <button
              key={p.n.id}
              onClick={() => pick(p.n)}
              onMouseEnter={onEnter}
              onMouseLeave={onLeave}
              className="cn-bloom-node glass-gloss absolute flex items-center gap-2 rounded-xl border border-white/70 py-1.5 pl-1.5 pr-3 text-left shadow-sm transition-transform hover:scale-[1.04]"
              style={{
                left: p.left,
                top: p.cy,
                transform: "translateY(-50%)",
                pointerEvents: "auto",
                animationDelay: `${i * 30}ms`,
                minWidth: 140,
                // Translucent but tinted so the whole tile is a solid hit target
                // that contrasts the page-glass — no clicking "through" it.
                background: "rgba(225, 245, 242, 0.9)",
                WebkitBackdropFilter: "blur(10px) saturate(1.4)",
                backdropFilter: "blur(10px) saturate(1.4)",
              }}
            >
              <span
                className="cn-cut flex h-7 w-7 shrink-0 items-center justify-center text-[color:rgb(var(--glass-ink))]"
                style={{ background: "rgb(var(--glass-tint) / 0.18)" }}
              >
                {busy ? <Loader2 className="h-[17px] w-[17px] animate-spin" /> : <Icon className="h-[17px] w-[17px]" />}
              </span>
              <span className="whitespace-nowrap text-[13px] font-medium text-slate-800">{p.n.label}</span>
              {hasKids && <ChevronRight className="ml-auto h-4 w-4 text-slate-500" />}
            </button>
          );
        })}
        {err && (
          <div
            className="absolute rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 shadow"
            style={{ left: clamp(anchor.x, 8, vw - 220), top: clamp(anchor.y + 12, 8, vh - 48), pointerEvents: "auto" }}
          >
            {err}
          </div>
        )}
      </div>
    </div>
  );
}
