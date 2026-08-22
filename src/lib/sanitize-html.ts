import sanitizeLib, { type IOptions } from "sanitize-html";

/**
 * Sanitize article body HTML (site_posts.body_html) with a real ALLOWLIST HTML parser, run at
 * WRITE time so the public article page can render the stored HTML directly. Authors are org
 * staff (RLS-gated), and the feature invites pasting an SEO vendor's HTML — so this is the
 * load-bearing XSS control for a dangerouslySetInnerHTML sink, and it must be parser-based, not
 * regex (a regex denylist misses slash-separated handlers like `<img/src=x/onerror=…>`,
 * entity-encoded `javascript:`, `style` exfil, etc. — the reason we switched to sanitize-html).
 *
 * Allowed: editorial markup only. Dropped: script/style/iframe/form/…, ALL event handlers, any
 * non-http(s)/mailto/tel URL scheme (checked after entity-decoding), the `style` attribute.
 */
// Keep in lockstep with the section anchors the chrome/bands render (site-chrome, org-site).
const RESERVED_ANCHOR_IDS = new Set(["top", "work", "services", "reviews", "contact", "contact-form"]);

const OPTIONS: IOptions = {
  allowedTags: [
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "a", "ul", "ol", "li", "blockquote",
    "strong", "em", "b", "i", "u", "s", "sub", "sup", "br", "hr",
    "img", "figure", "figcaption",
    "pre", "code", "span", "div",
    "table", "thead", "tbody", "tr", "th", "td", "caption",
  ],
  allowedAttributes: {
    a: ["href", "name", "target", "rel"],
    img: ["src", "alt", "title", "width", "height", "loading"],
    "*": ["id"],
  },
  // URL schemes are validated after entity-decoding; javascript:/vbscript:/data:text-html can't survive.
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https"] },
  disallowedTagsMode: "discard",
  // External links open safely; INTERNAL links (site-relative "/..." or same-page "#...") stay
  // plain — forcing nofollow/_blank on them was nofollowing the site's own internal links, which
  // undercuts exactly the local-SEO internal-linking the article/page content exists for.
  // Protocol-relative "//host" is external. Scheme safety is enforced by allowedSchemes above
  // either way — this transform only decides rel/target, never what may load.
  transformTags: {
    // The chrome's load-bearing anchors (header/footer links, the contact CTA) must never be
    // hijackable by content html carrying the same id — first-in-DOM wins an anchor jump, and a
    // block sits above the footer (review: id="contact-form" in a text block strands the lead
    // CTA). Article/TOC deep links keep working; only these ids are reserved.
    "*": (tagName, attribs) => {
      if (attribs.id && RESERVED_ANCHOR_IDS.has(attribs.id.trim().toLowerCase())) {
        const { id: _reserved, ...rest } = attribs;
        return { tagName, attribs: rest };
      }
      return { tagName, attribs };
    },
    a: (tagName, attribs) => {
      const href = attribs.href || "";
      const internal = (href.startsWith("/") && !href.startsWith("//")) || href.startsWith("#");
      return internal
        ? { tagName, attribs }
        : { tagName, attribs: { ...attribs, rel: "noopener noreferrer nofollow", target: "_blank" } };
    },
  },
};

export function sanitizeHtml(html: string): string {
  return sanitizeLib(String(html || ""), OPTIONS).trim();
}

/**
 * THE MODEL LANE'S wash — stricter than the human editor's. The design pass's html must obey the
 * same laws as every other model output: no images (the own-library law has no way to check an
 * <img> URL buried in html) and no links (the on-site-link law likewise) — plain editorial
 * markup only, exactly what the studio prompt promises. Returns what survived plus whether
 * anything was removed, so the refusal can be NAMED (no silent drops).
 */
const MODEL_OPTIONS: IOptions = {
  allowedTags: ["p", "strong", "em", "b", "i", "u", "ul", "ol", "li", "br", "h3"],
  allowedAttributes: {},
  disallowedTagsMode: "discard",
};

export function sanitizeModelHtml(html: string): { html: string; removed: boolean } {
  const input = String(html || "");
  const out = sanitizeLib(input, MODEL_OPTIONS).trim();
  // Tag-scan for what the strict pass ate — links, images, or anything scripty.
  const removed = /<\s*(a|img|script|iframe|style|form|svg|video|audio|object|embed)\b/i.test(input);
  return { html: out, removed };
}

/** Plain text (no tags) pasted into the editor becomes clean paragraphs. */
export function textToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return String(text || "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br/>")}</p>`)
    .join("\n");
}
