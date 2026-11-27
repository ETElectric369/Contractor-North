import { describe, expect, it } from "vitest";
import {
  FIT,
  NO_GESTURE,
  SHARP_MOST,
  between,
  clampZoom,
  drawDensity,
  gestureStep,
  mostZoom,
  mouseDoubleClickCounts,
  nearestFirst,
  onScreen,
  type GestureAct,
  type GestureEvent,
  type GestureState,
  placeOnSheet,
  scrollToKeep,
  spread,
  whereOnGlass,
  worthSharpening,
  zoomAfterDoubleTap,
  zoomAfterPinch,
  zoomAfterWheel,
  zoomedSize,
  type OnGlass,
} from "./pdf-zoom";
import { WIDEST, pageWidthInside } from "./pdf-page-width";
import { EVERY_WAY_HELD, whereTheFingerLands, type Box, type Held, type Point } from "./turned-geometry";

/** A phone held upright: the room pageWidthInside() gives a 390pt-wide screen's scroller. */
const PHONE = pageWidthInside(390);

describe("how far a sheet may be zoomed", () => {
  it("a phone goes in four times and no further", () => {
    expect(mostZoom(PHONE)).toBe(4);
    expect(clampZoom(9, PHONE)).toBe(4);
  });

  it("a wide room gains less: the widest fitted sheet only doubles", () => {
    expect(mostZoom(WIDEST)).toBe(2);
    expect(clampZoom(3, WIDEST)).toBe(2);
    // …and in between it is whatever reaches twice the widest fitted sheet.
    expect(mostZoom(600)).toBe(3);
  });

  it("never smaller than the room, and a nonsense ask is FIT", () => {
    expect(clampZoom(0.4, PHONE)).toBe(FIT);
    expect(clampZoom(Number.NaN, PHONE)).toBe(FIT);
    expect(clampZoom(-3, PHONE)).toBe(FIT);
    expect(mostZoom(0)).toBe(FIT);
    expect(mostZoom(Number.NaN)).toBe(FIT);
  });
});

describe("what a gesture asks for", () => {
  it("a pinch multiplies the zoom it began at by how far the fingers opened", () => {
    expect(zoomAfterPinch({ zoomAtStart: 1, spreadAtStart: 100, spreadNow: 200, room: PHONE })).toBe(2);
    expect(zoomAfterPinch({ zoomAtStart: 2, spreadAtStart: 200, spreadNow: 100, room: PHONE })).toBe(1);
    expect(zoomAfterPinch({ zoomAtStart: 2, spreadAtStart: 100, spreadNow: 150, room: PHONE })).toBe(3);
  });

  it("a pinch stops at both ends", () => {
    expect(zoomAfterPinch({ zoomAtStart: 3, spreadAtStart: 100, spreadNow: 400, room: PHONE })).toBe(4);
    expect(zoomAfterPinch({ zoomAtStart: 1.5, spreadAtStart: 300, spreadNow: 30, room: PHONE })).toBe(FIT);
  });

  it("two fingers that began on one pixel say nothing", () => {
    expect(zoomAfterPinch({ zoomAtStart: 2, spreadAtStart: 0, spreadNow: 180, room: PHONE })).toBe(2);
    expect(zoomAfterPinch({ zoomAtStart: 2, spreadAtStart: 100, spreadNow: Number.NaN, room: PHONE })).toBe(2);
  });

  it("the spread and the midpoint of two fingers", () => {
    expect(spread({ x: 0, y: 0 }, { x: 30, y: 40 })).toBe(50);
    expect(between({ x: 10, y: 20 }, { x: 30, y: 60 })).toEqual({ x: 20, y: 40 });
  });

  it("a double tap goes in from FIT and back to FIT from anywhere else", () => {
    expect(zoomAfterDoubleTap(FIT, PHONE)).toBe(2.5);
    expect(zoomAfterDoubleTap(2.5, PHONE)).toBe(FIT);
    expect(zoomAfterDoubleTap(1.3, PHONE)).toBe(FIT);
    // In a room that cannot reach the double-tap zoom it goes as far as the room allows.
    expect(zoomAfterDoubleTap(FIT, WIDEST)).toBe(2);
  });

  it("ctrl + wheel: away is in, toward is out, and it stops at both ends", () => {
    expect(zoomAfterWheel(1, -20, PHONE)).toBeGreaterThan(1);
    expect(zoomAfterWheel(2, 20, PHONE)).toBeLessThan(2);
    expect(zoomAfterWheel(1, 500, PHONE)).toBe(FIT);
    expect(zoomAfterWheel(3.9, -5000, PHONE)).toBe(4);
    expect(zoomAfterWheel(2, Number.NaN, PHONE)).toBe(2);
  });

  it("a trackpad pinch, a few pixels at a time, zooms at its own rate", () => {
    expect(zoomAfterWheel(2, -10, PHONE)).toBeCloseTo(2 * Math.exp(0.1), 9);
    expect(zoomAfterWheel(2, 10, PHONE)).toBeCloseTo(2 * Math.exp(-0.1), 9);
  });

  it("one notch of a mouse wheel is one step, however many pixels the notch says it is", () => {
    const step = zoomAfterWheel(1, -100, PHONE);
    expect(step).toBeCloseTo(Math.exp(0.3), 9);
    expect(zoomAfterWheel(1, -240, PHONE)).toBe(step);
    expect(zoomAfterWheel(2, 100, PHONE)).toBeCloseTo(2 * Math.exp(-0.3), 9);
  });

  it("a wheel that counts in lines is read as lines", () => {
    // One line is sixteen pixels: a single line zooms like sixteen pixels, three lines hit the cap.
    expect(zoomAfterWheel(2, -1, PHONE, true)).toBeCloseTo(2 * Math.exp(0.16), 9);
    expect(zoomAfterWheel(1, -3, PHONE, true)).toBe(zoomAfterWheel(1, -100, PHONE));
  });
});

