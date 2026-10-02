/**
 * THE ARITHMETIC OF A TURNED PHONE. One number, one swap, one inverse — all of it here, so the
 * components only ever place what this file worked out.
 *
 * Erik, 2026-10-01, twice:
 *   "I'd like to be able to turn the phone sideways to see the calendar in full, but it would be
 *    nice to also keep the buttons for the top bar and the dock exactly where they are while
 *    spinning everything in between only."
 *   "On the app rotation is it possible to lock the top bar and the dock positions and just rotate
 *    the buttons while the internal screen rotates?"
 *
 * SO THE SHELL NEVER ROTATES. iOS is locked to portrait on the iPhone (Info.plist), which is what
 * keeps the top bar against the phone's top edge and the dock against its bottom edge no matter
 * which way the phone is held — they do not move because NOTHING moves. What moves is drawn by us:
 * the region between them is laid out at the SWAPPED dimensions and painted rotated a quarter turn,
 * so the page inside it gets a genuine landscape viewport, and each chrome button's face is painted
 * the same quarter turn so it reads the right way up to a person who has turned the phone.
 *
 * WHICH WAY ROUND. "clockwise" means the person turned the phone clockwise, so the phone's TOP edge
 * now points to their right (iOS calls that device orientation landscapeRight — the home button is
 * on the left). The content must then be painted a quarter turn ANTI-clockwise to come back upright,
 * which is -90deg. "counterclockwise" is the mirror of all of it. Upside down is never reported.
 *
 * Every function here is pure and takes its numbers as arguments: the real boxes are MEASURED off
 * the real chrome at run time (components/turned.tsx), never guessed from a phone model.
 */

/** How the person is holding the phone, as the shell reports it. */
export type Held = "upright" | "clockwise" | "counterclockwise";

/** Every value `Held` can take, for the places that have to cover all of them. */
export const EVERY_WAY_HELD: readonly Held[] = ["upright", "clockwise", "counterclockwise"];

/** Is the phone turned at all? The one test for "draw it rotated". */
export function isTurned(held: Held): boolean {
  return held === "clockwise" || held === "counterclockwise";
}

/**
 * THE ONE NUMBER: the degrees anything has to be painted through to read upright to a person
 * holding the phone this way. The content region and a chrome glyph get the SAME number — the
 * glyph is not a "counter-rotation" of anything, it is the same quarter turn, which is why there is
 * one function and not two.
 */
export function uprightDegrees(held: Held): 0 | 90 | -90 {
  if (held === "clockwise") return -90;
  if (held === "counterclockwise") return 90;
  return 0;
}

/** As CSS writes it, so the stylesheet variable and the inline transform cannot drift apart. */
export function uprightTurn(held: Held): string {
  return `${uprightDegrees(held)}deg`;
}

export type Box = { width: number; height: number };

/**
 * THE ROOM ACTUALLY AVAILABLE between the chrome. `reserveBottom` is the dock: it is a floating
 * glass bar over the scrolling middle, so the middle's own box runs underneath it and the rotated
 * region has to stop short of it or the last strip of a document would be drawn under the dock.
 * Never negative — a measurement taken mid-layout can briefly be smaller than the dock.
 */
export function roomBetweenTheChrome(host: Box, reserveBottom = 0): Box {
  return {
    width: Math.max(0, host.width),
    height: Math.max(0, host.height - Math.max(0, reserveBottom)),
  };
}

/**
 * WHAT THE CONTENT IS LAID OUT AT. Held sideways, a box that is physically 402 x 684 is laid out at
 * 684 x 402 and painted rotated into the same 402 x 684 of glass — which is the whole point: the
 * page inside gets a landscape viewport, measured in its own CSS pixels, so it reflows for real
 * instead of being a portrait layout squeezed.
 */
export function laidOutAt(room: Box, held: Held): Box {
  return isTurned(held) ? { width: room.height, height: room.width } : { width: room.width, height: room.height };
}

/** Everything a face needs, in the host's own pixels. `left`/`top` are the CENTRE it is pinned to;
 *  the element carries `translate(-50%, -50%)` so the rotation happens about that same point. */
export type FacePlacement = {
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly degrees: number;
};

/**
 * PLACE THE ROTATED FACE inside its host. Pinned to the centre of the room, not of the host: with a
 * dock reserved at the bottom, the centre of the room is higher up than the centre of the box.
 */
export function placeTheFace(host: Box, held: Held, reserveBottom = 0): FacePlacement {
  const room = roomBetweenTheChrome(host, reserveBottom);
  const size = laidOutAt(room, held);
  return {
    width: size.width,
    height: size.height,
    left: room.width / 2,
    top: room.height / 2,
    degrees: uprightDegrees(held),
  };
}

