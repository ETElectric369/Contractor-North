"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * THE SPOTLIGHT — dim the app, cut a hole around one real button, point a card at it.
 *
 * Erik: "nort walking me through the whole site and where the button is for nort with an arrow and
 * nort asking questions and pointing things out like you see everywhere for onboarding."
 *
 * IT POINTS AT THE LIVE ELEMENT, never a picture of one. The anchor is found by `data-tour` at the
 * moment the step shows, measured, and re-measured on scroll and resize — so the arrow lands on the
 * button he will actually press tomorrow, wherever the layout put it on his phone.
 *
 * A MISSING ANCHOR IS NOT A BROKEN STEP. Wrong route, a role that hides the control, a screen too
 * narrow for it — the step degrades to a centred card with no arrow and the words still get said.
 * A tour that dies because a button moved is worse than one that occasionally doesn't point.
 *
 * THE HOLE IS A BOX-SHADOW, not an SVG mask or four dimming rects: one element, no seams at the
 * corners, and it animates position without re-laying anything out.
 */

interface Rect { top: number; left: number; width: number; height: number }

const PAD = 8; // breathing room around the highlighted control
const GAP = 14; // card's distance from the hole

export function TourSpotlight({
  anchor,
  title,
  children,
  onExit,
  step,
  total,
}: {
  anchor?: string;
  title: string;
  children: React.ReactNode;
  onExit: () => void;
  step: number;
  total: number;
}) {
  const [rect, setRect] = useState<Rect | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  // Measure on every step change, and keep measuring — a topbar control moves when the page
  // scrolls under it, and a phone rotating re-lays the whole shell.
  useLayoutEffect(() => {
    if (!anchor) {
      setRect(null);
      return;
    }
    let raf = 0;
    // THE FIRST *VISIBLE* MATCH, not the first match. One name can have two elements — the dock
    // is a rail on a computer and a bar at the bottom of a phone, and whichever one isn't in play
    // is `hidden`, i.e. present in the DOM at zero size. querySelector found that one, measured
    // nothing, and gave up: on a phone the nav step pointed at empty air.
    const findVisible = () => {
      const all = Array.from(document.querySelectorAll<HTMLElement>(`[data-tour="${anchor}"]`));
      return all.find((el) => {
        const r = el.getBoundingClientRect();
        return r.width >= 2 && r.height >= 2;
      });
    };
    const measure = () => {
      const el = findVisible();
      if (!el) return setRect(null);
      const r = el.getBoundingClientRect();
      setRect({ top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 });
    };
    const loop = () => {
      measure();
      raf = requestAnimationFrame(loop);
    };
    // Scroll it into view first — a spotlight on something off-screen is a dimmed screen.
    findVisible()?.scrollIntoView({ block: "center", behavior: "smooth" });
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [anchor]);

  if (!mounted) return null;

  const vh = typeof window === "undefined" ? 800 : window.innerHeight;
  const vw = typeof window === "undefined" ? 400 : window.innerWidth;
  const cardW = Math.min(380, vw - 24);

  // Below the hole when there's room, otherwise above it. With no hole at all, centre it.
  const below = rect ? rect.top + rect.height + GAP : 0;
  const roomBelow = rect ? vh - below : 0;
  const place: "below" | "above" | "center" = !rect ? "center" : roomBelow > 260 ? "below" : "above";
  const cardLeft = rect
    ? Math.max(12, Math.min(vw - cardW - 12, rect.left + rect.width / 2 - cardW / 2))
    : Math.max(12, vw / 2 - cardW / 2);
  const cardStyle: React.CSSProperties =
    place === "center"
      ? { left: cardLeft, top: Math.max(24, vh / 2 - 180), width: cardW }
      : place === "below"
        ? { left: cardLeft, top: below, width: cardW }
        : { left: cardLeft, bottom: vh - rect!.top + GAP, width: cardW };

  // The arrow sits on the card edge nearest the hole, aimed at the hole's centre.
  const arrowLeft = rect ? Math.max(14, Math.min(cardW - 26, rect.left + rect.width / 2 - cardLeft - 6)) : 0;

  return createPortal(
    <div className="fixed inset-0 z-[200]" role="dialog" aria-modal="true" aria-label="Guided tour">
      {/* The dimmer, and the hole in it. Clicks land here and go nowhere on purpose — mid-step is
          not the moment to wander off; Exit and the step buttons are the ways out. */}
      {rect ? (
        <div
          className="pointer-events-auto absolute rounded-xl ring-2 ring-white/90 transition-all duration-300"
          style={{
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height,
            boxShadow: "0 0 0 9999px rgba(15,23,42,0.72)",
          }}
        />
      ) : (
        <div className="pointer-events-auto absolute inset-0 bg-slate-900/72" />
      )}

      <div className="pointer-events-auto absolute rounded-2xl border border-white/60 bg-white shadow-2xl" style={cardStyle}>
        {place !== "center" && rect && (
          <span
            aria-hidden
            className="absolute h-3 w-3 rotate-45 border-white/60 bg-white"
            style={
              place === "below"
                ? { top: -6, left: arrowLeft, borderLeftWidth: 1, borderTopWidth: 1 }
                : { bottom: -6, left: arrowLeft, borderRightWidth: 1, borderBottomWidth: 1 }
            }
          />
        )}

        <div className="flex items-start justify-between gap-2 px-4 pt-3.5">
          <div className="min-w-0">
            <div className="text-[11px] font-medium uppercase tracking-wide text-brand">
              Nort · {step} of {total}
            </div>
            <h3 className="mt-0.5 text-base font-semibold text-slate-900">{title}</h3>
          </div>
          <button
            type="button"
            onClick={onExit}
            aria-label="Leave the tour"
            title="Leave the tour"
            className="-mr-1 shrink-0 rounded-md p-1.5 text-slate-400 hover:bg-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[52vh] overflow-y-auto px-4 pb-4 pt-2">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