describe("a sheet's size on the screen", () => {
  const fitted: Box = { width: 374, height: 484 };

  it("at FIT it is the fitted size to the pixel", () => {
    expect(zoomedSize(fitted, FIT)).toEqual({ width: 374, height: 484 });
  });

  it("zoomed it keeps the paper's shape, the height derived from the rounded width", () => {
    const twice = zoomedSize(fitted, 2);
    expect(twice).toEqual({ width: 748, height: 968 });
    const odd = zoomedSize(fitted, 1.37);
    expect(odd.width).toBe(Math.round(374 * 1.37));
    expect(odd.height).toBe(Math.round((odd.width * 484) / 374));
    // Where the two ways of working the height out disagree, it is the WIDTH's: 376 across is 487
    // down on this paper, though 484 x 1.005 alone would round to 486.
    expect(zoomedSize(fitted, 1.005)).toEqual({ width: 376, height: 487 });
  });

  it("a sheet with no width is left alone rather than divided by", () => {
    expect(zoomedSize({ width: 0, height: 0 }, 3)).toEqual({ width: 0, height: 0 });
  });
});

describe("how sharp a sheet is drawn", () => {
  it("a fitted sheet is drawn exactly as it always was: at the document's own density", () => {
    for (const dpr of [1.5, 2, 2.5, 3]) {
      expect(drawDensity(280, dpr)).toBe(dpr);
      expect(drawDensity(374, dpr)).toBe(dpr);
      expect(drawDensity(WIDEST, dpr)).toBe(dpr);
    }
  });

  it("past the widest fitted sheet the PIXELS stop growing, whatever the zoom", () => {
    for (const dpr of [1.5, 2, 3]) {
      for (const cssWidth of [901, 1200, 1496, 1800, 3600]) {
        const pixelsAcross = cssWidth * drawDensity(cssWidth, dpr);
        expect(pixelsAcross).toBeCloseTo(WIDEST * dpr, 6);
      }
    }
  });

  it("so a letter page never asks an iPhone for more than one canvas may hold", () => {
    // The most the viewer ever draws a sheet at is 3 pixels per CSS pixel.
    const across = Math.floor(1496 * drawDensity(1496, 3));
    const down = Math.round((across * 11) / 8.5);
    expect(across).toBe(2700);
    expect(across * down).toBeLessThan(16_777_216);
  });

  it("a sheet is drawn again only for clearly more detail", () => {
    expect(worthSharpening(1122, 2244)).toBe(true);
    expect(worthSharpening(1122, 1122)).toBe(false);
    expect(worthSharpening(1122, 1180)).toBe(false); // a hair more is not worth a redraw
    expect(worthSharpening(2700, 1122)).toBe(false); // zooming out keeps the sharper sheet
  });
});

/**
 * THE PLACE UNDER THE FINGERS STAYS UNDER THEM. This is the claim a person feels, so it is tested
 * against the repository's own account of a turned screen (whereTheFingerLands) and not against a
 * second copy of the same arithmetic: a scroller, a sheet inside it, fingers on the glass, the sheet
 * grows, the scroller is moved by what scrollToKeep() says, and the same place of the sheet has to
 * be under the same point of the glass.
 */
