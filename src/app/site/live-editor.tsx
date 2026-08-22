"use client";

import { useEffect, useRef, useState } from "react";
import { AlignCenter, AlignLeft, AlignRight, ChevronDown, Undo2 } from "lucide-react";
import { SITE_FONTS, siteFontKey, type SiteFontKey } from "./site-fonts";
import { updateVersionFields } from "./live-edit-actions";

/**
 * EDIT IT ON THE PAGE, v5 — the adversarial-review hardening of the v4 icon toolbar, plus two
 * of Erik's design calls:
 *
 *   · ZOOM PINS THE NATURAL CORNER ("these boxes resize from the center vs pinned at the
 *     appropriate opposing corner ... like any mac window"): every unit has a transform-origin
 *     (left-aligned box grows rightward, the lower-right tagline piece grows up-left) and its
 *     handles sit at the corner OPPOSITE the pin.
 *   · THE WALLS ARE DOWN ("i cant move the top anywhere outside its tiny assigned zone"):
 *     nudges clamp at ±400% of the unit's own size, and arrow steps are pixel-true (8px, ⇧
 *     32px) whatever the unit's size.
 *
 * Review fixes baked in: drag state lives in dragRef (stale DOM datasets re-committed old
 * drags on plain clicks); double-click mid-edit is caret word-selection, never a new session
 * (the "box saves but not the text" bug); flushes are single-flight and the server write is
 * CAS-guarded; a structural save owns its reload even via Retry; pointercancel/Escape cancel
 * a drag cleanly; clamps and refusals echo back onto the screen; levers paint through the
 * same desktop-scoped CSS vars the renderer uses, so phones keep the untouched re-stack.
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
  splash_headline_color: "Headline color",
  splash_tagline_color: "Tagline color",
  service_area_color: "Area color",
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
// Fields where Enter means A LINE BREAK (their renderers are whitespace-pre-line). Everywhere
// else Enter finishes the edit, like any single-line input.
const BREAK_FIELDS: FieldKey[] = ["splash_headline", "splash_tagline"];
// The palette's target per selected field; fields without an entry have no color tool.
const COLOR_KEY: Partial<Record<FieldKey, string>> = {
  splash_headline: "splash_headline_color",
  splash_tagline: "splash_tagline_color",
  service_area: "service_area_color",
};
const PALETTE = ["", "#ffffff", "#f8fafc", "#fde68a", "#fbbf24", "#f59e0b", "#7dd3fc", "#0ea5e9", "#34d399", "#f87171", "#c4b5fd", "#0f172a"];
const FONT_KEYS = Object.keys(SITE_FONTS) as SiteFontKey[];
const FONT_NAME: Record<SiteFontKey, string> = {
  default: "Standard",
  serif: "Serif",
  grotesk: "Grotesk",
  soft: "Rounded",
  condensed: "Condensed",
};
// The site shell's own face (layout.tsx Geist) — "Standard" must PAINT, not merely clear,
// because the server's SiteFonts rule for a non-default draft font would otherwise still win.
const DEFAULT_FAMILY = "var(--font-geist-sans), system-ui, sans-serif";
// Mirrors HEAD_SIZE in org-site.tsx — the live class swap for headline size.
const HEAD_SIZE_CLS: Record<string, string[]> = {
  s: ["text-2xl", "sm:text-3xl"],
  m: ["text-3xl", "sm:text-4xl"],
  l: ["text-4xl", "sm:text-5xl"],
};

/** The movable/resizable units. zx/zy: which way the zoom handle's corner points (opposite
 *  the transform-origin pin); wx: which edge the width handle lives on. The hero box's pin
 *  follows its alignment, resolved at selection time. */
