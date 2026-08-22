"use client";

import { useEffect, useRef, useState } from "react";
import { SITE_FONTS, siteFontKey, type SiteFontKey } from "./site-fonts";
import { updateVersionFields } from "./live-edit-actions";

/**
 * EDIT IT ON THE PAGE (Erik: "an edit control bar with tools to pick the text box and edit the
 * fonts and size ... or change the text right there on the screen ... old school highlight the
 * box and hit the right or left arrow"). Mounts ONLY inside an authorized draft preview with
 * ?edit=1 — the public never gets this script, and the save action re-checks staff + draft.
 *
 * The interaction model, old-school on purpose:
 *   · single CLICK a marked text — it highlights, the control bar shows its tools
 *   · DOUBLE-CLICK — edit the words right there (contentEditable)
 *   · ARROW KEYS on a highlighted hero text — ←/→ steps the hero text position
 *     (left/center/right), ↑/↓ steps the headline size — micro-adjust by keyboard
 *   · Save — the changes land on THIS DRAFT through the same boundary as a design pass
 *
 * Everything clickable is a NAMED FIELD (data-e attributes in the renderer), which is what makes
 * this safe: the editor can only ever touch what the design document owns.
 */

type FieldKey = "splash_headline" | "splash_tagline" | "service_area" | "estimate_cta_label" | "__brand";