describe("the place under the fingers stays under them", () => {
  /** The scroller's box on the glass, as its host measures it. */
  const HOST: Box = { width: 390, height: 700 };

  /** A point of the scroller's content, for a point on the glass. */
  const contentAt = (onGlass: Point, held: Held, scroll: Point): Point => {
    const inFace = whereTheFingerLands(onGlass, HOST, held);
    return { x: inFace.x + scroll.x, y: inFace.y + scroll.y };
  };

  /** A sheet's box on the glass, from its box in the content: the box round its four corners. */
  const sheetOnGlass = (sheet: OnGlass, held: Held, scroll: Point): OnGlass => {
    const corners: Point[] = [
      { x: sheet.left, y: sheet.top },
      { x: sheet.left + sheet.width, y: sheet.top },
      { x: sheet.left, y: sheet.top + sheet.height },
      { x: sheet.left + sheet.width, y: sheet.top + sheet.height },
    ].map((c) => {
      const f = { x: c.x - scroll.x, y: c.y - scroll.y };
      // The inverse of whereTheFingerLands(), corner by corner.
      if (held === "clockwise") return { x: f.y, y: HOST.height - f.x };
      if (held === "counterclockwise") return { x: HOST.width - f.y, y: f.x };
      return f;
    });
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    const left = Math.min(...xs);
    const top = Math.min(...ys);
    return { left, top, width: Math.max(...xs) - left, height: Math.max(...ys) - top };
  };

  for (const held of EVERY_WAY_HELD) {
    it(`held ${held}: zooming in about a point keeps that point of the sheet where the fingers are`, () => {
      // The second sheet of a document, scrolled part of the way down.
      const before: OnGlass = { left: 8, top: 520, width: 374, height: 484 };
      const scroll: Point = { x: 0, y: 400 };
      const fingers: Point = { x: 150, y: 310 };

      const wasUnder = contentAt(fingers, held, scroll);
      const place = placeOnSheet(fingers, sheetOnGlass(before, held, scroll), held);
      // The place is the same fraction the content's own frame says it is.
      expect(place.x).toBeCloseTo((wasUnder.x - before.left) / before.width, 9);
      expect(place.y).toBeCloseTo((wasUnder.y - before.top) / before.height, 9);

      // Twice as big: the sheet above it grew too, so this one starts lower as well.
      const after: OnGlass = { left: 8, top: 1016, width: 748, height: 968 };
      const move = scrollToKeep({ place, sheetNow: sheetOnGlass(after, held, scroll), fingers, held });
      const scrolled: Point = { x: scroll.x + move.dx, y: scroll.y + move.dy };

      const nowUnder = contentAt(fingers, held, scrolled);
      expect((nowUnder.x - after.left) / after.width).toBeCloseTo(place.x, 9);
      expect((nowUnder.y - after.top) / after.height).toBeCloseTo(place.y, 9);
    });

    it(`held ${held}: a place and its point on the glass are each other's inverse`, () => {
      const sheet: OnGlass = { left: 40, top: 90, width: 300, height: 420 };
      for (const fingers of [{ x: 40, y: 90 }, { x: 190, y: 300 }, { x: 355, y: 20 }]) {
        const back = whereOnGlass(placeOnSheet(fingers, sheet, held), sheet, held);
        expect(back.x).toBeCloseTo(fingers.x, 9);
        expect(back.y).toBeCloseTo(fingers.y, 9);
      }
    });
  }

  it("upright, the top-left corner of a sheet is place 0,0 and its far corner 1,1", () => {
    const sheet: OnGlass = { left: 10, top: 20, width: 200, height: 300 };
    expect(placeOnSheet({ x: 10, y: 20 }, sheet, "upright")).toEqual({ x: 0, y: 0 });
    expect(placeOnSheet({ x: 210, y: 320 }, sheet, "upright")).toEqual({ x: 1, y: 1 });
  });

  it("held clockwise, the glass's top-left corner of a sheet is the sheet's top-RIGHT", () => {
    const sheet: OnGlass = { left: 10, top: 20, width: 200, height: 300 };
    expect(placeOnSheet({ x: 10, y: 20 }, sheet, "clockwise")).toEqual({ x: 1, y: 0 });
    expect(placeOnSheet({ x: 10, y: 20 }, sheet, "counterclockwise")).toEqual({ x: 0, y: 1 });
  });

  it("a sheet that is not on the screen yet answers its middle rather than dividing by nothing", () => {
    expect(placeOnSheet({ x: 5, y: 5 }, { left: 0, top: 0, width: 0, height: 0 }, "upright")).toEqual({ x: 0.5, y: 0.5 });
  });

  it("nothing moved, nothing to scroll", () => {
    const sheet: OnGlass = { left: 8, top: 100, width: 374, height: 484 };
    const fingers = { x: 120, y: 260 };
    for (const held of EVERY_WAY_HELD) {
      const move = scrollToKeep({ place: placeOnSheet(fingers, sheet, held), sheetNow: sheet, fingers, held });
      expect(Math.abs(move.dx)).toBeLessThan(1e-9);
      expect(Math.abs(move.dy)).toBeLessThan(1e-9);
    }
  });
});

