"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ChevronDown,
  ChevronsLeftRight,
  ChevronsRightLeft,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { SITE_FONTS, siteFontKey, type SiteFontKey } from "./site-fonts";
import { updateVersionFields } from "./live-edit-actions";

/**
 * EDIT IT ON THE PAGE, v4 — AN OLD-SCHOOL ICON TOOLBAR (Erik: "i want icons like an old school
 * editor, easy af" / "this layout thing is throwing everything off and changing things i dont
 * want changed and shouldnt be there period").
 *
 * On top of v3's laws (no save game: everything acts instantly and autosaves; nothing silent:
 * a named undo trail survives reloads):
 *   · NO LAYOUT SWITCHER IN THE TOOLBAR. A whole-banner restructure has no business sitting
 *     next to per-text tools where a stray click rearranges the page — layout changes belong
 *     to the designer conversation in the studio.
 *   · ICONS, GROUPED LIKE 1997: size steppers, a font menu that shows each face in itself,
 *     alignment, text zoom, width, one big Undo.
 *   · RESIZE IS TWO-DIMENSIONAL: the right-edge handle (and ⌥ ←/→) sets width; the corner
 *     handle (and ⌥ ↑/↓) zooms the text ("the resize works horizontally but not vertically").
 *   · AN EDIT NEVER DIES UNCOMMITTED: leaving the window (clicking into the studio panel)
 *     commits the text edit and flushes it immediately ("the text edits didnt save" — element
 *     blur never fires when the whole iframe loses focus).
 */

type FieldKey = "splash_headline" | "splash_tagline" | "service_area" | "estimate_cta_label" | "__brand";

const FIELD_LABEL: Record<FieldKey, string> = {
  splash_headline: "Headline",
  splash_tagline: "Tagline",
  service_area: "Service area",
  estimate_cta_label: "Estimate button",
  __brand: "Business name",
};
const PATCH_LABEL: Record<string, string> = {
  splash_headline: "Headline text",
  splash_tagline: "Tagline text",
  service_area: "Service area text",
  estimate_cta_label: "Button wording",
  splash_headline_size: "Headline size",
  site_font: "Heading font",
  brand_font: "Name font",
  hero_align: "Alignment",
  hero_style: "Banner layout",
  hero_dx: "Moved across",
  hero_dy: "Moved down",
  hero_w: "Box width",
  hero_scale: "Text zoom",
  spread_area_dx: "Area piece across",
  spread_area_dy: "Area piece down",
  spread_area_scale: "Area piece zoom",
  spread_head_dx: "Headline piece across",
  spread_head_dy: "Headline piece down",
  spread_head_w: "Headline piece width",
  spread_head_scale: "Headline piece zoom",
  spread_tag_dx: "Tagline piece across",
  spread_tag_dy: "Tagline piece down",
  spread_tag_w: "Tagline piece width",
  spread_tag_scale: "Tagline piece zoom",
};

const TEXT_FIELDS: FieldKey[] = ["splash_headline", "splash_tagline", "service_area", "estimate_cta_label"];
const FONT_KEYS = Object.keys(SITE_FONTS) as SiteFontKey[];
const FONT_NAME: Record<SiteFontKey, string> = {
  default: "Standard",
  serif: "Serif",
  grotesk: "Grotesk",
  soft: "Rounded",
  condensed: "Condensed",
};
const SIZES = ["s", "m", "l"] as const;
// Mirrors HEAD_SIZE in org-site.tsx — the live class swap for headline size.
const HEAD_SIZE_CLS: Record<string, string[]> = {
  s: ["text-2xl", "sm:text-3xl"],
  m: ["text-3xl", "sm:text-4xl"],
  l: ["text-4xl", "sm:text-5xl"],
};

/** The movable/resizable units. Whichever one contains the selected text is what drag, the
 *  arrow keys, and the handles act on — the classic box OR a Corners piece. */