const UNITS: { sel: string; dx: string; dy: string; w: string | null; sc: string; origin: string; zx: 1 | -1; zy: 1 | -1; wx: 1 | -1 }[] = [
  { sel: "[data-hero-text]", dx: "hero_dx", dy: "hero_dy", w: "hero_w", sc: "hero_scale", origin: "left top", zx: 1, zy: 1, wx: 1 },
  { sel: '[data-spread-piece="area"]', dx: "spread_area_dx", dy: "spread_area_dy", w: null, sc: "spread_area_scale", origin: "left top", zx: 1, zy: 1, wx: 1 },
  { sel: '[data-spread-piece="headline"]', dx: "spread_head_dx", dy: "spread_head_dy", w: "spread_head_w", sc: "spread_head_scale", origin: "left bottom", zx: 1, zy: -1, wx: 1 },
  { sel: '[data-spread-piece="tagline"]', dx: "spread_tag_dx", dy: "spread_tag_dy", w: "spread_tag_w", sc: "spread_tag_scale", origin: "right bottom", zx: -1, zy: -1, wx: -1 },
];
type Unit = { el: HTMLElement; dx: string; dy: string; w: string | null; sc: string; origin: string; zx: 1 | -1; zy: 1 | -1; wx: 1 | -1 };

const clampNudge = (n: number) => Math.min(400, Math.max(-400, Math.round(n)));
const clampW = (n: number) => Math.min(100, Math.max(30, Math.round(n)));
const clampZoom = (n: number) => Math.min(200, Math.max(50, Math.round(n)));
// Fields whose change restructures the banner server-side: save, then repaint via reload.
// hero_style is not settable here anymore, but old trail entries may still carry it.
const STRUCTURAL = new Set(["hero_style", "hero_align"]);

