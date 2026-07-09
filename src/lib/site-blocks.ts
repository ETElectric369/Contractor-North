/**
 * The block palette for the page builder. A page is an ordered list of these blocks; each renders
 * via a typed React component (see block-renderer.tsx) — NEVER freeform HTML — so a designer/owner
 * composes pages safely with zero XSS surface. Adding a NEW block type = add one entry here + a
 * renderer case + an editor case (the only thing that ever needs a developer).
 */
export type BlockType = "heading" | "text" | "image" | "button" | "gallery" | "banner" | "section";

/** The wired homepage sections you drop into the layout as-is — they render live org data / behavior
 *  (the gallery pulls your photos, contact captures leads, etc.), so they stay "smart" instead of
 *  becoming dumb content. Only offered on the homepage builder. */
export type SectionKey = "portfolio" | "reviews" | "contact" | "estimate";
export const SECTION_KEYS: SectionKey[] = ["portfolio", "reviews", "contact", "estimate"];
export const SECTION_PALETTE: { key: SectionKey; label: string; hint: string }[] = [
  { key: "portfolio", label: "Photo gallery", hint: "Your portfolio photos (auto-updates)" },
  { key: "reviews", label: "Reviews", hint: "Your customer reviews" },
  { key: "contact", label: "Contact form", hint: "A lead-capture form + your contact info" },
  { key: "estimate", label: "Estimate button", hint: "A band with your get-an-estimate button" },
];

/** The per-block styling "toolbox" — the safe, structured set of visual controls (no free CSS).
 *  align/size/font are enums; color is a validated #rrggbb hex (nothing else can be stored/rendered),
 *  so the styling surface adds real design control with zero injection risk. */
export type BlockStyle = {
  align?: "left" | "center" | "right";
  size?: "s" | "m" | "l" | "xl";
  font?: "sans" | "serif" | "mono";
  color?: string; // #rrggbb only (validated in normalizeBlocks AND re-checked in the renderer)
};

export type Block =
  | { type: "heading"; props: { text: string; align?: "left" | "center" }; style?: BlockStyle }
  | { type: "text"; props: { html: string }; style?: BlockStyle } // html sanitized at write + read
  | { type: "image"; props: { url: string; alt?: string; caption?: string }; style?: BlockStyle }
  | { type: "button"; props: { label: string; href: string; align?: "left" | "center" }; style?: BlockStyle }
  | { type: "gallery"; props: { images: { url: string; alt?: string }[] }; style?: BlockStyle }
  // A full-width band with a background image + dark overlay + centered heading/text/button.
  | { type: "banner"; props: { bgUrl: string; heading: string; text?: string; buttonLabel?: string; buttonHref?: string }; style?: BlockStyle }
  // A wired homepage section (renders live org data / behavior) — see SectionKey.
  | { type: "section"; props: { key: SectionKey }; style?: BlockStyle };

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Coerce arbitrary jsonb into a safe BlockStyle — every field enum-checked, color hex-validated. */
export function coerceStyle(raw: unknown): BlockStyle | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const s: BlockStyle = {};
  if (r.align === "left" || r.align === "center" || r.align === "right") s.align = r.align;
  if (r.size === "s" || r.size === "m" || r.size === "l" || r.size === "xl") s.size = r.size;
  if (r.font === "sans" || r.font === "serif" || r.font === "mono") s.font = r.font;
  if (typeof r.color === "string" && HEX_COLOR.test(r.color)) s.color = r.color.toLowerCase();
  return Object.keys(s).length ? s : undefined;
}