describe("the order sheets are drawn again in", () => {
  it("the one being read first, then outward both ways", () => {
    expect(nearestFirst(6, 3)).toEqual([3, 4, 2, 5, 1, 0]);
    expect(nearestFirst(5, 0)).toEqual([0, 1, 2, 3, 4]);
    expect(nearestFirst(4, 3)).toEqual([3, 2, 1, 0]);
  });

  it("every sheet exactly once, wherever it starts", () => {
    for (const from of [-2, 0, 4, 11, 99, Number.NaN]) {
      const order = nearestFirst(12, from);
      expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    }
    expect(nearestFirst(0, 0)).toEqual([]);
    expect(nearestFirst(1, 5)).toEqual([0]);
  });
});

describe("which sheets are on the screen", () => {
  const view: OnGlass = { left: 0, top: 100, width: 390, height: 700 };

  it("a sheet partly on the glass is on it, one wholly above, below or beside is not", () => {
    expect(onScreen({ left: 8, top: 120, width: 374, height: 484 }, view)).toBe(true);
    expect(onScreen({ left: 8, top: -300, width: 374, height: 450 }, view)).toBe(true); // its foot shows
    expect(onScreen({ left: 8, top: -400, width: 374, height: 484 }, view)).toBe(false);
    expect(onScreen({ left: 8, top: 900, width: 374, height: 484 }, view)).toBe(false);
    expect(onScreen({ left: 500, top: 120, width: 374, height: 484 }, view)).toBe(false);
    // A zoomed sheet wider than the glass, panned so only its middle shows, is on it.
    expect(onScreen({ left: -600, top: 0, width: 1496, height: 1936 }, view)).toBe(true);
  });

  it("touching edges are not overlap, and a sheet with no size is nowhere", () => {
    expect(onScreen({ left: 8, top: 800, width: 374, height: 484 }, view)).toBe(false);
    expect(onScreen({ left: 8, top: -384, width: 374, height: 484 }, view)).toBe(false);
    expect(onScreen({ left: 8, top: 200, width: 0, height: 0 }, view)).toBe(false);
    expect(onScreen({ left: 8, top: 200, width: 374, height: 484 }, { ...view, width: 0 })).toBe(false);
  });

  it("never more than three sheets are sharp at once", () => {
    expect(SHARP_MOST).toBe(3);
  });
});

describe("a mouse's double click", () => {
  it("counts only when no finger touched in the last 700 ms", () => {
    expect(mouseDoubleClickCounts(10_000, 9_400)).toBe(false);
    expect(mouseDoubleClickCounts(10_000, 9_301)).toBe(false);
    expect(mouseDoubleClickCounts(10_000, 9_300)).toBe(true);
    expect(mouseDoubleClickCounts(10_000, 0)).toBe(true);
  });
});

/**
 * THE GESTURE RULE, DRIVEN. Each test hands gestureStep() the events a browser would send, in order,
 * and reads back the acts the viewer would carry out. `touches` are the fingers on the glass AFTER
 * each event, as a TouchEvent's are.
 */
