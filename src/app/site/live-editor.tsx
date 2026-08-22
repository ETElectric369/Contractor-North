"use client";

import { useEffect, useRef, useState } from "react";
import { SITE_FONTS, siteFontKey, type SiteFontKey } from "./site-fonts";
import { updateVersionFields } from "./live-edit-actions";

/**
 * EDIT IT ON THE PAGE, v2 — after the v29 lesson (Erik: "i just made some edits to v29 and it
 * changed everything"). v1's sins: controls acted invisibly (arrows changed values with no
 * on-page feedback), pending changes were a bare count, and the thing he actually wanted —
 * "old school using the arrows on my keyboard to move the box ... and all the resizing arrows"
 * — didn't exist. v2's laws:
 *
 *   · EVERYTHING VISIBLE ACTS VISIBLY. Arrows MOVE the box on screen as you press. Dragging
 *     moves it under the mouse. The resize handle stretches it live. Fonts and headline size
 *     repaint instantly. Nothing waits for Save to show itself.
 *   · EVERY PENDING CHANGE IS A NAMED CHIP with its own ✕ — removing one reverts it on screen.
 *   · Save lands the patch on THIS DRAFT through the same coerce boundary as a design pass.
 *
 * The movable/resizable unit is the hero text BOX ([data-hero-text] — classic open/panel/band).
 * The spread arrangement places its pieces at fixed corners; selecting text there still edits
 * words/fonts/sizes, and the bar says why moving is off.
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
  hero_style: "Text treatment",
  hero_dx: "Moved across",
  hero_dy: "Moved down",
  hero_w: "Box width",
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
const STYLES = ["open", "panel", "band", "spread"] as const;
// Mirrors HEAD_SIZE in org-site.tsx — the live class swap for headline size.
const HEAD_SIZE_CLS: Record<string, string[]> = {
  s: ["text-2xl", "sm:text-3xl"],
  m: ["text-3xl", "sm:text-4xl"],
  l: ["text-4xl", "sm:text-5xl"],
};

const clampNudge = (n: number) => Math.min(40, Math.max(-40, Math.round(n)));
const clampW = (n: number) => Math.min(100, Math.max(30, Math.round(n)));

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
  };
}) {
  const [selected, setSelected] = useState<FieldKey | null>(null);
  const [editingText, setEditingText] = useState(false);
  const [patch, setPatch] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patchRef = useRef(patch);
  patchRef.current = patch;
  const stateRef = useRef({ selected, editingText });
  stateRef.current = { selected, editingText };
  const originalText = useRef<Record<string, string>>({});
  const dragRef = useRef<{ mode: "move" | "resize"; startX: number; startY: number; dx0: number; dy0: number; w0: number } | null>(null);

  const heroBox = () => document.querySelector<HTMLElement>("[data-hero-text]");
  const cur = <T,>(k: string): T => (patchRef.current[k] ?? (initial as Record<string, unknown>)[k]) as T;
  const dirty = Object.keys(patch).length > 0;
  const canMove = initial.hero_style !== "spread";

  // ── LIVE PAINTERS — every value change repaints the page immediately ─────────────────────
  function paintBox() {
    const box = heroBox();
    if (!box) return;
    const dx = Number(cur<number>("hero_dx") ?? 0);
    const dy = Number(cur<number>("hero_dy") ?? 0);
    const w = Number(cur<number>("hero_w") ?? 0);
    box.style.transform = dx || dy ? `translate(${dx}%, ${dy}%)` : "";
    box.style.maxWidth = w ? `${w}%` : "";
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
  function setValue(k: string, v: unknown) {
    setPatch((p) => ({ ...p, [k]: v }));
    // paint AFTER state lands via patchRef in a microtask
    queueMicrotask(() => {
      if (k === "hero_dx" || k === "hero_dy" || k === "hero_w") paintBox();
      if (k === "splash_headline_size") paintHeadlineSize(String(v));
      if (k === "site_font" || k === "brand_font") paintFont(k as "site_font" | "brand_font", siteFontKey(v));
    });
  }
  function revert(k: string) {
    setPatch((p) => {
      const { [k]: _gone, ...rest } = p;
      return rest;
    });
    queueMicrotask(() => {
      if (k === "hero_dx" || k === "hero_dy" || k === "hero_w") paintBox();
      if (k === "splash_headline_size") paintHeadlineSize(String(initial.splash_headline_size));
      if (k === "site_font" || k === "brand_font") paintFont(k as "site_font" | "brand_font", siteFontKey((initial as Record<string, unknown>)[k]));
      if (k in originalText.current) {
        const el = document.querySelector<HTMLElement>(`[data-e="${k}"]`);
        if (el) el.innerText = originalText.current[k];
      }
    });
  }

  // ── WIRING: click select, double-click edit, drag move, handle resize, arrows ────────────
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-e]"));
    const box = heroBox();
    const clearSel = () => {
      els.forEach((el) => el.classList.remove("cn-live-selected"));
      box?.classList.remove("cn-live-box");
      document.getElementById("cn-resize-handle")?.remove();
    };
    const select = (el: HTMLElement) => {
      clearSel();
      el.classList.add("cn-live-selected");
      const f = el.dataset.e as FieldKey;
      setSelected(f);
      setEditingText(false);
      // The hero box becomes the movable unit whenever a hero text is selected.
      if (box && canMove && box.contains(el)) {
        box.classList.add("cn-live-box");
        box.style.position = box.style.position || "relative";
        const handle = document.createElement("div");
        handle.id = "cn-resize-handle";
        handle.title = "Drag to resize";
        box.appendChild(handle);
      }
    };
    const onClick = (e: Event) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-e]");
      if (!el) return;
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
      if (!(f in originalText.current)) originalText.current[f] = el.innerText;
      el.setAttribute("contenteditable", "plaintext-only");
      el.focus();
      setEditingText(true);
      const onBlur = () => {
        el.removeAttribute("contenteditable");
        el.removeEventListener("blur", onBlur);
        setEditingText(false);
        // A headline is one line — Enter must not smuggle newlines into the H1/<title> (v29).
        const raw = el.innerText;
        const clean = f === "splash_headline" ? raw.replace(/\s*\n+\s*/g, ", ").replace(/,\s*,/g, ",").trim() : raw.trim();
        if (f === "splash_headline" && clean !== raw) el.innerText = clean;
        setPatch((p) => ({ ...p, [f]: clean }));
      };
      el.addEventListener("blur", onBlur);
    };
    // DRAG TO MOVE — mousedown on the selected box (outside a text-editing session).
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (stateRef.current.editingText) return;
      if (t.id === "cn-resize-handle") {
        const b = heroBox();
        if (!b) return;
        const parentW = b.parentElement?.getBoundingClientRect().width || b.getBoundingClientRect().width;
        const w0 = Number(cur<number>("hero_w")) || Math.round((b.getBoundingClientRect().width / parentW) * 100);
        dragRef.current = { mode: "resize", startX: e.clientX, startY: e.clientY, dx0: 0, dy0: 0, w0 };
        e.preventDefault();
        return;
      }
      const b = heroBox();
      if (!b || !canMove || !b.classList.contains("cn-live-box")) return;
      if (!b.contains(t)) return;
      dragRef.current = {
        mode: "move",
        startX: e.clientX,
        startY: e.clientY,
        dx0: Number(cur<number>("hero_dx")) || 0,
        dy0: Number(cur<number>("hero_dy")) || 0,
        w0: 0,
      };
      e.preventDefault();
    };
    const onPointerMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const b = heroBox();
      if (!b) return;
      const r = b.getBoundingClientRect();
      if (d.mode === "move") {
        // translate % is relative to the box's own size — convert pixel deltas accordingly.
        const dx = clampNudge(d.dx0 + ((e.clientX - d.startX) / r.width) * 100);
        const dy = clampNudge(d.dy0 + ((e.clientY - d.startY) / r.height) * 100);
        b.style.transform = `translate(${dx}%, ${dy}%)`;
        b.dataset.pendingDx = String(dx);
        b.dataset.pendingDy = String(dy);
      } else {
        const parentW = b.parentElement?.getBoundingClientRect().width || r.width;
        const w = clampW(d.w0 + ((e.clientX - d.startX) / parentW) * 100);
        b.style.maxWidth = `${w}%`;
        b.dataset.pendingW = String(w);
      }
    };
    const onPointerUp = () => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      const b = heroBox();
      if (!b) return;
      if (d.mode === "move") {
        if (b.dataset.pendingDx) setValue("hero_dx", Number(b.dataset.pendingDx));
        if (b.dataset.pendingDy) setValue("hero_dy", Number(b.dataset.pendingDy));
      } else if (b.dataset.pendingW) {
        setValue("hero_w", Number(b.dataset.pendingW));
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const { selected: f, editingText: editing } = stateRef.current;
      if (!f || editing) return; // typing: arrows move the caret, never the layout
      if (e.key === "Escape") {
        clearSel();
        setSelected(null);
        return;
      }
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      e.preventDefault();
      const step = e.shiftKey ? 8 : 2;
      if (e.altKey) {
        // ⌥ + ←/→ — the keyboard resize (Erik: "all the resizing arrows as well").
        if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          const b = heroBox();
          const parentW = b?.parentElement?.getBoundingClientRect().width || 1;
          const now = Number(cur<number>("hero_w")) || (b ? Math.round((b.getBoundingClientRect().width / parentW) * 100) : 66);
          setValue("hero_w", clampW(now + (e.key === "ArrowRight" ? step : -step)));
        }
        return;
      }
      if (!canMove) return;
      if (e.key === "ArrowLeft") setValue("hero_dx", clampNudge((Number(cur<number>("hero_dx")) || 0) - step));
      if (e.key === "ArrowRight") setValue("hero_dx", clampNudge((Number(cur<number>("hero_dx")) || 0) + step));
      if (e.key === "ArrowUp") setValue("hero_dy", clampNudge((Number(cur<number>("hero_dy")) || 0) - step));
      if (e.key === "ArrowDown") setValue("hero_dy", clampNudge((Number(cur<number>("hero_dy")) || 0) + step));
    };
    els.forEach((el) => {
      el.addEventListener("click", onClick);
      el.addEventListener("dblclick", onDblClick);
    });
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keydown", onKey);
    return () => {
      els.forEach((el) => {
        el.removeEventListener("click", onClick);
        el.removeEventListener("dblclick", onDblClick);
      });
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKey);
      clearSel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function save() {
    if (!dirty) return;
    setSaving(true);
    setError(null);
    void updateVersionFields(versionId, patchRef.current).then((r) => {
      if (!r.ok) {
        setSaving(false);
        setError(r.error);
        return;
      }
      try {
        window.parent?.postMessage({ type: "cn-live-saved" }, "*");
      } catch {
        /* not framed */
      }
      window.location.reload();
    });
  }

  const fontRow = (kind: "site_font" | "brand_font") => (
    <span className="flex items-center gap-1">
      {FONT_KEYS.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => setValue(kind, k)}
          className={`rounded px-2 py-1 text-xs font-medium ${siteFontKey(patch[kind] ?? (initial as Record<string, unknown>)[kind]) === k ? "bg-white text-slate-900" : "bg-white/15 text-white hover:bg-white/25"}`}
        >
          {FONT_SHORT[k]}
        </button>
      ))}
    </span>
  );

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
        {!selected && <span className="text-white/70">Click a text to select it · double-click to rewrite it</span>}
        {selected && (
          <>
            <span className="rounded bg-amber-500/90 px-2 py-0.5 text-xs font-bold uppercase tracking-wide">{FIELD_LABEL[selected]}</span>
            {canMove && selected !== "__brand" && (
              <span className="text-white/60">drag the box · arrows move (⇧ bigger) · ⌥←/→ resize · handle resizes</span>
            )}
            {!canMove && selected !== "__brand" && (
              <span className="text-white/60">spread places pieces at fixed corners — switch Treatment to move freely</span>
            )}
            {selected === "splash_headline" && (
              <span className="flex items-center gap-1">
                <span className="text-white/60">Size</span>
                {SIZES.map((z) => (
                  <button
                    key={z}
                    type="button"
                    onClick={() => setValue("splash_headline_size", z)}
                    className={`rounded px-2 py-1 text-xs font-bold uppercase ${String(patch.splash_headline_size ?? initial.splash_headline_size) === z ? "bg-white text-slate-900" : "bg-white/15 hover:bg-white/25"}`}
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
              <span className="text-white/60">Treatment</span>
              {STYLES.map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setValue("hero_style", st)}
                  className={`rounded px-2 py-1 text-xs font-medium ${String(patch.hero_style ?? initial.hero_style) === st ? "bg-white text-slate-900" : "bg-white/15 hover:bg-white/25"}`}
                >
                  {st}
                </button>
              ))}
              <span className="ml-1 text-[11px] text-white/50">(applies on Save)</span>
            </span>
          </>
        )}
        <span className="ml-auto flex items-center gap-2">
          {error && <span className="text-xs text-rose-300">{error}</span>}
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={save}
            className="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-400 disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save to draft"}
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-lg bg-white/15 px-3 py-1.5 text-sm font-medium hover:bg-white/25"
          >
            Discard
          </button>
        </span>
        {/* EVERY PENDING CHANGE IS A NAMED CHIP — the v29 lesson: nothing rides along silently. */}
        {dirty && (
          <span className="flex w-full flex-wrap items-center gap-1.5 border-t border-white/10 pt-2">
            <span className="text-[11px] uppercase tracking-wide text-white/50">Unsaved:</span>
            {Object.entries(patch).map(([k, v]) => (
              <span key={k} className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-xs">
                {PATCH_LABEL[k] ?? k}: <span className="font-semibold">{String(v).slice(0, 24)}</span>
                <button type="button" aria-label={`Undo ${PATCH_LABEL[k] ?? k}`} onClick={() => revert(k)} className="ml-0.5 text-white/60 hover:text-white">
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
