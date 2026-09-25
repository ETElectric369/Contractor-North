"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, FileText, X } from "lucide-react";
import { useModalLock } from "@/components/ui/modal-lock";
import type { PortalPhoto, PortalPick } from "@/lib/portal/job-view-shape";
import { fmtDay } from "./portal-format";

/**
 * THE CUSTOMER'S PHOTOS AND PICKS: a grid that opens into a full-screen viewer.
 *
 * Every URL here is a 10-minute signed URL the server minted for exactly the photos and pick files
 * the office chose (job-view.ts). Nothing is listed, nothing is fetched from here but those.
 *
 * The viewer is a native <dialog> opened with showModal(): the browser traps focus inside it,
 * Escape closes it, and the page behind is inert to a screen reader. On close, focus goes back to
 * the tile that opened it. Arrow keys and a sideways swipe step through the photos. Motion is a
 * fade only, and none at all under reduced motion.
 */

function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useModalLock(open);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      try {
        d.showModal();
      } catch {
        d.setAttribute("open", "");
      }
    } else if (!open && d.open) d.close();
  }, [open]);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    d.addEventListener("cancel", onCancel);
    return () => d.removeEventListener("cancel", onCancel);
  }, [onClose]);
  return ref;
}

const iconBtn =
  "inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white hover:bg-white/25 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white";

// ── photos ───────────────────────────────────────────────────────────────────────────────────

