"use client";

import { useCallback, useEffect, useState } from "react";
import { X, ChevronLeft, ChevronRight } from "lucide-react";

/**
 * Public "our recent work" gallery for the estimate configurator. Photos are North-owned
 * public storage URLs (re-hosted from the old site). Responsive grid + a keyboard-navigable
 * lightbox. Renders nothing when there are no photos.
 */
export function PortfolioGallery({ photos, brand }: { photos: string[]; brand: string }) {
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

  return (
    <section className="mx-auto max-w-5xl px-4 pb-16">
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="text-xl font-extrabold tracking-tight text-slate-900">Our recent work</h2>
        <span className="text-sm text-slate-400">{n} projects</span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {photos.map((src, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setOpen(i)}
            className="group relative aspect-square overflow-hidden rounded-xl bg-slate-100 focus:outline-none focus:ring-2"
            style={{ ["--tw-ring-color" as string]: brand } as React.CSSProperties}
            aria-label={`View project photo ${i + 1}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={`Tahoe Deck project ${i + 1}`}
              loading="lazy"
              className="h-full w-full object-cover transition duration-300 group-hover:scale-105"
            />
          </button>
        ))}
      </div>

      {open != null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4"
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
            src={photos[open]}
            alt={`Tahoe Deck project ${open + 1}`}
            className="max-h-[85vh] max-w-full rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <span className="absolute bottom-4 text-sm text-white/70">{open + 1} / {n}</span>
        </div>
      )}
    </section>
  );
}