type TrailEntry = { k: string; prev: unknown };
type Drag = {
  mode: "move" | "width" | "zoom";
  pointerId: number;
  startX: number;
  startY: number;
  dx0: number;
  dy0: number;
  w0: number;
  s0: number;
  // Live values ride HERE, never on the DOM — stale dataset attrs re-committed old drags on
  // plain clicks (review): pending state must die with the drag by construction.
  pend: { dx?: number; dy?: number; w?: number; s?: number };
};

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
    splash_headline_color: string;
    splash_tagline_color: string;
    service_area_color: string;
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
  const [colorMenu, setColorMenu] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "rearranging" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const stateRef = useRef({ selected, editingText });
  stateRef.current = { selected, editingText };
  const valuesRef = useRef<Record<string, unknown>>({ ...initial });
  const pendingRef = useRef<Record<string, unknown>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flightRef = useRef<Promise<boolean> | null>(null);
  const trailRef = useRef<TrailEntry[]>([]);
  const unitRef = useRef<Unit | null>(null);
  const editingRef = useRef<{ el: HTMLElement; f: FieldKey; before: string } | null>(null);
  const dragRef = useRef<Drag | null>(null);

  const trailKey = `cn-live-trail:${versionId}`;
  const cur = <T,>(k: string): T => valuesRef.current[k] as T;
  const num = (k: string) => Number(cur<number>(k)) || 0;

  function say(msg: string) {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 5000);
  }

  // ── AUTOSAVE — single-flight; a structural save owns its reload ──────────────────────────
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
    const existing = trailRef.current.find((t) => t.k === k);
    if (existing) {
      // Recency order for "Undo last", keeping the ORIGINAL prev — re-touching a field moves
      // its one entry to the end instead of leaving Undo pointing at the wrong change.
      persistTrail([...trailRef.current.filter((t) => t.k !== k), existing]);
      return;
    }
    persistTrail([...trailRef.current, { k, prev }]);
  }
  async function doFlush(): Promise<boolean> {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const snap = pendingRef.current;
    if (Object.keys(snap).length === 0) return true;
    pendingRef.current = {};
    const structural = Object.keys(snap).some((k) => STRUCTURAL.has(k));
    setSaveState(structural ? "rearranging" : "saving");
    const r = await updateVersionFields(versionId, snap);
    if (!r.ok) {
      // Newer unsent edits win over the failed snapshot's values.
      pendingRef.current = { ...snap, ...pendingRef.current };
      setSaveState("error");
      setError(r.error);
      return false;
    }
    // The server's answer is the truth — a clamp or refusal must reach the screen, or the
    // page drifts from the draft under a green "Saved".
    for (const [k, v] of Object.entries(r.values)) {
      if (k in pendingRef.current) continue; // re-edited since — theirs is newer
      if (valuesRef.current[k] !== v) {
        valuesRef.current[k] = v;
        paint(k);
      }
    }
    if (r.dropped.length) say(`Not kept: ${r.dropped.join(", ")}`);
    try {
      window.parent?.postMessage({ type: "cn-live-saved" }, "*");
    } catch {
      /* not framed */
    }
    if (structural) {
      setSaveState("rearranging");
      window.location.reload();
      return true;
    }
    if (Object.keys(pendingRef.current).length > 0) {
      // Edits arrived while this save flew — they are NOT saved yet; don't say they are.
      scheduleSave();
      return true;
    }
    setError(null);
    setSaveState("saved");
    return true;
  }
  /** Single-flight: a second flush chains behind the first — overlapping saves were a
   *  lost-update race (and the DB write is CAS-guarded for other-tab writers). */
  function flush(): Promise<boolean> {
    const run = (flightRef.current ?? Promise.resolve(true)).then(() => doFlush(), () => doFlush());
    flightRef.current = run.finally(() => {
      if (flightRef.current === run) flightRef.current = null;
    });
    return run;
  }
  function scheduleSave() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), 700);
  }

  // ── LIVE PAINTERS — through the same desktop-scoped CSS vars the renderer emits ──────────
  function paintLever(el: HTMLElement, u: { dx: string; dy: string; w: string | null; sc: string; origin: string }, live?: { dx?: number; dy?: number; w?: number; s?: number }) {
    const dx = live?.dx ?? num(u.dx);
    const dy = live?.dy ?? num(u.dy);
    const sc = live?.s ?? num(u.sc);
    const w = u.w ? (live?.w ?? num(u.w)) : 0;
    const t = [dx || dy ? `translate(${dx}%, ${dy}%)` : "", sc ? `scale(${sc / 100})` : ""].filter(Boolean).join(" ") || "none";
    el.style.setProperty("--cn-t", t);
    el.style.setProperty("--cn-o", u.origin);
    el.classList.add("cn-lever");
    if (u.w) {
      if (w) {
        el.style.setProperty("--cn-w", `${w}%`);
        el.classList.add("cn-lever-w");
      } else {
        el.style.removeProperty("--cn-w");
        el.classList.remove("cn-lever-w");
      }
    }
  }
  function unitConfigByKey(k: string) {
    return UNITS.find((x) => x.dx === k || x.dy === k || x.w === k || x.sc === k) ?? null;
  }
  function paintUnitByKey(k: string) {
    const u = unitConfigByKey(k);
    if (!u) return;
    const el = document.querySelector<HTMLElement>(u.sel);
    if (!el) return;
    paintLever(el, { ...u, origin: originFor(u) });
  }
  function originFor(u: { sel: string; origin: string }): string {
    // The hero box pins at its aligned edge; the pieces have fixed natural corners.
    if (u.sel === "[data-hero-text]") return `${String(cur("hero_align")) || "left"} top`;
    return u.origin;
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
    const family = preset ? preset.family : DEFAULT_FAMILY;
    const targets =
      kind === "brand_font"
        ? document.querySelectorAll<HTMLElement>(".site-brand")
        : document.querySelectorAll<HTMLElement>(".site-shell h1, .site-shell h2, .site-shell h3");
    targets.forEach((el) => (el.style.fontFamily = family));
  }
  function paint(k: string) {
    paintUnitByKey(k);
    if (k.endsWith("_color")) {
      const field = (Object.entries(COLOR_KEY).find(([, ck]) => ck === k) ?? [])[0];
      const el = field ? document.querySelector<HTMLElement>(`[data-e="${field}"]`) : null;
      if (el) el.style.color = String(cur(k) ?? "");
    }
    if (k === "splash_headline_size") paintHeadlineSize(String(cur(k)));
    if (k === "site_font" || k === "brand_font") paintFont(k, siteFontKey(cur(k)));
    if (TEXT_FIELDS.includes(k as FieldKey)) {
      const el = document.querySelector<HTMLElement>(`[data-e="${k}"]`);
      if (el && el.innerText !== String(cur(k))) el.innerText = String(cur(k));
    }
  }

  /** The one entry point for every change: record undo, remember, paint, save. */
  function setValue(k: string, v: unknown, opts?: { record?: boolean }) {
    if (opts?.record !== false) recordPrev(k, valuesRef.current[k]);
    valuesRef.current[k] = v;
    pendingRef.current[k] = v;
    if (STRUCTURAL.has(k)) {
      setSaveState("rearranging");
      void flush(); // flush reloads on structural success — Retry included
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
    // A headline may carry deliberate line breaks — normalize, never flatten (cn-v787).
    const clean = BREAK_FIELDS.includes(sess.f)
      ? raw.replace(/\r\n?/g, "\n").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
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

  // ── WIRING ───────────────────────────────────────────────────────────────────────────────
  useEffect(() => {
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
        if (host && host.contains(el)) {
          const heroBox = u.sel === "[data-hero-text]";
          const align = String(cur("hero_align")) || "left";
          return {
            el: host,
            dx: u.dx,
            dy: u.dy,
            w: u.w,
            sc: u.sc,
            origin: heroBox ? `${align} top` : u.origin,
            zx: heroBox ? (align === "right" ? -1 : 1) : u.zx,
            zy: u.zy,
            wx: heroBox ? (align === "right" ? -1 : 1) : u.wx,
          };
        }
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
      setColorMenu(false);
      const u = unitFor(el);
      unitRef.current = u;
      if (u) {
        u.el.classList.add("cn-live-box");
        u.el.style.position = u.el.style.position || "relative";
        // Handles live at the corner/edge OPPOSITE the zoom pin — grab and pull AWAY to grow.
        const zoomHandle = document.createElement("div");
        zoomHandle.id = "cn-zoom-handle";
        zoomHandle.title = "Drag to make the text bigger or smaller";
        zoomHandle.style.cssText = `position:absolute;${u.zx === 1 ? "right" : "left"}:-10px;${u.zy === 1 ? "bottom" : "top"}:-10px;width:18px;height:18px;border-radius:50%;background:#f59e0b;border:2px solid white;cursor:${u.zx === u.zy ? "nwse-resize" : "nesw-resize"};z-index:55;`;
        u.el.appendChild(zoomHandle);
        if (u.w) {
          const widthHandle = document.createElement("div");
          widthHandle.id = "cn-width-handle";
          widthHandle.title = "Drag to make the box wider or narrower";
          widthHandle.style.cssText = `position:absolute;${u.wx === 1 ? "right" : "left"}:-10px;top:50%;margin-top:-9px;width:18px;height:18px;border-radius:4px;background:#0ea5e9;border:2px solid white;cursor:ew-resize;z-index:55;`;
          u.el.appendChild(widthHandle);
        }
      }
    };
    const onClick = (e: Event) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-e]");
      if (!el) return;
      if (el.isContentEditable) {
        // Caret positioning inside an active edit — swallow it so an ancestor link (the
        // estimate CTA) can't navigate the preview away mid-edit.
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      select(el);
    };
    const onDblClick = (e: Event) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-e]");
      if (!el) return;
      // Mid-edit double-click is word-selection for the caret — re-entering here would reset
      // the session baseline and silently discard the whole edit on blur (review).
      if (el.isContentEditable) return;
      const f = el.dataset.e as FieldKey;
      if (!TEXT_FIELDS.includes(f)) return;
      e.preventDefault();
      el.setAttribute("contenteditable", "plaintext-only");
      el.focus();
      setEditingText(true);
      editingRef.current = { el, f, before: el.innerText };
      // ENTER MUST DO SOMETHING (Erik's break "kept resetting": plaintext-only swallows Enter
      // entirely, so he pushed words apart with spaces and the render collapsed them). In a
      // break field Enter inserts a real \n; elsewhere it finishes the edit like an input.
      // keydown AND beforeinput both guard it — engines differ on which fires usably.
      // ENGINE-PROOF BREAK INSERT: execCommand first (plays the undo stack), and when an
      // engine ignores it (his app shell is WebKit — different editing rules than the
      // Chromium this was first verified in), raw Range surgery that no engine can refuse.
      const insertBreak = () => {
        const beforeText = el.textContent ?? "";
        let ok = false;
        try {
          ok = document.execCommand("insertText", false, "\n");
        } catch {
          ok = false;
        }
        if (ok && (el.textContent ?? "") !== beforeText) return;
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).commonAncestorContainer)) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          const tn = document.createTextNode("\n");
          range.insertNode(tn);
          range.setStartAfter(tn);
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        } else {
          el.appendChild(document.createTextNode("\n"));
        }
      };
      const onEnterKey = (ke: KeyboardEvent) => {
        if (ke.key !== "Enter") return;
        ke.preventDefault();
        if (BREAK_FIELDS.includes(f)) insertBreak();
        else el.blur();
      };
      const onBeforeInput = (ie: Event) => {
        const t = (ie as InputEvent).inputType;
        if (t !== "insertParagraph" && t !== "insertLineBreak") return;
        ie.preventDefault();
        if (BREAK_FIELDS.includes(f)) insertBreak();
        else el.blur();
      };
      el.addEventListener("keydown", onEnterKey);
      el.addEventListener("beforeinput", onBeforeInput);
      const onBlur = () => {
        el.removeEventListener("blur", onBlur);
        el.removeEventListener("keydown", onEnterKey);
        el.removeEventListener("beforeinput", onBeforeInput);
        endTextEdit(false);
      };
      el.addEventListener("blur", onBlur);
    };
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      const active = document.activeElement as HTMLElement | null;
      if (stateRef.current.editingText || (active && active.isContentEditable) || t.isContentEditable) return;
      const u = unitRef.current;
      if (!u) return;
      const base = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, dx0: 0, dy0: 0, w0: 0, s0: 0, pend: {} };
      if (t.id === "cn-width-handle" && u.w) {
        const parentW = u.el.parentElement?.getBoundingClientRect().width || u.el.getBoundingClientRect().width;
        dragRef.current = { ...base, mode: "width", w0: num(u.w) || Math.round((u.el.getBoundingClientRect().width / parentW) * 100) };
        e.preventDefault();
        return;
      }
      if (t.id === "cn-zoom-handle") {
        dragRef.current = { ...base, mode: "zoom", s0: num(u.sc) || 100 };
        e.preventDefault();
        return;
      }
      if (!u.el.classList.contains("cn-live-box") || !u.el.contains(t)) return;
      dragRef.current = { ...base, mode: "move", dx0: num(u.dx), dy0: num(u.dy) };
      e.preventDefault();
    };
    const onPointerMove = (e: PointerEvent) => {
      const d = dragRef.current;
      const u = unitRef.current;
      if (!d || !u || e.pointerId !== d.pointerId) return;
      const r = u.el.getBoundingClientRect();
      if (d.mode === "move") {
        const dx = clampNudge(d.dx0 + ((e.clientX - d.startX) / r.width) * 100);
        const dy = clampNudge(d.dy0 + ((e.clientY - d.startY) / r.height) * 100);
        d.pend = { dx, dy };
        paintLever(u.el, u, { dx, dy });
      } else if (d.mode === "width") {
        const parentW = u.el.parentElement?.getBoundingClientRect().width || r.width;
        const w = clampW(d.w0 + (u.wx * (e.clientX - d.startX) * 100) / parentW);
        d.pend = { w };
        paintLever(u.el, u, { w });
      } else {
        // Pull AWAY from the pinned corner to grow — the sign vector points at the handle.
        const delta = ((u.zx * (e.clientX - d.startX)) / r.width + (u.zy * (e.clientY - d.startY)) / r.height) * 50;
        const s = clampZoom(d.s0 + delta);
        d.pend = { s };
        paintLever(u.el, u, { s });
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      const d = dragRef.current;
      const u = unitRef.current;
      if (!d || e.pointerId !== d.pointerId) return;
      dragRef.current = null;
      if (!u) return;
      if (d.mode === "move") {
        if (d.pend.dx !== undefined) setValue(u.dx, d.pend.dx);
        if (d.pend.dy !== undefined) setValue(u.dy, d.pend.dy);
      } else if (d.mode === "width" && u.w && d.pend.w !== undefined) {
        setValue(u.w, d.pend.w);
      } else if (d.mode === "zoom" && d.pend.s !== undefined) {
        setValue(u.sc, d.pend.s);
      }
    };
    const cancelDrag = () => {
      const u = unitRef.current;
      dragRef.current = null;
      if (u) paintLever(u.el, u); // back to committed truth
    };
    const onPointerCancel = (e: PointerEvent) => {
      if (dragRef.current && e.pointerId === dragRef.current.pointerId) cancelDrag();
    };
    const onKey = (e: KeyboardEvent) => {
      const { selected: f, editingText: editing } = stateRef.current;
      const active = document.activeElement as HTMLElement | null;
      if (!f || editing || (active && active.isContentEditable)) return;
      if (e.key === "Escape") {
        if (dragRef.current) {
          cancelDrag(); // first Escape cancels a drag in flight
          return;
        }
        clearSel();
        setSelected(null);
        setFontMenu(null);
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      const u = unitRef.current;
      if (!u) return;
      e.preventDefault();
      const r = u.el.getBoundingClientRect();
      // Pixel-true steps whatever the unit's size — 2% of a one-line piece is sub-pixel.
      const px = e.shiftKey ? 32 : 8;
      if (e.altKey) {
        if (u.w && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          const parentW = u.el.parentElement?.getBoundingClientRect().width || 1;
          const now = num(u.w) || Math.round((r.width / parentW) * 100);
          setValue(u.w, clampW(now + ((e.key === "ArrowRight" ? 1 : -1) * px * 100) / parentW));
        }
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          const now = num(u.sc) || 100;
          setValue(u.sc, clampZoom(now + (e.key === "ArrowUp" ? 10 : -10)));
        }
        return;
      }
      const stepX = Math.max(1, Math.round((px / r.width) * 100));
      const stepY = Math.max(1, Math.round((px / r.height) * 100));
      if (e.key === "ArrowLeft") setValue(u.dx, clampNudge(num(u.dx) - stepX));
      if (e.key === "ArrowRight") setValue(u.dx, clampNudge(num(u.dx) + stepX));
      if (e.key === "ArrowUp") setValue(u.dy, clampNudge(num(u.dy) - stepY));
      if (e.key === "ArrowDown") setValue(u.dy, clampNudge(num(u.dy) + stepY));
    };
    const onWindowBlur = () => {
      endTextEdit(true);
      void flush();
    };
    const onPageHide = () => {
      endTextEdit(false);
      void flush();
    };
    const onParentMsg = (e: MessageEvent) => {
      // The studio asks us to land everything before it remounts the iframe or acts on the doc.
      if ((e.data as { type?: string })?.type === "cn-live-flush") {
        endTextEdit(false);
        void flush().then(() => {
          try {
            window.parent?.postMessage({ type: "cn-live-flushed" }, "*");
          } catch {
            /* not framed */
          }
        });
      }
    };
    els.forEach((el) => {
      el.addEventListener("click", onClick);
      el.addEventListener("dblclick", onDblClick);
    });
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", onWindowBlur);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("message", onParentMsg);
    return () => {
      els.forEach((el) => {
        el.removeEventListener("click", onClick);
        el.removeEventListener("dblclick", onDblClick);
      });
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onWindowBlur);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("message", onParentMsg);
      clearSel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const u = unitRef.current;
  const btn = "inline-flex h-8 min-w-8 items-center justify-center rounded px-1.5 text-white/85 hover:bg-white/15 disabled:opacity-30";
  const btnOn = "inline-flex h-8 min-w-8 items-center justify-center rounded px-1.5 bg-white text-slate-900";
  const group = "flex items-center gap-0.5 border-l border-white/15 pl-2";
  const zoomBy = (delta: number) => {
    if (!u) return;
    setValue(u.sc, clampZoom((num(u.sc) || 100) + delta));
  };
  const fontKind: "site_font" | "brand_font" = selected === "__brand" ? "brand_font" : "site_font";

  return (
    <>
      <style>{`
        .cn-live-selected { outline: 2px dashed #f59e0b; outline-offset: 4px; }
        .cn-live-box { outline: 2px solid #f59e0b; outline-offset: 8px; cursor: move; }
        [data-e] { cursor: pointer; }
      `}</style>
      <div className="fixed inset-x-0 top-0 z-[60] flex flex-wrap items-center gap-x-2 gap-y-2 bg-slate-900/95 px-4 py-2 text-sm text-white shadow-lg backdrop-blur">
        {!selected && <span className="text-white/70">Click any text to work on it · double-click to retype it</span>}
        {selected && (
          <>
            <span className="rounded bg-amber-500/90 px-2 py-0.5 text-xs font-bold uppercase tracking-wide">{FIELD_LABEL[selected]}</span>
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
                  <span className="text-xs font-bold">A−</span>
                </button>
                <button type="button" title="Bigger text (⌥↑)" className={btn} onClick={() => zoomBy(10)}>
                  <span className="text-base font-bold">A+</span>
                </button>
              </span>
            )}
            {selected && COLOR_KEY[selected] && (
              <span className={`${group} relative`}>
                <button
                  type="button"
                  title="Text color"
                  className={colorMenu ? btnOn : btn}
                  onClick={() => setColorMenu((v) => !v)}
                >
                  <span className="flex flex-col items-center leading-none">
                    <span className="text-sm font-bold">A</span>
                    <span
                      className="mt-0.5 h-1 w-4 rounded-sm"
                      style={{ backgroundColor: String(cur(COLOR_KEY[selected]!) || "") || "#94a3b8" }}
                    />
                  </span>
                </button>
                {colorMenu && (
                  <span className="absolute left-0 top-9 z-[70] grid w-44 grid-cols-4 gap-1.5 rounded-lg bg-slate-800 p-2 shadow-xl ring-1 ring-white/15">
                    {PALETTE.map((c) => (
                      <button
                        key={c || "default"}
                        type="button"
                        title={c || "Theme default"}
                        onClick={() => {
                          setValue(COLOR_KEY[selected]!, c);
                          setColorMenu(false);
                        }}
                        className={`h-8 w-8 rounded-md border ${String(cur(COLOR_KEY[selected]!) || "") === c ? "border-amber-400 ring-2 ring-amber-400/60" : "border-white/20"}`}
                        style={c ? { backgroundColor: c } : { background: "repeating-conic-gradient(#475569 0 25%, #334155 0 50%) 0 0 / 12px 12px" }}
                      />
                    ))}
                    <label
                      title="Custom color"
                      className="col-span-4 mt-1 flex h-8 cursor-pointer items-center justify-center rounded-md border border-white/20 text-xs font-medium text-white/80 hover:bg-white/10"
                    >
                      Custom…
                      <input
                        type="color"
                        className="h-0 w-0 opacity-0"
                        onChange={(e) => {
                          setValue(COLOR_KEY[selected]!, e.target.value);
                          setColorMenu(false);
                        }}
                      />
                    </label>
                  </span>
                )}
              </span>
            )}
          </>
        )}
        <span className="ml-auto flex items-center gap-2">
          {notice && <span className="text-xs text-amber-300">{notice}</span>}
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
