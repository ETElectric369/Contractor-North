"use client";

import { useEffect, useRef, useState } from "react";
import { SITE_FONTS, siteFontKey, type SiteFontKey } from "./site-fonts";
import { updateVersionFields } from "./live-edit-actions";

/**
 * EDIT IT ON THE PAGE, v3 — NO SAVE GAME (Erik: "i cant see any changes when i click on the
 * options and i cant resize anything so clearly theres a wall between me and seeing changes in
 * real time so i/non-tech person doesnt have to play the save game").
 *
 * The v3 laws:
 *   · EVERY CLICK ACTS INSTANTLY. There is no Save button. Cosmetic changes paint in place;
 *     autosave lands them on the draft moments later. A layout switch (the one change that
 *     needs the server to rebuild the banner) saves first and repaints in about a second.
 *   · EVERYTHING IS MOVABLE. The classic hero box AND each corner piece of the Corners layout
 *     drags, arrow-nudges, and (where a width exists) resizes — no arrangement is a dead end.
 *   · NOTHING IS SILENT: every change is a named chip with its own undo, and the trail
 *     survives the layout-switch reload (sessionStorage per draft).
 *   · PLAIN WORDS ONLY. "Layout: Open / Card / Strip / Corners" — no "treatment" jargon.
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
  hero_align: "Text position",
  hero_style: "Banner layout",
  hero_dx: "Moved across",
  hero_dy: "Moved down",
  hero_w: "Box width",
  spread_area_dx: "Area piece across",
  spread_area_dy: "Area piece down",
  spread_head_dx: "Headline piece across",
  spread_head_dy: "Headline piece down",
  spread_head_w: "Headline piece width",
  spread_tag_dx: "Tagline piece across",
  spread_tag_dy: "Tagline piece down",
  spread_tag_w: "Tagline piece width",
};

const TEXT_FIELDS: FieldKey[] = ["splash_headline", "splash_tagline", "service_area", "estimate_cta_label"];
const FONT_KEYS = Object.keys(SITE_FONTS) as SiteFontKey[];
const FONT_SHORT: Record<SiteFontKey, string> = {
  default: "Standard",
  serif: "Serif",
  grotesk: "Grotesk",
  soft: "Rounded",
  condensed: "Condensed",
};
const SIZES = ["s", "m", "l"] as const;
// Plain words for the arrangement — "spread"/"panel" meant nothing to a non-tech owner.
const STYLES: { key: string; label: string }[] = [
  { key: "open", label: "Open" },
  { key: "panel", label: "Card" },
  { key: "band", label: "Strip" },
  { key: "spread", label: "Corners" },
];
// Mirrors HEAD_SIZE in org-site.tsx — the live class swap for headline size.
const HEAD_SIZE_CLS: Record<string, string[]> = {
  s: ["text-2xl", "sm:text-3xl"],
  m: ["text-3xl", "sm:text-4xl"],
  l: ["text-4xl", "sm:text-5xl"],
};

/** The movable/resizable units. Whichever one contains the selected text is what drag, the
 *  arrow keys, and the resize handle act on — the classic box OR a Corners piece. */
const UNITS: { sel: string; dx: string; dy: string; w: string | null }[] = [
  { sel: "[data-hero-text]", dx: "hero_dx", dy: "hero_dy", w: "hero_w" },
  { sel: '[data-spread-piece="area"]', dx: "spread_area_dx", dy: "spread_area_dy", w: null },
  { sel: '[data-spread-piece="headline"]', dx: "spread_head_dx", dy: "spread_head_dy", w: "spread_head_w" },
  { sel: '[data-spread-piece="tagline"]', dx: "spread_tag_dx", dy: "spread_tag_dy", w: "spread_tag_w" },
];
type Unit = { el: HTMLElement; dx: string; dy: string; w: string | null };

