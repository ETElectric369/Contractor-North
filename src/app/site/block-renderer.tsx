import Link from "next/link";
import type { Block, BlockStyle } from "@/lib/site-blocks";

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

// ── The per-block styling toolbox → classes/inline. Every value is a fixed enum except color, which
// is re-validated to #rrggbb HERE too (defense in depth) before it ever reaches a style attribute. ──
const HEX = /^#[0-9a-f]{6}$/i;
const alignCls = (s?: BlockStyle) => (s?.align === "center" ? "text-center" : s?.align === "right" ? "text-right" : "text-left");
const fontCls = (s?: BlockStyle) => (s?.font === "serif" ? "font-serif" : s?.font === "mono" ? "font-mono" : "");
const safeColor = (s?: BlockStyle) => (s?.color && HEX.test(s.color) ? s.color : undefined);
const HEADING_SIZE = { s: "text-lg sm:text-xl", m: "text-xl sm:text-2xl", l: "text-2xl sm:text-3xl", xl: "text-3xl sm:text-4xl" } as const;
const TEXT_SIZE = { s: "text-sm", m: "text-base", l: "text-[1.05rem]", xl: "text-lg" } as const;
const BUTTON_SIZE = { s: "px-4 py-2 text-sm", m: "px-5 py-2.5 text-sm", l: "px-6 py-3 text-base", xl: "px-8 py-4 text-lg" } as const;

/**
 * Renders a page's blocks. Every block is a typed component — no freeform HTML — so collaborator- or
 * owner-authored page content is safe by construction: text is sanitized at write AND read (the ONLY
 * dangerouslySetInnerHTML sink); all other values render through React (escaped); link/image URLs are
 * scheme-checked; and the styling toolbox (align/size/font/color) is enum + hex-validated.
 */
export function BlockRenderer({ blocks, brand }: { blocks: Block[]; brand: string }) {
  return (
    <div className="mx-auto max-w-3xl space-y-8 px-4 py-12">
      {blocks.map((b, i) => {
        const st = b.style;
        switch (b.type) {
          case "heading":
            return (
              <h2
                key={i}
                className={`font-bold tracking-tight text-slate-900 ${HEADING_SIZE[st?.size ?? "l"]} ${fontCls(st)} ${alignCls(st ?? { align: b.props.align })}`}
                style={{ color: safeColor(st) }}
              >
                {b.props.text}
              </h2>
            );
          case "text":
            return (
              // Sanitized at write AND on read (getPublicPageBySlug) — the single raw-HTML sink.
              <div
                key={i}
                className={`space-y-4 leading-relaxed text-slate-700 ${TEXT_SIZE[st?.size ?? "l"]} ${fontCls(st)} ${alignCls(st)} [&_a]:underline [&_h3]:mt-6 [&_h3]:text-xl [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc`}
                style={{ color: safeColor(st) }}
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
                {b.props.caption && <figcaption className={`text-sm text-slate-500 ${alignCls(st) === "text-left" ? "text-center" : alignCls(st)}`}>{b.props.caption}</figcaption>}
              </figure>
            );
          }
          case "button": {
            if (!b.props.label) return null;
            const align = alignCls(st ?? { align: b.props.align });
            return (
              <div key={i} className={align}>
                <Link
                  href={safeHref(b.props.href)}
                  className={`inline-block rounded-lg font-semibold text-white shadow-sm ${BUTTON_SIZE[st?.size ?? "l"]} ${fontCls(st)}`}
                  style={{ backgroundColor: safeColor(st) ?? brand }}
                >
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
          case "banner": {
            const bg = safeImg(b.props.bgUrl);
            if (!b.props.heading && !b.props.text && !bg) return null;
            return (
              <div key={i} className="relative isolate overflow-hidden rounded-2xl bg-slate-800">
                {bg && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={bg} alt="" aria-hidden className="absolute inset-0 -z-10 h-full w-full object-cover" />
                )}
                <div className="absolute inset-0 -z-10 bg-black/45" />
                <div className="px-6 py-20 text-center text-white sm:py-24">
                  {b.props.heading && <h2 className={`font-bold tracking-tight ${HEADING_SIZE[st?.size ?? "l"]} ${fontCls(st)}`}>{b.props.heading}</h2>}
                  {b.props.text && <p className="mx-auto mt-3 max-w-xl text-lg text-white/90">{b.props.text}</p>}
                  {b.props.buttonLabel && (
                    <Link href={safeHref(b.props.buttonHref ?? "")} className="mt-6 inline-block rounded-lg px-6 py-3 text-base font-semibold text-white shadow-sm" style={{ backgroundColor: safeColor(st) ?? brand }}>
                      {b.props.buttonLabel}
                    </Link>
                  )}
                </div>
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
