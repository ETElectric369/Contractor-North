import { Fragment } from "react";
import Link from "next/link";
import type { Block, BlockStyle } from "@/lib/site-blocks";
import { imageSrcSet, sizedImage } from "@/lib/site-image";

/** Only http(s)/mailto/tel or a same-site relative path may become a link/image src — a collaborator
 *  can't slip a javascript:/data: scheme into a button href or image. Anything else → "#". */
function safeHref(raw: string): string {
  const s = String(raw ?? "").trim();
  if (!s) return "#";
  if (/^#[a-z0-9]/i.test(s)) return s; // same-page anchor (e.g. #contact-form)
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
// Per-block vertical breathing room (style.pad) — the per-section spacing lever. Applied as extra
// padding INSIDE the block's slot, on top of the page's uniform space-y rhythm.
const PAD_CLS = { s: "py-0", m: "py-6", l: "py-14" } as const;

/**
 * Renders a page's blocks. Every block is a typed component — no freeform HTML — so collaborator- or
 * owner-authored page content is safe by construction: the text and split blocks' html is sanitized
 * at write AND read (the only two dangerouslySetInnerHTML sinks); all other values render through React (escaped); link/image URLs are
 * scheme-checked; and the styling toolbox (align/size/font/color) is enum + hex-validated.
 */
export function BlockRenderer({ blocks, brand }: { blocks: Block[]; brand: string }) {
  return (
    <div className="mx-auto max-w-3xl space-y-8 px-4 py-12">
      {blocks.map((b, i) => {
        const st = b.style;
        // style.pad wraps EVERY block uniformly (review: it was advertised for all, rendered on
        // one — the exact "it didn't listen" failure the studio wave exists to kill). "s"/absent
        // adds nothing, so existing pages render byte-identically.
        const node = (() => {
        switch (b.type) {
          case "heading":
            return (
              <h2
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
                className={`space-y-4 leading-relaxed text-slate-700 ${TEXT_SIZE[st?.size ?? "l"]} ${fontCls(st)} ${alignCls(st)} [&_a]:underline [&_h3]:mt-6 [&_h3]:text-xl [&_h3]:font-semibold [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc`}
                style={{ color: safeColor(st) }}
                dangerouslySetInnerHTML={{ __html: b.props.html }}
              />
            );
          case "image": {
            const src = safeImg(b.props.url);
            if (!src) return null;
            return (
              <figure className="space-y-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={sizedImage(src, 1280)}
                  srcSet={imageSrcSet(src, [640, 1280])}
                  sizes="(min-width: 768px) 768px, 100vw"
                  alt={b.props.alt || ""}
                  loading="lazy"
                  decoding="async"
                  className="w-full rounded-2xl object-cover"
                />
                {b.props.caption && <figcaption className={`text-sm text-slate-500 ${alignCls(st) === "text-left" ? "text-center" : alignCls(st)}`}>{b.props.caption}</figcaption>}
              </figure>
            );
          }
          case "button": {
            if (!b.props.label) return null;
            const align = alignCls(st ?? { align: b.props.align });
            return (
              <div className={align}>
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
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {imgs.map((im, j) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={j}
                    src={sizedImage(im.src, 640)}
                    srcSet={imageSrcSet(im.src, [320, 640])}
                    sizes="(min-width: 640px) 33vw, 50vw"
                    alt={im.alt}
                    loading="lazy"
                    decoding="async"
                    className="aspect-square w-full rounded-xl object-cover"
                  />
                ))}
              </div>
            );
          }
          case "banner": {
            const bg = safeImg(b.props.bgUrl);
            if (!b.props.heading && !b.props.text && !bg) return null;
            return (
              <div className="relative isolate overflow-hidden rounded-2xl bg-slate-800">
                {bg && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={sizedImage(bg, 1280)}
                    srcSet={imageSrcSet(bg, [640, 1280])}
                    sizes="(min-width: 768px) 768px, 100vw"
                    alt=""
                    aria-hidden
                    loading="lazy"
                    decoding="async"
                    className="absolute inset-0 -z-10 h-full w-full object-cover"
                  />
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
          case "split": {
            const src = safeImg(b.props.url);
            if (!src && !b.props.heading && !b.props.html) return null;
            const img = src && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={sizedImage(src, 960)}
                srcSet={imageSrcSet(src, [480, 960])}
                sizes="(min-width: 768px) 384px, 100vw"
                alt={b.props.heading || ""}
                loading="lazy"
                decoding="async"
                className="h-full w-full rounded-2xl object-cover"
              />
            );
            return (
              <div className={`grid items-center gap-6 ${src ? "sm:grid-cols-2" : ""}`}>
                {src && b.props.imageSide !== "right" && <div className="max-h-96 overflow-hidden rounded-2xl">{img}</div>}
                <div>
                  {b.props.heading && (
                    <h2 className={`font-bold tracking-tight text-slate-900 ${HEADING_SIZE[st?.size ?? "l"]} ${fontCls(st)}`} style={{ color: safeColor(st) }}>
                      {b.props.heading}
                    </h2>
                  )}
                  {b.props.html && (
                    // Same raw-HTML lane as the text block — sanitized at the read boundary
                    // (renderReadyBlocks washes split.html exactly like text.html).
                    <div
                      className="mt-3 space-y-3 leading-relaxed text-slate-700 [&_a]:underline [&_li]:ml-5 [&_ol]:list-decimal [&_ul]:list-disc"
                      dangerouslySetInnerHTML={{ __html: b.props.html }}
                    />
                  )}
                </div>
                {src && b.props.imageSide === "right" && <div className="max-h-96 overflow-hidden rounded-2xl">{img}</div>}
              </div>
            );
          }
          case "section":
            // A wired section (gallery/reviews/contact/estimate). The real thing renders on the
            // homepage via HomeBlockRenderer (which has org data); here (editor preview / a stray
            // section on a plain page) show a labeled placeholder so it's clear what will appear.
            return (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 px-4 py-10 text-center text-sm font-medium text-slate-400">
                {b.props.key === "portfolio" ? "Photo gallery" : b.props.key === "reviews" ? "Reviews" : b.props.key === "contact" ? "Contact form" : b.props.key === "services" ? "Services grid" : b.props.key === "specialty" ? "Specialty showcase" : "Estimate button"} — shown live on your homepage
              </div>
            );
          default:
            return null;
        }
        })();
        if (!node) return null;
        const pad = st?.pad;
        return pad === "m" || pad === "l" ? (
          <div key={i} className={PAD_CLS[pad]}>
            {node}
          </div>
        ) : (
          <Fragment key={i}>{node}</Fragment>
        );
      })}
    </div>
  );
}