const FIELD_LABEL: Record<FieldKey, string> = {
  splash_headline: "Headline",
  splash_tagline: "Tagline",
  service_area: "Service area",
  estimate_cta_label: "Estimate button",
  __brand: "Business name",
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
const ALIGNS = ["left", "center", "right"] as const;
const STYLES = ["open", "panel", "band", "spread"] as const;

export function LiveEditor({
  versionId,
  initial,
}: {
  versionId: string;
  initial: { splash_headline_size: string; hero_align: string; hero_style: string; site_font: string; brand_font: string };
}) {
  const [selected, setSelected] = useState<FieldKey | null>(null);
  const [editingText, setEditingText] = useState(false);
  const [patch, setPatch] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patchRef = useRef(patch);
  patchRef.current = patch;
  const selectedRef = useRef<{ field: FieldKey | null; editing: boolean }>({ field: null, editing: false });
  selectedRef.current = { field: selected, editing: editingText };

  const cur = (k: string, fallback: string) => String(patch[k] ?? (initial as Record<string, string>)[k] ?? fallback);
  const dirty = Object.keys(patch).length > 0;

  // Wire the page's marked elements. The site is server HTML — plain DOM wiring is the honest tool.
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-e]"));
    const clearOutline = () => els.forEach((el) => el.classList.remove("cn-live-selected"));
    const onClick = (e: Event) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-e]");
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      clearOutline();
      el.classList.add("cn-live-selected");
      setSelected(el.dataset.e as FieldKey);
      setEditingText(false);
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
      const onBlur = () => {
        el.removeAttribute("contenteditable");
        el.removeEventListener("blur", onBlur);
        setEditingText(false);
        setPatch((p) => ({ ...p, [f]: el.innerText.trim() }));
      };
      el.addEventListener("blur", onBlur);
    };
    els.forEach((el) => {
      el.addEventListener("click", onClick);
      el.addEventListener("dblclick", onDblClick);
    });
    const onKey = (e: KeyboardEvent) => {
      const { field, editing } = selectedRef.current;
      if (!field || editing) return; // arrows move the caret while typing — never the layout
      if (e.key === "Escape") {
        clearOutline();
        setSelected(null);
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const dir = e.key === "ArrowRight" ? 1 : -1;
        setPatch((p) => {
          const now = String(p.hero_align ?? initial.hero_align);
          const i = Math.min(Math.max(ALIGNS.indexOf(now as (typeof ALIGNS)[number]) + dir, 0), ALIGNS.length - 1);
          return { ...p, hero_align: ALIGNS[i] };
        });
      }
      if (field === "splash_headline" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const dir = e.key === "ArrowUp" ? 1 : -1;
        setPatch((p) => {
          const now = String(p.splash_headline_size ?? initial.splash_headline_size);
          const i = Math.min(Math.max(SIZES.indexOf(now as (typeof SIZES)[number]) + dir, 0), SIZES.length - 1);
          return { ...p, splash_headline_size: SIZES[i] };
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      els.forEach((el) => {
        el.removeEventListener("click", onClick);
        el.removeEventListener("dblclick", onDblClick);
      });
      window.removeEventListener("keydown", onKey);
      clearOutline();
    };
  }, [initial]);

  // LIVE font preview: picking a face applies it on the page immediately (link + inline rule);
  // position/size/style steps apply on Save (the reload paints them) — shown as pending chips.
  function applyFontPreview(kind: "site_font" | "brand_font", key: SiteFontKey) {
    setPatch((p) => ({ ...p, [kind]: key }));
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
        /* not framed — fine */
      }
      window.location.reload(); // the saved draft repaints, including position/size steps
    });
  }

  const fontRow = (kind: "site_font" | "brand_font") => (
    <span className="flex items-center gap-1">
      {FONT_KEYS.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => applyFontPreview(kind, k)}
          className={`rounded px-2 py-1 text-xs font-medium ${siteFontKey(cur(kind, "default")) === k ? "bg-white text-slate-900" : "bg-white/15 text-white hover:bg-white/25"}`}
        >
          {FONT_SHORT[k]}
        </button>
      ))}
    </span>
  );

  return (
    <>
      <style>{`.cn-live-selected { outline: 2px dashed #f59e0b; outline-offset: 4px; cursor: default; } [data-e] { cursor: pointer; }`}</style>
      <div className="fixed inset-x-0 top-0 z-[60] flex flex-wrap items-center gap-x-4 gap-y-2 bg-slate-900/95 px-4 py-2.5 text-sm text-white shadow-lg backdrop-blur">
        <span className="font-semibold">On-page editing</span>
        {!selected && <span className="text-white/70">Click any highlighted-on-hover text · double-click to rewrite it</span>}
        {selected && (
          <>
            <span className="rounded bg-amber-500/90 px-2 py-0.5 text-xs font-bold uppercase tracking-wide">
              {FIELD_LABEL[selected]}
            </span>
            {TEXT_FIELDS.includes(selected) && <span className="text-white/70">double-click the text to rewrite it</span>}
            {selected === "splash_headline" && (
              <>
                <span className="flex items-center gap-1">
                  <span className="text-white/60">Size</span>
                  {SIZES.map((z) => (
                    <button
                      key={z}
                      type="button"
                      onClick={() => setPatch((p) => ({ ...p, splash_headline_size: z }))}
                      className={`rounded px-2 py-1 text-xs font-bold uppercase ${cur("splash_headline_size", "l") === z ? "bg-white text-slate-900" : "bg-white/15 hover:bg-white/25"}`}
                    >
                      {z}
                    </button>
                  ))}
                  <span className="ml-1 text-white/50">(↑/↓)</span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="text-white/60">Font</span>
                  {fontRow("site_font")}
                </span>
              </>
            )}
            {selected === "__brand" && (
              <span className="flex items-center gap-1">
                <span className="text-white/60">Name font</span>
                {fontRow("brand_font")}
              </span>
            )}
            <span className="flex items-center gap-1">
              <span className="text-white/60">Hero text position</span>
              {ALIGNS.map((a) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setPatch((p) => ({ ...p, hero_align: a }))}
                  className={`rounded px-2 py-1 text-xs font-medium ${cur("hero_align", "left") === a ? "bg-white text-slate-900" : "bg-white/15 hover:bg-white/25"}`}
                >
                  {a}
                </button>
              ))}
              <span className="ml-1 text-white/50">(←/→)</span>
              <span className="ml-2 text-white/60">Treatment</span>
              {STYLES.map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setPatch((p) => ({ ...p, hero_style: st }))}
                  className={`rounded px-2 py-1 text-xs font-medium ${cur("hero_style", "open") === st ? "bg-white text-slate-900" : "bg-white/15 hover:bg-white/25"}`}
                >
                  {st}
                </button>
              ))}
            </span>
          </>
        )}
        <span className="ml-auto flex items-center gap-2">
          {error && <span className="text-xs text-rose-300">{error}</span>}
          {dirty && <span className="text-xs text-amber-300">{Object.keys(patch).length} unsaved</span>}
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
      </div>
      {/* Push the page down so the sticky site header isn't hidden under the bar. */}
      <div className="h-12" />
    </>
  );
}