const UNITS: { sel: string; dx: string; dy: string; w: string | null; sc: string }[] = [
  { sel: "[data-hero-text]", dx: "hero_dx", dy: "hero_dy", w: "hero_w", sc: "hero_scale" },
  { sel: '[data-spread-piece="area"]', dx: "spread_area_dx", dy: "spread_area_dy", w: null, sc: "spread_area_scale" },
  { sel: '[data-spread-piece="headline"]', dx: "spread_head_dx", dy: "spread_head_dy", w: "spread_head_w", sc: "spread_head_scale" },
  { sel: '[data-spread-piece="tagline"]', dx: "spread_tag_dx", dy: "spread_tag_dy", w: "spread_tag_w", sc: "spread_tag_scale" },
];
type Unit = { el: HTMLElement; dx: string; dy: string; w: string | null; sc: string };

const clampNudge = (n: number) => Math.min(40, Math.max(-40, Math.round(n)));
const clampW = (n: number) => Math.min(100, Math.max(30, Math.round(n)));
const clampZoom = (n: number) => Math.min(200, Math.max(50, Math.round(n)));
// Fields whose change restructures the banner server-side: save, then repaint via reload.
// hero_style is no longer settable HERE (the layout switcher left the toolbar), but old trail
// entries may still carry it — undo must keep taking the reload path.
const STRUCTURAL = new Set(["hero_style", "hero_align"]);

type TrailEntry = { k: string; prev: unknown };

