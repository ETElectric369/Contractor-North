/**
 * The block palette for the page builder. A page is an ordered list of these blocks; each renders
 * via a typed React component (see block-renderer.tsx) — NEVER freeform HTML — so a designer/owner
 * composes pages safely with zero XSS surface. Adding a NEW block type = add one entry here + a
 * renderer case + an editor case (the only thing that ever needs a developer).
 */
export type BlockType = "heading" | "text" | "image" | "button" | "gallery";

export type Block =
  | { type: "heading"; props: { text: string; align?: "left" | "center" } }
  | { type: "text"; props: { html: string } } // sanitized at write
  | { type: "image"; props: { url: string; alt?: string; caption?: string } }
  | { type: "button"; props: { label: string; href: string; align?: "left" | "center" } }
  | { type: "gallery"; props: { images: { url: string; alt?: string }[] } };

/** Editor metadata: label + a fresh default block for the "add block" palette. */
export const BLOCK_PALETTE: { type: BlockType; label: string; hint: string; make: () => Block }[] = [
  { type: "heading", label: "Heading", hint: "A section title", make: () => ({ type: "heading", props: { text: "", align: "left" } }) },
  { type: "text", label: "Text", hint: "A paragraph of copy", make: () => ({ type: "text", props: { html: "" } }) },
  { type: "image", label: "Image", hint: "A single photo + caption", make: () => ({ type: "image", props: { url: "", alt: "", caption: "" } }) },
  { type: "button", label: "Button", hint: "A call-to-action link", make: () => ({ type: "button", props: { label: "", href: "", align: "left" } }) },
  { type: "gallery", label: "Gallery", hint: "A grid of photos", make: () => ({ type: "gallery", props: { images: [] } }) },
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
    switch (type) {
      case "heading":
        out.push({ type, props: { text: cap(String(props.text ?? ""), MAX_TEXT_LEN), align: props.align === "center" ? "center" : "left" } });
        break;
      case "text":
        out.push({ type, props: { html: cap(String(props.html ?? ""), MAX_HTML_LEN) } });
        break;
      case "image":
        out.push({ type, props: { url: cap(String(props.url ?? ""), MAX_TEXT_LEN), alt: cap(String(props.alt ?? ""), MAX_TEXT_LEN), caption: cap(String(props.caption ?? ""), MAX_TEXT_LEN) } });
        break;
      case "button":
        out.push({ type, props: { label: cap(String(props.label ?? ""), MAX_TEXT_LEN), href: cap(String(props.href ?? ""), MAX_TEXT_LEN), align: props.align === "center" ? "center" : "left" } });
        break;
      case "gallery": {
        const images = Array.isArray(props.images)
          ? (props.images as unknown[])
              .filter((i) => i && typeof i === "object")
              .map((i) => ({ url: cap(String((i as Record<string, unknown>).url ?? ""), MAX_TEXT_LEN), alt: cap(String((i as Record<string, unknown>).alt ?? ""), MAX_TEXT_LEN) }))
              .filter((i) => i.url)
              .slice(0, MAX_GALLERY_IMAGES)
          : [];
        out.push({ type, props: { images } });
        break;
      }
      default:
        break; // unknown block type → dropped
    }
  }
  return out;
}