const clampNudge = (n: number) => Math.min(40, Math.max(-40, Math.round(n)));
const clampW = (n: number) => Math.min(100, Math.max(30, Math.round(n)));
// The one field whose change restructures the banner server-side: save, then repaint via reload.
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
  const dragRef = useRef<{ mode: "move" | "resize"; startX: number; startY: number; dx0: number; dy0: number; w0: number } | null>(null);

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
    const u = UNITS.find((x) => x.dx === k || x.dy === k || x.w === k);
    if (!u) return;
    const el = document.querySelector<HTMLElement>(u.sel);
    if (!el) return;
    const dx = num(u.dx);
    const dy = num(u.dy);
    const w = u.w ? num(u.w) : 0;
    el.style.transform = dx || dy ? `translate(${dx}%, ${dy}%)` : "";
    if (u.w) el.style.maxWidth = w ? `${w}%` : "";
  }
  function paintHeadlineSize(size: string) {
    const h1 = document.querySelector<HTMLElement>('[data-e="splash_headline"]');
    if (!h1) return;
    for (const cls of Object.values(HEAD_SIZE_CLS).flat()) h1.classList.remove(cls);
    for (const cls of HEAD_SIZE_CLS[size] ?? HEAD_SIZE_CLS.l) h1.classList.add(cls);
  }
  function paintFont(kind: "site_font" | "brand_font", key: SiteFontKey) {
    const preset = SITE_FONTS[key];
    if (preset && !document.querySelector(`link[href="${preset.css}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = preset.css;
      document.head.appendChild(link);
    }
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
   *  change (banner layout) saves NOW and repaints via reload — everything else is instant. */
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
  function undo(k: string) {
    const entry = trailRef.current.find((t) => t.k === k);
    if (!entry) return;
    persistTrail(trailRef.current.filter((t) => t.k !== k));
    setValue(k, entry.prev, { record: false });
  }
  function undoAll() {
    const entries = [...trailRef.current].reverse();
    persistTrail([]);
    const structural = entries.some((t) => STRUCTURAL.has(t.k));
    for (const t of entries) {
      valuesRef.current[t.k] = t.prev;
      pendingRef.current[t.k] = t.prev;
      if (!STRUCTURAL.has(t.k)) paint(t.k);
    }
    if (structural) {
      setSaveState("rearranging");
      void flush().then((ok) => {
        if (ok) window.location.reload();
      });
    } else {
      void flush();
    }
  }

  // ── WIRING: click select, double-click edit, drag move, handle resize, arrows ────────────
  useEffect(() => {
    // The undo trail survives the layout-switch reload.
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
        if (host && host.contains(el)) return { el: host, dx: u.dx, dy: u.dy, w: u.w };
      }
      return null;
    };
    const clearSel = () => {
      els.forEach((el) => el.classList.remove("cn-live-selected"));
      unitRef.current?.el.classList.remove("cn-live-box");
      document.getElementById("cn-resize-handle")?.remove();
      unitRef.current = null;
    };
    const select = (el: HTMLElement) => {
      clearSel();
      el.classList.add("cn-live-selected");
      setSelected(el.dataset.e as FieldKey);
      setEditingText(false);
      const u = unitFor(el);
      unitRef.current = u;
      if (u) {
        u.el.classList.add("cn-live-box");
        u.el.style.position = u.el.style.position || "relative";
        if (u.w) {
          const handle = document.createElement("div");
          handle.id = "cn-resize-handle";
          handle.title = "Drag to resize";
          u.el.appendChild(handle);
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
      const before = el.innerText;
      const onBlur = () => {
        el.removeAttribute("contenteditable");
        el.removeEventListener("blur", onBlur);
        setEditingText(false);
        // A headline is one line — Enter must not smuggle newlines into the H1/<title> (v29).
        const raw = el.innerText;
        const clean = f === "splash_headline" ? raw.replace(/\s*\n+\s*/g, ", ").replace(/,\s*,/g, ",").trim() : raw.trim();
        if (clean !== raw) el.innerText = clean;
        if (clean !== before) {
          recordPrev(f, before);
          setValue(f, clean, { record: false });
        }
      };
      el.addEventListener("blur", onBlur);
    };
    // DRAG TO MOVE / RESIZE — on whichever unit (box or corner piece) holds the selection.
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      const active = document.activeElement as HTMLElement | null;
      if (stateRef.current.editingText || (active && active.isContentEditable) || t.isContentEditable) return;
      const u = unitRef.current;
      if (!u) return;
      if (t.id === "cn-resize-handle" && u.w) {
        const parentW = u.el.parentElement?.getBoundingClientRect().width || u.el.getBoundingClientRect().width;
        const w0 = num(u.w) || Math.round((u.el.getBoundingClientRect().width / parentW) * 100);
        dragRef.current = { mode: "resize", startX: e.clientX, startY: e.clientY, dx0: 0, dy0: 0, w0 };
        e.preventDefault();
        return;
      }
      if (!u.el.classList.contains("cn-live-box") || !u.el.contains(t)) return;
      dragRef.current = { mode: "move", startX: e.clientX, startY: e.clientY, dx0: num(u.dx), dy0: num(u.dy), w0: 0 };
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
        u.el.style.transform = `translate(${dx}%, ${dy}%)`;
        u.el.dataset.pendingDx = String(dx);
        u.el.dataset.pendingDy = String(dy);
      } else {
        const parentW = u.el.parentElement?.getBoundingClientRect().width || r.width;
        const w = clampW(d.w0 + ((e.clientX - d.startX) / parentW) * 100);
        u.el.style.maxWidth = `${w}%`;
        u.el.dataset.pendingW = String(w);
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
      } else if (u.w && u.el.dataset.pendingW) {
        setValue(u.w, Number(u.el.dataset.pendingW));
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
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      const u = unitRef.current;
      if (!u) return;
      e.preventDefault();
      const step = e.shiftKey ? 8 : 2;
      if (e.altKey) {
        // ⌥ + ←/→ — the keyboard resize ("all the resizing arrows as well").
        if (u.w && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
          const parentW = u.el.parentElement?.getBoundingClientRect().width || 1;
          const now = num(u.w) || Math.round((u.el.getBoundingClientRect().width / parentW) * 100);
          setValue(u.w, clampW(now + (e.key === "ArrowRight" ? step : -step)));
        }
        return;
      }
      if (e.key === "ArrowLeft") setValue(u.dx, clampNudge(num(u.dx) - step));
      if (e.key === "ArrowRight") setValue(u.dx, clampNudge(num(u.dx) + step));
      if (e.key === "ArrowUp") setValue(u.dy, clampNudge(num(u.dy) - step));
      if (e.key === "ArrowDown") setValue(u.dy, clampNudge(num(u.dy) + step));
    };
    const onPageHide = () => {
      // Best effort: push any 700ms-window stragglers before the tab goes away.
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
      window.removeEventListener("pagehide", onPageHide);
      clearSel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fontRow = (kind: "site_font" | "brand_font") => (
    <span className="flex items-center gap-1">
      {FONT_KEYS.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => setValue(kind, k)}
          className={`rounded px-2 py-1 text-xs font-medium ${siteFontKey(cur(kind)) === k ? "bg-white text-slate-900" : "bg-white/15 text-white hover:bg-white/25"}`}
        >
          {FONT_SHORT[k]}
        </button>
      ))}
    </span>
  );
  const hasUnit = !!unitRef.current;
  const unitResizes = !!unitRef.current?.w;

  return (
    <>
      <style>{`
        .cn-live-selected { outline: 2px dashed #f59e0b; outline-offset: 4px; }
        .cn-live-box { outline: 2px solid #f59e0b; outline-offset: 8px; cursor: move; }
        [data-e] { cursor: pointer; }
        #cn-resize-handle { position: absolute; right: -10px; bottom: -10px; width: 18px; height: 18px; border-radius: 4px; background: #f59e0b; border: 2px solid white; cursor: nwse-resize; z-index: 55; }
      `}</style>
      <div className="fixed inset-x-0 top-0 z-[60] flex flex-wrap items-center gap-x-4 gap-y-2 bg-slate-900/95 px-4 py-2.5 text-sm text-white shadow-lg backdrop-blur">
        <span className="font-semibold">On-page editing</span>
        {!selected && <span className="text-white/70">Click any text to work on it · double-click to retype it</span>}
        {selected && (
          <>
            <span className="rounded bg-amber-500/90 px-2 py-0.5 text-xs font-bold uppercase tracking-wide">{FIELD_LABEL[selected]}</span>
            {hasUnit && (
              <span className="text-white/60">
                drag it or use the arrow keys (⇧ = bigger steps){unitResizes ? " · corner handle or ⌥ ←/→ resizes" : ""}
              </span>
            )}
            {selected === "splash_headline" && (
              <span className="flex items-center gap-1">
                <span className="text-white/60">Size</span>
                {SIZES.map((z) => (
                  <button
                    key={z}
                    type="button"
                    onClick={() => setValue("splash_headline_size", z)}
                    className={`rounded px-2 py-1 text-xs font-bold uppercase ${String(cur("splash_headline_size")) === z ? "bg-white text-slate-900" : "bg-white/15 hover:bg-white/25"}`}
                  >
                    {z}
                  </button>
                ))}
                <span className="ml-2 text-white/60">Font</span>
                {fontRow("site_font")}
              </span>
            )}
            {selected === "__brand" && (
              <span className="flex items-center gap-1">
                <span className="text-white/60">Name font</span>
                {fontRow("brand_font")}
              </span>
            )}
            <span className="flex items-center gap-1">
              <span className="text-white/60">Layout</span>
              {STYLES.map((st) => (
                <button
                  key={st.key}
                  type="button"
                  onClick={() => setValue("hero_style", st.key)}
                  className={`rounded px-2 py-1 text-xs font-medium ${String(cur("hero_style")) === st.key ? "bg-white text-slate-900" : "bg-white/15 hover:bg-white/25"}`}
                >
                  {st.label}
                </button>
              ))}
            </span>
          </>
        )}
        <span className="ml-auto flex items-center gap-2">
          {saveState === "rearranging" && <span className="text-xs font-medium text-amber-300">Rearranging…</span>}
          {saveState === "saving" && <span className="text-xs text-white/60">Saving…</span>}
          {saveState === "saved" && <span className="text-xs text-emerald-300">All changes saved ✓</span>}
          {saveState === "error" && (
            <>
              <span className="text-xs text-rose-300">{error ?? "The save didn't land."}</span>
              <button
                type="button"
                onClick={() => void flush()}
                className="rounded-lg bg-rose-500/80 px-2.5 py-1 text-xs font-semibold hover:bg-rose-500"
              >
                Retry
              </button>
            </>
          )}
          {trail.length > 0 && (
            <button
              type="button"
              onClick={undoAll}
              className="rounded-lg bg-white/15 px-3 py-1.5 text-sm font-medium hover:bg-white/25"
            >
              Undo all
            </button>
          )}
        </span>
        {/* NOTHING IS SILENT — every change is a named chip with its own undo (the v29 lesson). */}
        {trail.length > 0 && (
          <span className="flex w-full flex-wrap items-center gap-1.5 border-t border-white/10 pt-2">
            <span className="text-[11px] uppercase tracking-wide text-white/50">Changed (✕ puts it back):</span>
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
