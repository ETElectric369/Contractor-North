"use client";

import { useCallback, useEffect, useState } from "react";
import { X, ChevronLeft, ChevronRight } from "lucide-react";

export type PortfolioPhoto = { url: string; caption?: string };

/**
 * Public "our recent work" gallery. Photos are North-owned public storage URLs (re-hosted from
 * the old site). Responsive grid + a keyboard-navigable lightbox. Each photo may carry an optional
 * caption — shown on hover over the tile and under the image in the lightbox. Renders nothing when
 * there are no photos. `orgName` keeps the alt text on-brand (this component is shared across orgs).
 */
export function PortfolioGallery({
  photos,
  brand,
  orgName = "Our",
}: {
  photos: PortfolioPhoto[];
  brand: string;
  orgName?: string;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const n = photos.length;

  const move = useCallback((d: number) => setOpen((i) => (i == null ? i : (i + d + n) % n)), [n]);

  useEffect(() => {
    if (open == null) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
      else if (e.key === "ArrowRight") move(1);
      else if (e.key === "ArrowLeft") move(-1);
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [open, move]);

  if (!n) return null;

  const alt = (p: PortfolioPhoto, i: number) => p.caption || `${orgName} project ${i + 1}`;

  return (
    <section className="mx-auto max-w-5xl px-4 pb-16">
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="text-xl font-extrabold tracking-tight text-slate-900">Our recent work</h2>
        <span className="text-sm text-slate-400">{n} project{n === 1 ? "" : "s"}</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {photos.map((p, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setOpen(i)}
            className="group relative aspect-square overflow-hidden rounded-xl bg-slate-100 focus:outline-none focus:ring-2"
            style={{ ["--tw-ring-color" as string]: brand } as React.CSSProperties}
            aria-label={p.caption ? p.caption : `View project photo ${i + 1}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={p.url}
              alt={alt(p, i)}
              loading="lazy"
              className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
            />
            {p.caption && (
              <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2.5 text-left text-xs font-medium leading-snug text-white opacity-0 transition group-hover:opacity-100">
                {p.caption}
              </span>
            )}
          </button>
        ))}
      </div>

      {open != null && (
        <div
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/90 p-4"
          onClick={() => setOpen(null)}
          role="dialog"
          aria-modal="true"
        >
          <button type="button" onClick={() => setOpen(null)} className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20" aria-label="Close">
            <X className="h-6 w-6" />
          </button>
          {n > 1 && (
            <>
              <button type="button" onClick={(e) => { e.stopPropagation(); move(-1); }} className="absolute left-2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 sm:left-6" aria-label="Previous">
                <ChevronLeft className="h-7 w-7" />
              </button>
              <button type="button" onClick={(e) => { e.stopPropagation(); move(1); }} className="absolute right-2 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 sm:right-6" aria-label="Next">
                <ChevronRight className="h-7 w-7" />
              </button>
            </>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photos[open].url}
            alt={alt(photos[open], open)}
            className="max-h-[80vh] max-w-full rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          {photos[open].caption && (
            <p className="mt-4 max-w-xl px-4 text-center text-sm text-white/85" onClick={(e) => e.stopPropagation()}>
              {photos[open].caption}
            </p>
          )}
          <span className="absolute bottom-4 text-sm text-white/70">{open + 1} / {n}</span>
        </div>
      )}
    </section>
  );
}