export function PortalPhotos({ photos, thisYear }: { photos: PortalPhoto[]; thisYear: string }) {
  const [at, setAt] = useState<number | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => {
    setAt(null);
    // Back to the tile that opened it, so a keyboard user keeps their place.
    requestAnimationFrame(() => opener.current?.focus());
  }, []);
  const dialog = useDialog(at !== null, close);
  const step = useCallback(
    (dir: 1 | -1) => setAt((i) => (i === null ? i : (i + dir + photos.length) % photos.length)),
    [photos.length],
  );
  const touchX = useRef<number | null>(null);

  const label = (p: PortalPhoto, i: number) => `Photo ${i + 1} of ${photos.length}${p.takenOn ? `, taken ${fmtDay(p.takenOn, thisYear)}` : ""}`;
  const cur = at !== null ? photos[at] : null;

  return (
    <>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        {photos.map((p, i) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={(e) => {
                opener.current = e.currentTarget;
                setAt(i);
              }}
              className="group relative block aspect-square w-full overflow-hidden rounded-xl bg-white/60 shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--glass-ink))]"
              aria-label={`Open ${label(p, i)}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.url} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover motion-safe:transition-transform motion-safe:group-hover:scale-[1.03]" />
              {p.takenOn ? (
                <span className="absolute bottom-1.5 left-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-xs font-medium text-white">{fmtDay(p.takenOn, thisYear)}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>

      <dialog
        ref={dialog}
        aria-label={cur ? label(cur, at!) : "Photo"}
        className="portal-dialog m-0 h-dvh border-0 max-h-none w-screen max-w-none bg-transparent p-0 text-white"
        onKeyDown={(e) => {
          if (e.key === "ArrowRight") step(1);
          else if (e.key === "ArrowLeft") step(-1);
        }}
      >
        {cur ? (
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-[max(0.75rem,env(safe-area-inset-top))]">
              <span className="text-sm font-medium" aria-live="polite">
                {label(cur, at!)}
              </span>
              <button type="button" onClick={close} className={iconBtn} aria-label="Close" autoFocus>
                <X className="h-6 w-6" aria-hidden />
              </button>
            </div>
            <div
              className="relative flex flex-1 items-center justify-center overflow-hidden px-2"
              onClick={(e) => e.target === e.currentTarget && close()}
              onTouchStart={(e) => (touchX.current = e.touches[0]?.clientX ?? null)}
              onTouchEnd={(e) => {
                const x0 = touchX.current;
                const x1 = e.changedTouches[0]?.clientX;
                touchX.current = null;
                if (x0 == null || x1 == null || Math.abs(x1 - x0) < 50) return;
                step(x1 < x0 ? 1 : -1);
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img key={cur.id} src={cur.url} alt={label(cur, at!)} className="max-h-full max-w-full rounded-lg object-contain motion-safe:animate-[cn-fade_0.16s_ease-out_both]" />
            </div>
            {photos.length > 1 ? (
              <div className="flex items-center justify-center gap-6 px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-2">
                <button type="button" onClick={() => step(-1)} className={iconBtn} aria-label="Previous photo">
                  <ChevronLeft className="h-6 w-6" aria-hidden />
                </button>
                <button type="button" onClick={() => step(1)} className={iconBtn} aria-label="Next photo">
                  <ChevronRight className="h-6 w-6" aria-hidden />
                </button>
              </div>
            ) : (
              <div className="pb-[max(1rem,env(safe-area-inset-bottom))]" />
            )}
          </div>
        ) : null}
      </dialog>
    </>
  );
}

// ── picks ────────────────────────────────────────────────────────────────────────────────────

/** A pick's swatch, picture or PDF mark at a given size. */
function PickVisual({ p, big = false }: { p: PortalPick; big?: boolean }) {
  const box = big ? "h-48 w-full rounded-xl" : "h-16 w-16 rounded-xl";
  if (p.file?.kind === "image") {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={p.file.url} alt="" loading="lazy" decoding="async" className={`${box} shrink-0 bg-white object-cover`} />;
  }
  if (p.colorHex) {
    return <span aria-hidden className={`${box} block shrink-0 border border-black/10 shadow-inner`} style={{ backgroundColor: p.colorHex }} />;
  }
  return (
    <span aria-hidden className={`${box} flex shrink-0 items-center justify-center bg-white/80 text-[rgb(var(--glass-ink))]`}>
      <FileText className={big ? "h-12 w-12" : "h-7 w-7"} />
    </span>
  );
}

function pickTitle(p: PortalPick): string {
  return p.name || p.code || p.brand || p.category;
}

export function PortalPicks({ picks }: { picks: PortalPick[] }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => {
    setOpenId(null);
    requestAnimationFrame(() => opener.current?.focus());
  }, []);
  const dialog = useDialog(openId !== null, close);
  const cur = picks.find((p) => p.id === openId) ?? null;

  // Grouped by category, in the order the office put them.
  const groups: { category: string; items: PortalPick[] }[] = [];
  for (const p of picks) {
    const g = groups.find((x) => x.category.toLowerCase() === p.category.toLowerCase());
    if (g) g.items.push(p);
    else groups.push({ category: p.category, items: [p] });
  }

  return (
    <>
      <div className="space-y-4">
        {groups.map((g) => (
          <div key={g.category}>
            <h3 className="mb-1.5 px-1 text-xs font-semibold uppercase tracking-wide text-slate-600">{g.category}</h3>
            {/* minmax(0,1fr) columns, so a long product code truncates instead of widening the page. */}
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {g.items.map((p) => (
                <li key={p.id} className="min-w-0">
                  <button
                    type="button"
                    onClick={(e) => {
                      opener.current = e.currentTarget;
                      setOpenId(p.id);
                    }}
                    className="portal-glass flex w-full items-center gap-3 rounded-2xl p-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--glass-ink))]"
                    aria-label={`${g.category}: ${pickTitle(p)}${p.location ? `, ${p.location}` : ""}. Open`}
                  >
                    <PickVisual p={p} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-slate-900">{pickTitle(p)}</span>
                      <span className="block truncate text-sm text-slate-700">
                        {[p.brand && p.brand !== pickTitle(p) ? p.brand : null, p.code && p.code !== pickTitle(p) ? p.code : null].filter(Boolean).join(" · ")}
                      </span>
                      {p.location ? <span className="block truncate text-xs text-slate-600">{p.location}</span> : null}
                    </span>
                    <ChevronRight className="h-5 w-5 shrink-0 text-[rgb(var(--glass-ink))]" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <dialog
        ref={dialog}
        aria-label={cur ? `${cur.category}: ${pickTitle(cur)}` : "Pick"}
        className="portal-dialog m-auto border-0 w-[min(32rem,calc(100vw-2rem))] max-h-[calc(100dvh-2rem)] overflow-auto rounded-2xl bg-white p-0 text-slate-900 shadow-2xl"
      >
        {cur ? (
          <div className="p-4">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold uppercase tracking-wide text-[rgb(var(--glass-ink))]">{cur.category}</div>
                <h3 className="text-lg font-bold leading-snug">{pickTitle(cur)}</h3>
              </div>
              <button
                type="button"
                onClick={close}
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-700 hover:bg-slate-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--glass-ink))]"
                aria-label="Close"
                autoFocus
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>
            <PickVisual p={cur} big />
            {cur.colorHex && cur.file?.kind === "image" ? (
              <div className="mt-2 flex items-center gap-2 text-sm text-slate-700">
                <span aria-hidden className="h-6 w-6 rounded-md border border-black/10" style={{ backgroundColor: cur.colorHex }} />
                Swatch {cur.colorHex}
              </div>
            ) : null}
            <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
              {cur.brand ? (
                <>
                  <dt className="text-slate-600">Brand</dt>
                  <dd className="font-medium">{cur.brand}</dd>
                </>
              ) : null}
              {cur.name ? (
                <>
                  <dt className="text-slate-600">Name</dt>
                  <dd className="font-medium">{cur.name}</dd>
                </>
              ) : null}
              {cur.code ? (
                <>
                  <dt className="text-slate-600">Code</dt>
                  <dd className="font-medium">{cur.code}</dd>
                </>
              ) : null}
              {cur.location ? (
                <>
                  <dt className="text-slate-600">Where</dt>
                  <dd className="font-medium">{cur.location}</dd>
                </>
              ) : null}
              {cur.colorHex && cur.file?.kind !== "image" ? (
                <>
                  <dt className="text-slate-600">Swatch</dt>
                  <dd className="font-medium">{cur.colorHex}</dd>
                </>
              ) : null}
            </dl>
            {cur.note ? <p className="mt-3 whitespace-pre-wrap rounded-xl bg-slate-50 px-3 py-2 text-sm text-slate-800">{cur.note}</p> : null}
            <div className="mt-4 flex flex-wrap gap-2">
              {cur.file ? (
                <a
                  href={cur.file.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="seaglass-btn inline-flex h-11 items-center gap-2 rounded-xl px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--glass-ink))]"
                >
                  {cur.file.kind === "pdf" ? <FileText className="h-4 w-4" aria-hidden /> : <ExternalLink className="h-4 w-4" aria-hidden />}
                  <span>{cur.file.kind === "pdf" ? "Open The PDF" : "Open The Picture"}</span>
                </a>
              ) : null}
              {cur.linkUrl ? (
                <a
                  href={cur.linkUrl}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="seaglass-btn inline-flex h-11 items-center gap-2 rounded-xl px-4 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[rgb(var(--glass-ink))]"
                >
                  <ExternalLink className="h-4 w-4" aria-hidden />
                  <span>Open The Link</span>
                </a>
              ) : null}
            </div>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
