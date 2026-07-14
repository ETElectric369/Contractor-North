"use client";

import {
  Home, Sun, Briefcase, CalendarDays, Users, Receipt, Settings, Sparkles, Wand2,
  Clock, ListChecks, List, Play, FileText, Columns3, ClipboardCheck, Map as MapIcon,
  Mail, Wallet, Tags, Boxes, Calculator, Stamp, HardHat, BookOpen, FileSpreadsheet,
  Wrench, CheckCircle2, Circle,
  type LucideIcon,
} from "lucide-react";
import type { NavTree, TreeNode } from "@/lib/nav-tree";

/** A node in a glass bloom. `children` drills in place; `run` performs a server
 *  action then navigates to hrefPrefix + the returned id; `action` runs a registry
 *  action by name (then href/refresh); `href` navigates. */
export type BloomNode = {
  id: string;
  label: string;
  icon: LucideIcon;
  href?: string;
  run?: () => Promise<{ ok: boolean; id?: string; error?: string }>;
  hrefPrefix?: string;
  action?: { name: string; input?: Record<string, unknown> };
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
      action: n.action,
      staffOnly: n.staffOnly,
      children: n.children ? conv(n.children) : undefined,
    }));
  return { title: tree.center.label, nodes: conv(tree.nodes) };
}
