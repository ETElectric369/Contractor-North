"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTheTurn } from "@/components/turns-sideways";
import { faceStyle, isTurned, placeTheFace, type Box, type FacePlacement } from "@/lib/turned-geometry";

/**
 * THE PART THAT TURNS. Everything else stays exactly where it is.
 *
 * Erik, 2026-10-01: "lock the top bar and the dock positions and just rotate the buttons while the
 * internal screen rotates."
 *
 * HOW. The shell is portrait-locked, so the chrome cannot move — it is pinned to the phone's real top
 * and bottom edges because the view never rotates. This wraps the region BETWEEN the chrome. Held
 * upright it is `display: contents`: it has no box at all, and the page lays out byte for byte as it
 * does today. Held sideways, the host (the element this sits directly inside, which carries
 * `turn-host`) becomes the frame, and this becomes a box laid out at the host's SWAPPED dimensions,
 * pinned to the middle of it and painted a quarter turn — so the page inside gets a genuine landscape
 * viewport in its own CSS pixels and reflows for real, in the same rectangle of glass.
 *
 * MEASURED, NEVER GUESSED. The box comes off the host at run time, so the arithmetic is the phone's
 * own and not an iPhone 16 Pro's numbers hard-coded. `avoidDock` takes the dock off the bottom of it:
 * the dock FLOATS over the scrolling middle rather than taking a row, so without that the last strip
 * of a document would be drawn underneath it. How much the dock covers is measured too, once, by the
 * watcher in turns-sideways.tsx.
 *
 * THE ROTATED BOX IS THE SCROLLER (where the host was one). That is deliberate: a browser applies the
 * inverse transform to pointer coordinates, so a drag the person makes along what is now the vertical
 * axis of their view arrives in this box as a vertical drag, and it scrolls the way they expect. The
 * same inverse is written out as whereTheFingerLands() in lib/turned-geometry.ts so the claim has a
 * test under it.
 */

/** useLayoutEffect, except on the server, where React warns about it and there is nothing to lay out. */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function Turned({ children, avoidDock = false }: { children: React.ReactNode; avoidDock?: boolean }) {
  const { held, bottomChrome } = useTheTurn();
  const face = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<FacePlacement | null>(null);
  const turned = isTurned(held);
  const reserve = avoidDock ? bottomChrome : 0;

  useBeforePaint(() => {
    if (!turned) {
      setPlace(null);
      return;
    }
    const host = face.current?.parentElement;
    if (!host) return;
    const measure = () => {
      const box: Box = { width: host.clientWidth, height: host.clientHeight };
      setPlace(placeTheFace(box, held, reserve));
    };
    measure();
    // THE ROOM CAN CHANGE WHILE TURNED — a banner appears above the middle, the keyboard resizes the
    // layout, a section strip wraps onto a second line. Only while turned: observing a host that is
    // doing nothing is a cost paid on every screen for a case that is not happening.
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, [turned, held, reserve]);

  // Upright: NO BOX. `display: contents` is set in globals.css, nothing is set here, and the children
  // lay out as though this element did not exist.
  if (!turned) return <div ref={face} className="turn-face">{children}</div>;

  return (
    <div
      ref={face}
      className="turn-face"
      data-held={held}
      style={
        place
          ? faceStyle(place)
          : // One frame, before the host has been measured: fill it, unrotated, rather than collapse to
            // nothing. The measurement happens before paint, so in practice this is never seen.
            { inset: "0", width: "auto", height: "auto" }
      }
    >
      {children}
    </div>
  );
}