export function LiveEditor({
  versionId,
  initial,
}: {
  versionId: string;
  initial: {
    splash_headline_size: string;
    hero_align: string;
    hero_style: string;
    site_font: string;
    brand_font: string;
    hero_dx: number;
    hero_dy: number;
    hero_w: number;
    hero_scale: number;
    spread_area_scale: number;
    spread_head_scale: number;
    spread_tag_scale: number;
    spread_area_dx: number;
    spread_area_dy: number;
    spread_head_dx: number;
    spread_head_dy: number;
    spread_head_w: number;
    spread_tag_dx: number;
    spread_tag_dy: number;
    spread_tag_w: number;
  };
}) {
  const [selected, setSelected] = useState<FieldKey | null>(null);
  const [editingText, setEditingText] = useState(false);
  const [trail, setTrail] = useState<TrailEntry[]>([]);
  const [showTrail, setShowTrail] = useState(false);
  const [fontMenu, setFontMenu] = useState<null | "site_font" | "brand_font">(null);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "rearranging" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef({ selected, editingText });
  stateRef.current = { selected, editingText };
  // Current value of every field (seeded from the draft, updated on each edit) — the single
  // truth the painters and undo read. Autosave means "pending" and "current" are the same idea.
  const valuesRef = useRef<Record<string, unknown>>({ ...initial });
  const pendingRef = useRef<Record<string, unknown>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const trailRef = useRef<TrailEntry[]>([]);
  const unitRef = useRef<Unit | null>(null);
  const editingRef = useRef<{ el: HTMLElement; f: FieldKey; before: string } | null>(null);
  const dragRef = useRef<{ mode: "move" | "width" | "zoom"; startX: number; startY: number; dx0: number; dy0: number; w0: number; s0: number } | null>(null);

  const trailKey = `cn-live-trail:${versionId}`;
  const cur = <T,>(k: string): T => valuesRef.current[k] as T;
  const num = (k: string) => Number(cur<number>(k)) || 0;

  // ── AUTOSAVE — the save game is gone; edits land on the draft on their own ───────────────
  function persistTrail(next: TrailEntry[]) {
    trailRef.current = next;
    setTrail(next);
    try {
      sessionStorage.setItem(trailKey, JSON.stringify(next));
    } catch {
      /* private mode */
    }
  }
  function recordPrev(k: string, prev: unknown) {
    if (trailRef.current.some((t) => t.k === k)) return;
    persistTrail([...trailRef.current, { k, prev }]);
  }
  async function flush(): Promise<boolean> {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const snap = pendingRef.current;
    if (Object.keys(snap).length === 0) return true;
    pendingRef.current = {};
    setSaveState((s) => (s === "rearranging" ? s : "saving"));
    const r = await updateVersionFields(versionId, snap);
    if (!r.ok) {
      // Put the unsaved values back so Retry (or the next edit) carries them.
      pendingRef.current = { ...snap, ...pendingRef.current };
      setSaveState("error");
      setError(r.error);
      return false;
    }
    setError(null);
    setSaveState((s) => (s === "rearranging" ? s : "saved"));
    try {
      window.parent?.postMessage({ type: "cn-live-saved" }, "*");
    } catch {
      /* not framed */
    }
    return true;
  }
  function scheduleSave() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), 700);
  }

  // ── LIVE PAINTERS ────────────────────────────────────────────────────────────────────────
  function paintUnitByKey(k: string) {
    const u = UNITS.find((x) => x.dx === k || x.dy === k || x.w === k || x.sc === k);
    if (!u) return;
    const el = document.querySelector<HTMLElement>(u.sel);
    if (!el) return;
    const dx = num(u.dx);
    const dy = num(u.dy);
    const w = u.w ? num(u.w) : 0;
    const sc = num(u.sc);
    el.style.transform = [dx || dy ? `translate(${dx}%, ${dy}%)` : "", sc ? `scale(${sc / 100})` : ""].filter(Boolean).join(" ");
    if (u.w) el.style.maxWidth = w ? `${w}%` : "";
  }
  function paintHeadlineSize(size: string) {
    const h1 = document.querySelector<HTMLElement>('[data-e="splash_headline"]');
    if (!h1) return;
    for (const cls of Object.values(HEAD_SIZE_CLS).flat()) h1.classList.remove(cls);
    for (const cls of HEAD_SIZE_CLS[size] ?? HEAD_SIZE_CLS.l) h1.classList.add(cls);
  }
  function loadFontCss(key: SiteFontKey) {
    const preset = SITE_FONTS[key];
    if (preset && !document.querySelector(`link[href="${preset.css}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = preset.css;
      document.head.appendChild(link);
    }
  }
  function paintFont(kind: "site_font" | "brand_font", key: SiteFontKey) {
    loadFontCss(key);
    const preset = SITE_FONTS[key];
    const family = preset ? preset.family : "";
    const targets =
      kind === "brand_font"
        ? document.querySelectorAll<HTMLElement>(".site-brand")
        : document.querySelectorAll<HTMLElement>(".site-shell h1, .site-shell h2, .site-shell h3");
    targets.forEach((el) => (el.style.fontFamily = family));
  }
  function paint(k: string) {
    paintUnitByKey(k);
    if (k === "splash_headline_size") paintHeadlineSize(String(cur(k)));
    if (k === "site_font" || k === "brand_font") paintFont(k, siteFontKey(cur(k)));
    if (TEXT_FIELDS.includes(k as FieldKey)) {
      const el = document.querySelector<HTMLElement>(`[data-e="${k}"]`);
      if (el && el.innerText !== String(cur(k))) el.innerText = String(cur(k));
    }
  }

  /** The one entry point for every change: record undo, remember, paint, save. A structural
   *  change (alignment) saves NOW and repaints via reload — everything else is instant. */
  function setValue(k: string, v: unknown, opts?: { record?: boolean }) {
    if (opts?.record !== false) recordPrev(k, valuesRef.current[k]);
    valuesRef.current[k] = v;
    pendingRef.current[k] = v;
    if (STRUCTURAL.has(k)) {
      setSaveState("rearranging");
      void flush().then((ok) => {
        if (ok) window.location.reload();
        else setSaveState("error");
      });
      return;
    }
    paint(k);
    scheduleSave();
  }
  /** End the active text-edit session, committing what was typed. Runs on element blur AND on
   *  window blur — clicking into the studio panel must never lose an edit. */
  function endTextEdit(flushNow: boolean) {
    const sess = editingRef.current;
    if (!sess) return;
    editingRef.current = null;
    sess.el.removeAttribute("contenteditable");
    setEditingText(false);
    const raw = sess.el.innerText;
    // A headline may carry DELIBERATE line breaks (Erik: "id like to see it like this and it
    // keeps resetting") — normalize instead of flattening: single \n breaks, no hugging
    // spaces. The <title>/SEO boundary flattens for itself server-side.
    const clean =
      sess.f === "splash_headline"
        ? raw.replace(/\r\n?/g, "\n").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{2,}/g, "\n").trim()
        : raw.trim();
    if (clean !== raw) sess.el.innerText = clean;
    if (clean !== sess.before) {
      recordPrev(sess.f, sess.before);
      setValue(sess.f, clean, { record: false });
    }
    if (flushNow) void flush();
  }
  function undo(k: string) {
    const entry = trailRef.current.find((t) => t.k === k);
    if (!entry) return;
    persistTrail(trailRef.current.filter((t) => t.k !== k));
    setValue(k, entry.prev, { record: false });
  }
  function undoLast() {
    const last = trailRef.current[trailRef.current.length - 1];
    if (last) undo(last.k);
  }

  // ── WIRING: click select, double-click edit, drag move, handles, arrows ──────────────────
  useEffect(() => {
    // The undo trail survives the alignment-change reload.
    try {
      const raw = sessionStorage.getItem(trailKey);
      if (raw) {
        const parsed = JSON.parse(raw) as TrailEntry[];
        if (Array.isArray(parsed)) {
          trailRef.current = parsed.filter((t) => t && typeof t.k === "string");
          setTrail(trailRef.current);
        }
      }
    } catch {
      /* fresh start */
    }

    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-e]"));
    const unitFor = (el: HTMLElement): Unit | null => {
      for (const u of UNITS) {
        const host = document.querySelector<HTMLElement>(u.sel);
        if (host && host.contains(el)) return { el: host, dx: u.dx, dy: u.dy, w: u.w, sc: u.sc };
      }
      return null;
    };
    const clearSel = () => {
      els.forEach((el) => el.classList.remove("cn-live-selected"));
      unitRef.current?.el.classList.remove("cn-live-box");
      document.getElementById("cn-zoom-handle")?.remove();
      document.getElementById("cn-width-handle")?.remove();
      unitRef.current = null;
    };
    const select = (el: HTMLElement) => {
      clearSel();
      el.classList.add("cn-live-selected");
      setSelected(el.dataset.e as FieldKey);
      setEditingText(false);
      setFontMenu(null);
      const u = unitFor(el);
      unitRef.current = u;
      if (u) {
        u.el.classList.add("cn-live-box");
        u.el.style.position = u.el.style.position || "relative";
        const zoomHandle = document.createElement("div");
        zoomHandle.id = "cn-zoom-handle";
        zoomHandle.title = "Drag to make the text bigger or smaller";
        u.el.appendChild(zoomHandle);
        if (u.w) {
          const widthHandle = document.createElement("div");
          widthHandle.id = "cn-width-handle";
          widthHandle.title = "Drag to make the box wider or narrower";
          u.el.appendChild(widthHandle);
        }
      }
    };
    const onClick = (e: Event) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-e]");
      if (!el) return;
      // Mid-edit clicks position the caret — never re-delegated to selection (cn-v782).
      if (el.isContentEditable) return;
      e.preventDefault();
      e.stopPropagation();
      select(el);
    };
    const onDblClick = (e: Event) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-e]");
      if (!el) return;
      const f = el.dataset.e as FieldKey;
      if (!TEXT_FIELDS.includes(f)) return;
      e.preventDefault();
      el.setAttribute("contenteditable", "plaintext-only");
      el.focus();
      setEditingText(true);
      editingRef.current = { el, f, before: el.innerText };
      const onBlur = () => {
        el.removeEventListener("blur", onBlur);
        endTextEdit(false);
      };
      el.addEventListener("blur", onBlur);
    };
    // DRAG TO MOVE / WIDTH / ZOOM — on whichever unit (box or corner piece) holds the selection.
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      const active = document.activeElement as HTMLElement | null;
      if (stateRef.current.editingText || (active && active.isContentEditable) || t.isContentEditable) return;
      const u = unitRef.current;
      if (!u) return;
      if (t.id === "cn-width-handle" && u.w) {
        const parentW = u.el.parentElement?.getBoundingClientRect().width || u.el.getBoundingClientRect().width;
        const w0 = num(u.w) || Math.round((u.el.getBoundingClientRect().width / parentW) * 100);
        dragRef.current = { mode: "width", startX: e.clientX, startY: e.clientY, dx0: 0, dy0: 0, w0, s0: 0 };
        e.preventDefault();
        return;
      }
      if (t.id === "cn-zoom-handle") {
        dragRef.current = { mode: "zoom", startX: e.clientX, startY: e.clientY, dx0: 0, dy0: 0, w0: 0, s0: num(u.sc) || 100 };
        e.preventDefault();
        return;
      }
      if (!u.el.classList.contains("cn-live-box") || !u.el.contains(t)) return;
      dragRef.current = { mode: "move", startX: e.clientX, startY: e.clientY, dx0: num(u.dx), dy0: num(u.dy), w0: 0, s0: 0 };
      e.preventDefault();
    };
    const onPointerMove = (e: PointerEvent) => {
      const d = dragRef.current;
      const u = unitRef.current;
      if (!d || !u) return;
      const r = u.el.getBoundingClientRect();
      if (d.mode === "move") {
        // translate % is relative to the unit's own size — convert pixel deltas accordingly.
        const dx = clampNudge(d.dx0 + ((e.clientX - d.startX) / r.width) * 100);
        const dy = clampNudge(d.dy0 + ((e.clientY - d.startY) / r.height) * 100);
        const sc = num(u.sc);
        u.el.style.transform = [`translate(${dx}%, ${dy}%)`, sc ? `scale(${sc / 100})` : ""].filter(Boolean).join(" ");
        u.el.dataset.pendingDx = String(dx);
        u.el.dataset.pendingDy = String(dy);
      } else if (d.mode === "width") {
        const parentW = u.el.parentElement?.getBoundingClientRect().width || r.width;
        const w = clampW(d.w0 + ((e.clientX - d.startX) / parentW) * 100);
        u.el.style.maxWidth = `${w}%`;
        u.el.dataset.pendingW = String(w);
      } else {
        // Corner zoom: dragging away from the box grows the text, toward it shrinks — the
        // average of both axes, so a diagonal pull feels like grabbing a photo corner.
        const delta = (((e.clientX - d.startX) / r.width + (e.clientY - d.startY) / r.height) / 2) * 100;
        const sc = clampZoom(d.s0 + delta);
        const dx = num(u.dx);
        const dy = num(u.dy);
        u.el.style.transform = [dx || dy ? `translate(${dx}%, ${dy}%)` : "", `scale(${sc / 100})`].filter(Boolean).join(" ");
        u.el.dataset.pendingS = String(sc);
      }
    };
    const onPointerUp = () => {
      const d = dragRef.current;
      const u = unitRef.current;
      if (!d) return;
      dragRef.current = null;
      if (!u) return;
      if (d.mode === "move") {
        if (u.el.dataset.pendingDx) setValue(u.dx, Number(u.el.dataset.pendingDx));
        if (u.el.dataset.pendingDy) setValue(u.dy, Number(u.el.dataset.pendingDy));
      } else if (d.mode === "width" && u.w && u.el.dataset.pendingW) {
        setValue(u.w, Number(u.el.dataset.pendingW));
      } else if (d.mode === "zoom" && u.el.dataset.pendingS) {
        setValue(u.sc, Number(u.el.dataset.pendingS));
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const { selected: f, editingText: editing } = stateRef.current;
      // Trust the DOM, not the bookkeeping: focus in ANY contentEditable → keys are the caret's.
      const active = document.activeElement as HTMLElement | null;
      if (!f || editing || (active && active.isContentEditable)) return;
      if (e.key === "Escape") {
        clearSel();
        setSelected(null);
        setFontMenu(null);
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      const u = unitRef.current;
      if (!u) return;
      e.preventDefault();
      const step = e.shiftKey ? 8 : 2;
      if (e.altKey) {
        // ⌥ + ←/→ = width, ⌥ + ↑/↓ = text zoom ("all the resizing arrows as well").
        if (u.w && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          const parentW = u.el.parentElement?.getBoundingClientRect().width || 1;
          const now = num(u.w) || Math.round((u.el.getBoundingClientRect().width / parentW) * 100);
          setValue(u.w, clampW(now + (e.key === "ArrowRight" ? step : -step)));
        }
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          const now = num(u.sc) || 100;
          setValue(u.sc, clampZoom(now + (e.key === "ArrowUp" ? step * 2 : -step * 2)));
        }
        return;
      }
      if (e.key === "ArrowLeft") setValue(u.dx, clampNudge(num(u.dx) - step));
      if (e.key === "ArrowRight") setValue(u.dx, clampNudge(num(u.dx) + step));
      if (e.key === "ArrowUp") setValue(u.dy, clampNudge(num(u.dy) - step));
      if (e.key === "ArrowDown") setValue(u.dy, clampNudge(num(u.dy) + step));
    };
    const onWindowBlur = () => {
      // Clicking into the studio panel (or any other window) must commit and land the edit —
      // element blur does NOT fire when the whole iframe loses focus ("text edits didnt save").
      endTextEdit(true);
      void flush();
    };
    const onPageHide = () => {
      endTextEdit(false);
      void flush();
    };
    els.forEach((el) => {
      el.addEventListener("click", onClick);
      el.addEventListener("dblclick", onDblClick);
    });
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      els.forEach((el) => {
        el.removeEventListener("click", onClick);
        el.removeEventListener("dblclick", onDblClick);
      });
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("pagehide", onPageHide);
      clearSel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const u = unitRef.current;
  const btn = "inline-flex h-8 min-w-8 items-center justify-center rounded px-1.5 text-white/85 hover:bg-white/15 disabled:opacity-30";
  const btnOn = "inline-flex h-8 min-w-8 items-center justify-center rounded px-1.5 bg-white text-slate-900";
  const group = "flex items-center gap-0.5 border-l border-white/15 pl-2";
  const stepSize = (dir: 1 | -1) => {
    const order = SIZES as readonly string[];
    const now = order.indexOf(String(cur("splash_headline_size")));
    const next = order[Math.min(order.length - 1, Math.max(0, (now === -1 ? 2 : now) + dir))];
    if (next && next !== String(cur("splash_headline_size"))) setValue("splash_headline_size", next);
  };
  const zoomBy = (delta: number) => {
    if (!u) return;
    setValue(u.sc, clampZoom((num(u.sc) || 100) + delta));
  };
  const widthBy = (delta: number) => {
    if (!u?.w) return;
    const parentW = u.el.parentElement?.getBoundingClientRect().width || 1;
    const now = num(u.w) || Math.round((u.el.getBoundingClientRect().width / parentW) * 100);
    setValue(u.w, clampW(now + delta));
  };
  const fontKind: "site_font" | "brand_font" = selected === "__brand" ? "brand_font" : "site_font";

  return (
    <>
      <style>{`
        .cn-live-selected { outline: 2px dashed #f59e0b; outline-offset: 4px; }
        .cn-live-box { outline: 2px solid #f59e0b; outline-offset: 8px; cursor: move; }
        [data-e] { cursor: pointer; }
        #cn-zoom-handle { position: absolute; right: -10px; bottom: -10px; width: 18px; height: 18px; border-radius: 50%; background: #f59e0b; border: 2px solid white; cursor: nwse-resize; z-index: 55; }
        #cn-width-handle { position: absolute; right: -10px; top: 50%; margin-top: -9px; width: 18px; height: 18px; border-radius: 4px; background: #0ea5e9; border: 2px solid white; cursor: ew-resize; z-index: 55; }
      `}</style>
      <div className="fixed inset-x-0 top-0 z-[60] flex flex-wrap items-center gap-x-2 gap-y-2 bg-slate-900/95 px-4 py-2 text-sm text-white shadow-lg backdrop-blur">
        {!selected && <span className="text-white/70">Click any text to work on it · double-click to retype it</span>}
        {selected && (
          <>
            <span className="rounded bg-amber-500/90 px-2 py-0.5 text-xs font-bold uppercase tracking-wide">{FIELD_LABEL[selected]}</span>
            {selected === "splash_headline" && (
              <span className={group}>
                <button type="button" title="Smaller headline" className={btn} onClick={() => stepSize(-1)}>
                  <span className="text-xs font-bold">A−</span>
                </button>
                <button type="button" title="Bigger headline" className={btn} onClick={() => stepSize(1)}>
                  <span className="text-base font-bold">A+</span>
                </button>
              </span>
            )}
            <span className={`${group} relative`}>
              <button
                type="button"
                title="Font"
                className={fontMenu ? btnOn : btn}
                onClick={() => {
                  FONT_KEYS.forEach(loadFontCss);
                  setFontMenu((m) => (m ? null : fontKind));
                }}
              >
                <span className="text-sm font-semibold">Aa</span>
                <ChevronDown className="ml-0.5 h-3 w-3" />
              </button>
              {fontMenu && (
                <span className="absolute left-0 top-9 z-[70] flex w-40 flex-col overflow-hidden rounded-lg bg-slate-800 py-1 shadow-xl ring-1 ring-white/15">
                  {FONT_KEYS.map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => {
                        setValue(fontMenu, k);
                        setFontMenu(null);
                      }}
                      className={`px-3 py-1.5 text-left text-base hover:bg-white/10 ${siteFontKey(cur(fontMenu)) === k ? "text-amber-300" : "text-white"}`}
                      style={{ fontFamily: SITE_FONTS[k]?.family || undefined }}
                    >
                      {FONT_NAME[k]}
                    </button>
                  ))}
                </span>
              )}
            </span>
            {u && u.dx === "hero_dx" && (
              <span className={group}>
                {(
                  [
                    ["left", AlignLeft, "Align left"],
                    ["center", AlignCenter, "Align middle"],
                    ["right", AlignRight, "Align right"],
                  ] as const
                ).map(([val, Icon, label]) => (
                  <button
                    key={val}
                    type="button"
                    title={label}
                    className={String(cur("hero_align")) === val ? btnOn : btn}
                    onClick={() => {
                      if (String(cur("hero_align")) !== val) setValue("hero_align", val);
                    }}
                  >
                    <Icon className="h-4 w-4" />
                  </button>
                ))}
              </span>
            )}
            {u && (
              <span className={group}>
                <button type="button" title="Smaller text (⌥↓)" className={btn} onClick={() => zoomBy(-10)}>
                  <ZoomOut className="h-4 w-4" />
                </button>
                <button type="button" title="Bigger text (⌥↑)" className={btn} onClick={() => zoomBy(10)}>
                  <ZoomIn className="h-4 w-4" />
                </button>
                {u.w && (
                  <>
                    <button type="button" title="Narrower box (⌥←)" className={btn} onClick={() => widthBy(-5)}>
                      <ChevronsRightLeft className="h-4 w-4" />
                    </button>
                    <button type="button" title="Wider box (⌥→)" className={btn} onClick={() => widthBy(5)}>
                      <ChevronsLeftRight className="h-4 w-4" />
                    </button>
                  </>
                )}
              </span>
            )}
          </>
        )}
        <span className="ml-auto flex items-center gap-2">
          {saveState === "rearranging" && <span className="text-xs font-medium text-amber-300">Rearranging…</span>}
          {saveState === "saving" && <span className="text-xs text-white/60">Saving…</span>}
          {saveState === "saved" && <span className="text-xs text-emerald-300">Saved ✓</span>}
          {saveState === "error" && (
            <>
              <span className="text-xs text-rose-300">{error ?? "The save didn't land."}</span>
              <button type="button" onClick={() => void flush()} className="rounded-lg bg-rose-500/80 px-2.5 py-1 text-xs font-semibold hover:bg-rose-500">
                Retry
              </button>
            </>
          )}
          <button type="button" title="Undo last change" className={btn} disabled={trail.length === 0} onClick={undoLast}>
            <Undo2 className="h-4 w-4" />
          </button>
          {trail.length > 0 && (
            <button type="button" onClick={() => setShowTrail((v) => !v)} className="text-xs text-white/60 hover:text-white">
              {trail.length} change{trail.length === 1 ? "" : "s"} {showTrail ? "▴" : "▾"}
            </button>
          )}
        </span>
        {/* NOTHING IS SILENT — the full trail is one tap away, each change with its own undo. */}
        {showTrail && trail.length > 0 && (
          <span className="flex w-full flex-wrap items-center gap-1.5 border-t border-white/10 pt-2">
            {trail.map((t) => (
              <span key={t.k} className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-xs">
                {PATCH_LABEL[t.k] ?? t.k}
                <button type="button" aria-label={`Undo ${PATCH_LABEL[t.k] ?? t.k}`} onClick={() => undo(t.k)} className="ml-0.5 text-white/60 hover:text-white">
                  ✕
                </button>
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="h-12" />
    </>
  );
}
