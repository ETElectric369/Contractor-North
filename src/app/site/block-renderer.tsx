import Link from "next/link";
import type { Block } from "@/lib/site-blocks";

/** Only http(s)/mailto/tel or a same-site relative path may become a link/image src — a collaborator
 *  can't slip a javascript:/data: scheme into a button href or image. Anything else → "#". */
function safeHref(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return "#";
  if (/^\/(?!\/)/.test(s)) return s; // relative path (but not protocol-relative //)
  if (/^(https?:|mailto:|tel:)/i.test(s)) return s;
  return "#";
}
function safeImg(raw: string): string {
  const s = String(raw ?? "").trim();
  return /^\/(?!\/)/.test(s) || /^https?:/i.test(s) ? s : "";
}

/**
 * Renders a page's blocks. Every block is a typed component — no freeform HTML — so collaborator- or
 * owner-authored page content is safe by construction: text is sanitized at write (like articles)
 * and rendered as the ONLY dangerouslySetInnerHTML sink; all other values render through React
 * (escaped); link/image URLs are scheme-checked.
 */
export function BlockRenderer({ blocks, brand }: { blocks: Block[]; brand: string }) {
  return (
    <div className="mx-auto max-w-3xl space-y-8 px-4 py-12">
      {blocks.map((b, i) => {
        switch (b.type) {
          case "heading":
            return (
              <h2 key={i} className={`text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl ${b.props.align === "center" ? "text-center" : ""}`}>
                {b.props.text}
              </h2>
            );
          case "text":
            return (
              // Sanitized at write (sanitizeHtml) — the single raw-HTML sink, same as articles.
              <div
                key={i}
                className="space-y-4 text-[1.05rem] leading-relaxed text-slate-700 [&_a]:underline [&_h3]:mt-6 [&_h3]:text-xl [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc"
                dangerouslySetInnerHTML={{ __html: b.props.html }}
              />
            );
          case "image": {
            const src = safeImg(b.props.url);
            if (!src) return null;
            return (
              <figure key={i} className="space-y-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={src} alt={b.props.alt || ""} className="w-full rounded-2xl object-cover" />
                {b.props.caption && <figcaption className="text-center text-sm text-slate-500">{b.props.caption}</figcaption>}
              </figure>
            );
          }
          case "button": {
            if (!b.props.label) return null;
            return (
              <div key={i} className={b.props.align === "center" ? "text-center" : ""}>
                <Link href={safeHref(b.props.href)} className="inline-block rounded-lg px-6 py-3 text-base font-semibold text-white shadow-sm" style={{ backgroundColor: brand }}>
                  {b.props.label}
                </Link>
              </div>
            );
          }
          case "gallery": {
            const imgs = b.props.images.map((im) => ({ src: safeImg(im.url), alt: im.alt || "" })).filter((im) => im.src);
            if (!imgs.length) return null;
            return (
              <div key={i} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {imgs.map((im, j) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img key={j} src={im.src} alt={im.alt} className="aspect-square w-full rounded-xl object-cover" />
                ))}
              </div>
            );
          }
          default:
            return null;
        }
      })}
    </div>
  );
}