describe("the gesture rule", () => {
  const A: Point = { x: 100, y: 300 };
  const B: Point = { x: 200, y: 300 };
  const C: Point = { x: 300, y: 500 };

  const start = (touches: Point[], at = 0, ready = true, zoom = FIT): GestureEvent => ({ kind: "start", touches, at, ready, zoom });
  const move = (touches: Point[], o: { ready?: boolean; cancelable?: boolean } = {}): GestureEvent => ({
    kind: "move",
    touches,
    ready: o.ready ?? true,
    cancelable: o.cancelable ?? true,
    room: PHONE,
  });
  const end = (touches: Point[], lifted: Point | null, at = 0, ready = true): GestureEvent => ({ kind: "end", touches, lifted, at, ready });

  /** Every event in turn; the acts that were not null, and where the gesture ended up. */
  function drive(events: GestureEvent[], from: GestureState = NO_GESTURE): { acts: NonNullable<GestureAct>[]; state: GestureState } {
    let state = from;
    const acts: NonNullable<GestureAct>[] = [];
    for (const e of events) {
      const r = gestureStep(state, e);
      state = r.state;
      if (r.act) acts.push(r.act);
    }
    return { acts, state };
  }
  const kinds = (acts: NonNullable<GestureAct>[]) => acts.map((a) => a.kind);

  /** A single tap at a point at a time: down, up 80 ms later on the same spot. */
  const tap = (p: Point, t: number, ready = true): GestureEvent[] => [start([p], t), end([], p, t + 80, ready)];

  it("one finger, then a second: a pinch begins, held at the midpoint", () => {
    const { acts, state } = drive([start([A], 0), start([A, B], 40)]);
    expect(acts).toEqual([{ kind: "hold", at: { x: 150, y: 300 } }]);
    expect(state.pinch).toEqual({ spread: 100, zoom: FIT });
    expect(state.wasPinch).toBe(true);
    expect(state.down).toBeNull();
  });

  it("two fingers at once begin it the same way, at the zoom the sheets are at", () => {
    const { acts, state } = drive([start([A, B], 0, true, 2)]);
    expect(acts).toEqual([{ kind: "hold", at: { x: 150, y: 300 } }]);
    expect(state.pinch).toEqual({ spread: 100, zoom: 2 });
  });

  it("a pinch that opens asks for the zoom it began at times how far the fingers opened", () => {
    const { acts } = drive([start([A, B]), move([{ x: 50, y: 300 }, { x: 250, y: 300 }])]);
    expect(acts[1]).toEqual({ kind: "show", zoom: 2, fingers: { x: 150, y: 300 } });
    // …and from a zoom of 2, half as far apart is FIT.
    const back = drive([start([A, B], 0, true, 2), move([{ x: 125, y: 300 }, { x: 175, y: 300 }])]);
    expect(back.acts[1]).toEqual({ kind: "show", zoom: FIT, fingers: { x: 150, y: 300 } });
  });

  for (const [name, stays] of [["the first", B], ["the second", A]] as const) {
    it(`lifting ${name} finger first finishes the pinch, once, and the other finger's lift is no tap`, () => {
      const lifted = stays === B ? A : B;
      const { acts, state } = drive([start([A]), start([A, B], 20), move([A, C]), end([stays], lifted, 60), end([], stays, 90)]);
      expect(kinds(acts)).toEqual(["hold", "show", "finish"]);
      expect(state).toEqual(NO_GESTURE);
      // The finish is the FIRST lift's, not the last one's.
      const firstLift = drive([start([A]), start([A, B], 20), move([A, C]), end([stays], lifted, 60)]);
      expect(kinds(firstLift.acts)).toEqual(["hold", "show", "finish"]);
      expect(firstLift.state.pinch).toBeNull();
    });
  }

  it("a lift after two fingers have been down is no tap, even with a finger's landing on record", () => {
    // A browser always clears `down` with the second finger, so this is the rule held on its own.
    const after: GestureState = { ...NO_GESTURE, wasPinch: true, down: { at: 0, x: A.x, y: A.y } };
    const r = gestureStep(after, end([], A, 50));
    expect(r.act).toBeNull();
    expect(r.state).toEqual(NO_GESTURE);
  });

  it("a pinch and then a quick tap is not a double tap", () => {
    const { acts } = drive([start([A, B], 0), end([B], A, 50), end([], B, 60), ...tap(A, 100)]);
    expect(kinds(acts)).toEqual(["hold", "finish"]);
  });

  it("a third finger finishes the pinch where it was, and nothing more comes of those fingers", () => {
    const { acts, state } = drive([start([A, B]), move([A, C]), start([A, C, B], 30), move([A, C]), end([A, C], B, 60), end([], A, 70)]);
    expect(kinds(acts)).toEqual(["hold", "show", "finish"]);
    expect(state.pinch).toBeNull();
  });

  it("a move the browser will not let us refuse finishes the pinch and asks for no show", () => {
    const { acts, state } = drive([start([A, B]), move([A, C], { cancelable: false }), move([A, B])]);
    expect(kinds(acts)).toEqual(["hold", "finish"]);
    expect(state.pinch).toBeNull();
  });

  it("not ready when the fingers land: nothing begins, and their moves ask for nothing", () => {
    const { acts, state } = drive([start([A]), start([A, B], 20, false), move([A, C]), end([A], B, 60), end([], A, 70)]);
    expect(acts).toEqual([]);
    expect(state).toEqual(NO_GESTURE);
  });

  it("not ready in the middle of a pinch (a fresh draw began under it): dropped, with nothing to sharpen", () => {
    const { acts, state } = drive([start([A, B]), move([A, C]), move([A, B], { ready: false }), move([A, C]), end([A], B, 60)]);
    expect(kinds(acts)).toEqual(["hold", "show", "drop"]);
    expect(state.pinch).toBeNull();
  });

  it("a second pair landing while not ready over a pinch somehow still held lets that pinch go", () => {
    const held: GestureState = { ...NO_GESTURE, pinch: { spread: 100, zoom: 2 }, wasPinch: true };
    expect(gestureStep(held, start([A, B], 0, false)).act).toEqual({ kind: "drop" });
  });

  it("a move that is not exactly two fingers is never read, even over a pinch somehow still held", () => {
    // No run of real events leaves a pinch held with one finger or three down; a lift that never
    // arrived could. The move is the scroller's then, and nothing is worked out from a missing finger.
    const held: GestureState = { ...NO_GESTURE, pinch: { spread: 100, zoom: 2 }, wasPinch: true };
    for (const touches of [[A], [A, B, C]]) {
      const r = gestureStep(held, move(touches));
      expect(r.act).toBeNull();
      expect(r.state).toBe(held);
    }
  });

  it("cancel finishes a pinch and clears everything, and with no pinch it asks for nothing", () => {
    const pinched = drive([start([A, B]), move([A, C]), { kind: "cancel" }]);
    expect(kinds(pinched.acts)).toEqual(["hold", "show", "finish"]);
    expect(pinched.state).toEqual(NO_GESTURE);
    const tapped = drive([...tap(A, 0), { kind: "cancel" }, ...tap(A, 150)]);
    // The cancel forgot the first tap, so the second is a first again.
    expect(tapped.acts).toEqual([]);
    expect(tapped.state.lastTap).toEqual({ at: 230, x: A.x, y: A.y });
  });

  it("a tap is remembered; a slow press and a drag are not taps and forget the last one", () => {
    expect(drive(tap(A, 0)).state.lastTap).toEqual({ at: 80, x: 100, y: 300 });
    const slow = drive([...tap(A, 0), start([A], 200), end([], A, 520)]);
    expect(slow.state.lastTap).toBeNull();
    const drag = drive([...tap(A, 0), start([A], 200), end([], { x: 100, y: 312 }, 260)]);
    expect(drag.state.lastTap).toBeNull();
    expect(drag.acts).toEqual([]);
    expect(drive([start([A], 0), end([], { x: 100, y: 312 }, 50)]).state.lastTap).toBeNull();
    expect(drive([start([A], 0), end([], { x: 100, y: 311 }, 50)]).state.lastTap).not.toBeNull();
  });

  it("a double tap toggles at the second tap when ready, and does nothing when not", () => {
    const near: Point = { x: 110, y: 310 };
    expect(drive([...tap(A, 0), ...tap(near, 200)]).acts).toEqual([{ kind: "toggle", at: near }]);
    const notReady = drive([...tap(A, 0), ...tap(near, 200, false)]);
    expect(notReady.acts).toEqual([]);
    // Either way the pair is used up: a third tap is a first tap.
    expect(notReady.state.lastTap).toBeNull();
  });

  it("two taps too far apart, or too slow, are two single taps", () => {
    expect(drive([...tap(A, 0), ...tap({ x: 140, y: 300 }, 200)]).acts).toEqual([]);
    expect(drive([...tap(A, 0), ...tap(A, 400)]).acts).toEqual([]);
    // Too slow, the second is remembered as a first, and a quick third makes the double tap.
    expect(drive([...tap(A, 0), ...tap(A, 400), ...tap(A, 600)]).acts).toEqual([{ kind: "toggle", at: A }]);
  });

  it("one finger moving never produces an act: it is the scroller's", () => {
    const { acts } = drive([start([A]), move([C]), move([B]), move([A], { cancelable: false }), end([], A, 900)]);
    expect(acts).toEqual([]);
  });
});
