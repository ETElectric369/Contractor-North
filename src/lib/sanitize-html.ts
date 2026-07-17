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
