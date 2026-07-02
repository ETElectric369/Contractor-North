"use client";

import { Children, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal, Loader2, Trash2 } from "lucide-react";
import type { NavTree, TreeNode } from "@/lib/nav-tree";
import { resolveNavTree, type BloomNode } from "./app-shell/glass-bloom";
import { executeAction } from "@/lib/actions/execute";

/** The one menu-row style — modal-owning items composed in as `children`
 *  (Credit / Edit etc. with `menuItem`) use it too, so every row in the panel
 *  looks identical. Mirrors the jobs Manage menu's MANAGE_ROW_CLS. */
export const ACTIONS_ROW_CLS =
  "relative z-10 flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-slate-700 hover:bg-[rgb(var(--glass-tint))]/15 disabled:opacity-50";

const DANGER_ROW_CLS =
  "relative z-10 flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm font-medium text-red-600 hover:bg-red-50/60 disabled:opacity-50";

const DIVIDER = <div className="relative z-10 my-1 border-t border-white/50" />;

/**
 * The "⋯" actions menu — THE seek door on every detail page: rare deliberate
 * verbs (conversions, Delete) plus cross-links not already visible on the page.
 * Always the LAST control of the header actions row, always labeled "Actions".
 * Descriptor verbs run via executeAction; `run` nodes execute a bound server
 * action then navigate (hrefPrefix + returned id, or the node's `href`); links
 * navigate. Danger nodes render red and last behind a divider, confirm-guarded.
 *
 * THE MODAL RULE: modal-owning `children` render their Modal IN-PLACE (not
 * portaled), so they must stay MOUNTED while their modal is open. The panel
 * therefore never closes itself while <body> has `modal-open` (Modal always
 * sets it): the outside-click and Escape close handlers bail — including the
 * click on a modal's own backdrop — and the z-[120] modal overlay simply covers
 * the z-[90] panel. Do NOT "fix" this with conditional rendering or
 * display:none; both silently destroy a half-filled form mid-edit.
 */
export function SectionActionsMenu({
  tree,
  isStaff = true,
  label = "Actions",
  children,
}: {
  tree: NavTree;
  isStaff?: boolean;
  label?: string;
  /** Modal-owning menu items (components with a `menuItem` row trigger). */
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const { nodes } = resolveNavTree(tree);
  // resolveNavTree maps icon strings to components but doesn't carry the
  // danger/confirmText fields — recover them from the source tree by id.
  const rawById = useMemo(() => {
    const m = new Map<string, TreeNode>();
    tree.nodes.forEach((n) => m.set(n.id, n));
    return m;
  }, [tree]);
  const shown = nodes.filter((n) => !n.staffOnly || isStaff);
  const main = shown.filter((n) => !rawById.get(n.id)?.danger);
  const danger = shown.filter((n) => rawById.get(n.id)?.danger);
  // Conditional children (`{flag && <Item/>}`) leave `false` in the slot —
  // toArray strips those so an empty slot doesn't render a stray divider.
  const hasChildren = Children.toArray(children).length > 0;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const modalOpen = () => document.body.classList.contains("modal-open");
    const onDoc = (e: MouseEvent) => {
      // A child item's Modal is open (in-place, above us at z-[120]) — never
      // close underneath it; unmounting the panel would kill the modal mid-edit.
      if (modalOpen()) return;
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (modalOpen()) return; // Escape belongs to the open modal, not the panel
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function pick(n: BloomNode) {
    setErr(null);
    const confirmText = rawById.get(n.id)?.confirmText;
    if (confirmText && !confirm(confirmText)) return;
    if (n.action) {
      setBusy(n.id);
      try {
        const res = await executeAction(n.action.name, n.action.input ?? {});
        setBusy(null);
        if (res.ok) {
          setOpen(false);
          if (n.href) router.push(n.href);
          else router.refresh();
          return;
        }
        setErr(res.error ?? "Couldn't do that.");
      } catch {
        setBusy(null);
        setErr("Couldn't do that.");
      }
      return;
    }
    if (n.run) {
      setBusy(n.id);
      try {
        const res = await n.run();
        setBusy(null);
        if (res.ok) {
          setOpen(false);
          if (res.id && n.hrefPrefix) router.push(n.hrefPrefix + res.id);
          else if (n.href) router.push(n.href);
          else router.refresh();
          return;
        }
        setErr(res.error ?? "Couldn't do that.");
      } catch {
        setBusy(null);
        setErr("Couldn't do that.");
      }
      return;
    }
    if (n.href) {
      setOpen(false);
      router.push(n.href);
    }
  }

  function row(n: BloomNode, isDanger: boolean) {
    const Icon = isDanger ? Trash2 : n.icon;
    return (
      <button
        key={n.id}
        onClick={() => pick(n)}
        disabled={busy !== null}
        className={isDanger ? DANGER_ROW_CLS : ACTIONS_ROW_CLS}
      >
        {busy === n.id ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        ) : (
          <Icon className={`h-4 w-4 shrink-0 ${isDanger ? "" : "text-[rgb(var(--glass-ink))]"}`} />
        )}
        {n.label}
      </button>
    );
  }

  // Nothing this viewer can do here (e.g. every node is staffOnly and the
  // viewer isn't) — no door at all beats an empty one.
  if (!hasChildren && shown.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-600 hover:bg-slate-50"
      >
        <MoreHorizontal className="h-5 w-5" />
      </button>
      {open && (
        // position set inline because .glass-gloss forces position:relative, which
        // would override a Tailwind `absolute`. Right-anchored: the ⋯ is standardized
        // as the LAST (rightmost) control of every detail header's actions row.
        <div
          style={{ position: "absolute", right: 0, top: "calc(100% + 0.25rem)" }}
          className="glass glass-gloss glass-menu z-[90] w-56 overflow-hidden rounded-lg py-1.5 shadow-xl"
        >
          {children}
          {hasChildren && main.length > 0 && DIVIDER}
          {main.map((n) => row(n, false))}
          {danger.length > 0 && (
            <>
              {(hasChildren || main.length > 0) && DIVIDER}
              {danger.map((n) => row(n, true))}
            </>
          )}
          {err && <div className="relative z-10 px-4 py-1.5 text-xs text-red-600">{err}</div>}
        </div>
      )}
    </div>
  );
}