/** Editor metadata: label + a fresh default block for the "add block" palette. */
export const BLOCK_PALETTE: { type: BlockType; label: string; hint: string; make: () => Block }[] = [
  { type: "heading", label: "Heading", hint: "A section title", make: () => ({ type: "heading", props: { text: "", align: "left" } }) },
  { type: "text", label: "Text", hint: "A paragraph of copy", make: () => ({ type: "text", props: { html: "" } }) },
  { type: "image", label: "Image", hint: "A single photo + caption", make: () => ({ type: "image", props: { url: "", alt: "", caption: "" } }) },
  { type: "button", label: "Button", hint: "A call-to-action link", make: () => ({ type: "button", props: { label: "", href: "", align: "left" } }) },
  { type: "gallery", label: "Gallery", hint: "A grid of photos", make: () => ({ type: "gallery", props: { images: [] } }) },
  { type: "banner", label: "Banner", hint: "A background image with text over it", make: () => ({ type: "banner", props: { bgUrl: "", heading: "", text: "", buttonLabel: "", buttonHref: "" } }) },
];

// Caps enforced at the normalization chokepoint that BOTH the public read (getPublicPageBySlug) and
// the write action pass through — so a page's render cost is bounded no matter how the row was
// written (incl. a direct PostgREST write that skips the action). Prevents a limited-trust collaborator
// from storing a giant array that re-parses + emits an <img> each on every uncached /p/<slug> request.
const MAX_BLOCKS = 60;
const MAX_GALLERY_IMAGES = 48;
const MAX_HTML_LEN = 40_000;
const MAX_TEXT_LEN = 2_000; // headings, labels, urls, alts, captions

const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** Coerce arbitrary stored jsonb into a safe, bounded Block[] — drops unknown types + malformed
 *  shapes and caps sizes so a bad/legacy/hostile value can never crash or overload the renderer. */
export function normalizeBlocks(raw: unknown): Block[] {
  if (!Array.isArray(raw)) return [];
  const out: Block[] = [];
  for (const b of raw.slice(0, MAX_BLOCKS)) {
    if (!b || typeof b !== "object") continue;
    const type = (b as { type?: unknown }).type;
    const props = ((b as { props?: unknown }).props ?? {}) as Record<string, unknown>;
    const style = coerceStyle((b as { style?: unknown }).style);
    switch (type) {
      case "heading":
        out.push({ type, props: { text: cap(String(props.text ?? ""), MAX_TEXT_LEN), align: props.align === "center" ? "center" : "left" }, style });
        break;
      case "text":
        out.push({ type, props: { html: cap(String(props.html ?? ""), MAX_HTML_LEN) }, style });
        break;
      case "image":
        out.push({ type, props: { url: cap(String(props.url ?? ""), MAX_TEXT_LEN), alt: cap(String(props.alt ?? ""), MAX_TEXT_LEN), caption: cap(String(props.caption ?? ""), MAX_TEXT_LEN) }, style });
        break;
      case "button":
        out.push({ type, props: { label: cap(String(props.label ?? ""), MAX_TEXT_LEN), href: cap(String(props.href ?? ""), MAX_TEXT_LEN), align: props.align === "center" ? "center" : "left" }, style });
        break;
      case "gallery": {
        const images = Array.isArray(props.images)
          ? (props.images as unknown[])
              .filter((i) => i && typeof i === "object")
              .map((i) => ({ url: cap(String((i as Record<string, unknown>).url ?? ""), MAX_TEXT_LEN), alt: cap(String((i as Record<string, unknown>).alt ?? ""), MAX_TEXT_LEN) }))
              .filter((i) => i.url)
              .slice(0, MAX_GALLERY_IMAGES)
          : [];
        out.push({ type, props: { images }, style });
        break;
      }
      case "banner":
        out.push({
          type,
          props: {
            bgUrl: cap(String(props.bgUrl ?? ""), MAX_TEXT_LEN),
            heading: cap(String(props.heading ?? ""), MAX_TEXT_LEN),
            text: cap(String(props.text ?? ""), MAX_TEXT_LEN),
            buttonLabel: cap(String(props.buttonLabel ?? ""), MAX_TEXT_LEN),
            buttonHref: cap(String(props.buttonHref ?? ""), MAX_TEXT_LEN),
          },
          style,
        });
        break;
      case "section":
        if (SECTION_KEYS.includes(props.key as SectionKey)) out.push({ type, props: { key: props.key as SectionKey }, style });
        break;
      default:
        break; // unknown block type → dropped
    }
  }
  return out;
}