/**
 * THE PLACEMENT, AS THE ELEMENT WEARS IT. Here rather than inside the component so the exact inline
 * style a turned region gets is a thing a test can read, instead of something only a phone can show.
 * `translate(-50%, -50%)` first and the turn second: the element is pinned by its own centre to the
 * centre of the room, and then turned about that same point.
 *
 * AND THE BOX'S OWN SIZE, AS TWO CUSTOM PROPERTIES. This is the one real cost of drawing the turn
 * ourselves instead of letting iOS do it: inside this box the LAYOUT is 684 x 402, but `100dvh` and
 * `min-width: 1024px` are still answered by the WINDOW, which is 402 x 874 and stays that way.
 * Anything sized by its container — flex, grid, percentages, the PDF's measured page width — is right
 * on its own; the few rules that ask the window instead read --turn-w / --turn-h.
 */
export function faceStyle(place: FacePlacement): Record<string, string> {
  return {
    width: `${place.width}px`,
    height: `${place.height}px`,
    left: `${place.left}px`,
    top: `${place.top}px`,
    transform: `translate(-50%, -50%) rotate(${place.degrees}deg)`,
    "--turn-w": `${place.width}px`,
    "--turn-h": `${place.height}px`,
  };
}

export type Point = { x: number; y: number };

/**
 * WHERE A FINGER LANDS. A tap at a point on the GLASS, in the host's own coordinates, falls on this
 * point of the rotated content — the inverse of the transform above, which is the arithmetic a
 * browser does for us when it hit-tests through a transform. It is written out here so the claim
 * "taps still work" is a thing with a test under it and not a hope: the live check drives a real tap
 * against the real transform (see the report), and this is the answer it has to agree with.
 *
 * Held clockwise, the glass's top-left corner is the person's top-RIGHT, so a tap there lands at
 * x = the content's full width. Held counterclockwise it is their bottom-left. Upright, a point is
 * itself.
 */
export function whereTheFingerLands(onGlass: Point, host: Box, held: Held, reserveBottom = 0): Point {
  const room = roomBetweenTheChrome(host, reserveBottom);
  if (!isTurned(held)) return { x: onGlass.x, y: onGlass.y };
  if (held === "clockwise") return { x: room.height - onGlass.y, y: onGlass.x };
  return { x: onGlass.y, y: room.width - onGlass.x };
}

/**
 * HOW BIG A TARGET IS AFTER THE TURN — the one that matters for the 44px rule, because a control is
 * tapped on the GLASS, not in the frame it was laid out in. A quarter turn swaps a control's two
 * sides, so a 44 x 44 square is still 44 x 44 (every control in the top bar is one), and anything
 * that is 44 in one direction only keeps its 44 in the OTHER direction. Both sides are returned so a
 * test can assert the smaller one.
 */
export function tapTargetOnGlass(control: Box, held: Held): Box {
  return laidOutAt(control, held);
}

/** A thumb's travel — a pair of deltas, not a position. The same shape in either frame. */
export type Drag = { dx: number; dy: number };

/**
 * WHICH WAY THE THUMB IS ACTUALLY GOING — whereTheFingerLands(), read as a MOVEMENT instead of a
 * point, and the other half of making a turned screen feel like a screen.
 *
 * WHY THIS HAS TO EXIST AT ALL. A browser hit-tests THROUGH a transform, so a tap lands where the
 * person aimed, and a NATIVE scroll inside the turned box goes the way they pushed — both of those are
 * free. But a TouchEvent's `clientX/clientY` are the GLASS's coordinates, untransformed, because the
 * window is what measures them. So a gesture we read OURSELVES — pull-to-refresh is the one today —
 * sees a thumb travelling along the glass while the content it is pulling has been turned a quarter
 * turn beneath it. Held clockwise the person pulls DOWN their own view and the glass reports a drag to
 * the RIGHT: read raw, every pull looks like a sideways swipe and is thrown away as one.
 *
 * SO THE SAME INVERSE, ONCE. A delta is the difference of two positions, and the translation in
 * whereTheFingerLands() cancels in a difference — which is why no box and no dock reservation are
 * needed here, and why this is the SAME arithmetic rather than a second copy of it. The test asserts
 * exactly that: for every direction, this agrees with the difference of two whereTheFingerLands()
 * answers, so the two can never drift.
 *
 *   upright           a thumb is itself
 *   clockwise         the person's DOWN is the glass's RIGHT   (dy =  dx on glass)
 *   counterclockwise  the person's DOWN is the glass's LEFT    (dy = -dx on glass)
 */
export function thumbThroughTheTurn(onGlass: Drag, held: Held): Drag {
  if (!isTurned(held)) return { dx: onGlass.dx, dy: onGlass.dy };
  if (held === "clockwise") return { dx: theOtherWay(onGlass.dy), dy: onGlass.dx };
  return { dx: onGlass.dy, dy: theOtherWay(onGlass.dx) };
}

/**
 * The same travel, the other way along the axis. A plain `-n` would answer -0 for a thumb that did not
 * move on that axis at all, and -0 is not 0 to Object.is — so "it did not move sideways" would read as
 * a different answer from "it did not move sideways" depending on which way the phone was held.
 */
function theOtherWay(n: number): number {
  return n === 0 ? 0 : -n;
}
