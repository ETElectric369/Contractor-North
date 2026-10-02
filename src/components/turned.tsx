"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTheTurn } from "@/components/turns-sideways";
import { faceDrawsTheTurn, type TurnedRegion } from "@/lib/screens-that-turn";
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
 *
 * EXACTLY ONE FACE DRAWS THE TURN, AND IT IS THE ONE THAT OWNS IT. Each region says which one it is
 * (`region`), and faceDrawsTheTurn() in lib/screens-that-turn.ts matches that against the one owner in
 * the answer. The bug that taught us: the app shell's region and the full-screen viewer inside it both
 * read "the phone is sideways" and both turned, the two quarter turns composed into a half turn, and a
 * job photo opened sideways read upside down — and came out SMALLER than in portrait, because the
 * viewer's `position: fixed` was resolving against the shell's transformed box instead of the window.
 * With the shell's region left upright while a layer owns the turn, both go away at once.
 */

/** useLayoutEffect, except on the server, where React warns about it and there is nothing to lay out. */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;

/**
 * THE FLOOR UNDER THE RULE ABOVE: is an ancestor face already drawing the turn? Ownership is what
 * decides, and this is what makes "one turn, never two composed" true even if ownership is ever handed
 * to the wrong region — the inner face declines rather than adding a second quarter turn. A failure
 * then reads as "not turned", which a person can see and work around, instead of "upside down".
 */
const AlreadyTurned = createContext(false);

export function Turned({
  children,
  region,
  avoidDock = false,
}: {
  children: React.ReactNode;
  region: TurnedRegion;
  avoidDock?: boolean;
}) {
  const { held, owns, bottomChrome } = useTheTurn();
  const face = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<FacePlacement | null>(null);
  const insideATurnedFace = useContext(AlreadyTurned);
  const turned = isTurned(held) && faceDrawsTheTurn(region, owns) && !insideATurnedFace;
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
  if (!turned)
    return (
      <AlreadyTurned.Provider value={insideATurnedFace}>
        <div ref={face} className="turn-face">{children}</div>
      </AlreadyTurned.Provider>
    );

  return (
    <AlreadyTurned.Provider value={true}>
      <div
        ref={face}
        className="turn-face"
        data-held={held}
        style={
          place
            ? (faceStyle(place) as React.CSSProperties)
            : // One frame, before the host has been measured: fill it, unrotated, rather than collapse to
              // nothing. The measurement happens before paint, so in practice this is never seen.
              { inset: "0", width: "auto", height: "auto" }
        }
      >
        {children}
      </div>
    </AlreadyTurned.Provider>
  );
}
