/**
 * ZOOM IN THE DOCUMENT PREVIEW: the arithmetic, pure, so it is read without a browser.
 *
 * WHY THE PREVIEW ZOOMS ITSELF (Erik, 2026-11-27, on an invoice in the phone app: "i cannot zoom in
 * on it"). The phone app's shell turns the web view's own pinch off for every screen: that is the
 * shell framework's default and the right one for an app, where a pinch that enlarged the dock would
 * be a defect. So in the app a pinch on a document did nothing at all, and turning the phone sideways
 * was the only way to read small print. A drawn page is a bitmap fitted to the room, so the answer is
 * here and not in the shell: the preview makes its own sheets bigger, in every browser the same way,
 * and the rest of the app stays unzoomable.
 *
 * ONE MECHANISM. Zoom is the CSS size of each sheet, nothing else: no transform, no second layer. The
 * scroller the sheets already live in then pans them with one finger, natively, in both directions.
 * After a gesture, and after a scroll while zoomed, the sheets on the screen (never more than
 * SHARP_MOST of them) are drawn again at the size they are shown at so the print is sharp
 * (viewer.tsx, `sharpen`), under the budget in drawDensity() below.
 *
 * THE GESTURE RULE IS HERE TOO, pure, so it is read without a browser (gestureStep): which touches
 * are a pinch, which lifts are a tap, and when a pinch is over. The viewer only carries out what it
 * answers.
 *
 * A FRESH DRAW IS ALWAYS FITTED. A new margin and a turn of the phone draw the document again from
 * nothing, and so does a resized window when it changes the room by enough to be worth a redraw
 * (lib/pdf-page-width, worthRedrawing); each of those starts at FIT. Zoom is a way of looking at the
 * sheets on the screen, never a setting.
 */
import { thumbThroughTheTurn, type Box, type Drag, type Held, type Point } from "@/lib/turned-geometry";
import { WIDEST } from "@/lib/pdf-page-width";

/** A sheet exactly as wide as the room: what every fresh draw is. */
export const FIT = 1;
/** Never more than this many times the fitted width, however narrow the room. */
const MOST = 4;
/** The widest a zoomed sheet is laid out, in CSS px: twice the widest fitted sheet. That is a little
 *  over twice the width letter paper has on a screen (816 px), and past it a page is only bigger,
 *  not easier to read. */
const WIDEST_ZOOMED = WIDEST * 2;
/** Where a double tap goes from FIT. On a phone that is close to the widest fitted sheet. */
const DOUBLE_TAP = 2.5;
/** Above this a sheet counts as zoomed, so a double tap takes it back to FIT. */
const BARELY = 1.05;
/** How fast ctrl + wheel zooms, per pixel of wheel: the rate a trackpad pinch (which reaches a page
 *  as ctrl + wheel, a few pixels at a time) feels right at. */
const WHEEL_RATE = 0.01;
/** The most one wheel event may count for. A mouse wheel sends a whole notch at once, a hundred
 *  pixels or more, and at the trackpad's rate one notch would be nearly three times the size. */
const WHEEL_MOST = 30;
/** A wheel that counts in LINES (a mouse in Firefox) says 3 where one that counts in pixels says 48. */
const WHEEL_LINE = 16;
/** A sheet is drawn again only for more than this much more detail across. */
const WORTH_IT = 1.15;

/** How far in a sheet may go in a room this wide. A room that is already wide has less to gain. */
export function mostZoom(room: number): number {
  if (!Number.isFinite(room) || room <= 0) return FIT;
  return Math.min(MOST, Math.max(FIT, WIDEST_ZOOMED / room));
}

/** Any asked-for zoom, brought inside what this room allows. Never under FIT: a sheet smaller than
 *  the room is a sheet with nothing gained. */
export function clampZoom(zoom: number, room: number): number {
  if (!Number.isFinite(zoom)) return FIT;
  return Math.min(mostZoom(room), Math.max(FIT, zoom));
}

/** How far apart two fingers are. */
export function spread(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The point halfway between two fingers: the place a pinch is about. */
export function between(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** The zoom a pinch has reached: the zoom it began at, times how much the fingers have opened. Two
 *  fingers that began on the same pixel say nothing, and the zoom stays where it was. */
export function zoomAfterPinch(o: { zoomAtStart: number; spreadAtStart: number; spreadNow: number; room: number }): number {
  if (!(o.spreadAtStart > 0) || !Number.isFinite(o.spreadNow)) return clampZoom(o.zoomAtStart, o.room);
  return clampZoom(o.zoomAtStart * (o.spreadNow / o.spreadAtStart), o.room);
}

/** A double tap: in from FIT, back to FIT from anywhere else. */
export function zoomAfterDoubleTap(zoom: number, room: number): number {
  return zoom > BARELY ? FIT : clampZoom(DOUBLE_TAP, room);
}

/**
 * ctrl + wheel, which is also how a trackpad pinch reaches a page: away from you is in. `inLines`
 * is the event's own word for its unit (deltaMode 1). One event never counts for more than
 * WHEEL_MOST pixels, so a mouse wheel zooms a step at a time and a trackpad is not slowed at all.
 */
export function zoomAfterWheel(zoom: number, deltaY: number, room: number, inLines = false): number {
  if (!Number.isFinite(deltaY)) return clampZoom(zoom, room);
  const pixels = Math.max(-WHEEL_MOST, Math.min(WHEEL_MOST, inLines ? deltaY * WHEEL_LINE : deltaY));
  return clampZoom(zoom * Math.exp(-pixels * WHEEL_RATE), room);
}

/**
 * A SHEET'S SIZE ON THE SCREEN at a zoom, from the size it was fitted at. At FIT it is the fitted
 * size to the pixel, so zooming in and all the way back out leaves exactly the sheets a fresh draw
 * made. The height is derived from the rounded width, the same rule the fresh draw uses, so the
 * sheet keeps the paper's shape.
 */
export function zoomedSize(fitted: Box, zoom: number): Box {
  if (zoom === FIT || !(fitted.width > 0)) return { width: fitted.width, height: fitted.height };
  const width = Math.round(fitted.width * zoom);
  return { width, height: Math.round((width * fitted.height) / fitted.width) };
}

/**
 * HOW MANY PIXELS PER CSS PIXEL a sheet this wide is drawn at, `dpr` being the density asked for. A
 * sheet is never drawn with more pixels across than the widest FITTED sheet at that density, so one
 * sheet stays inside what an iPhone will give one canvas. The cap is PER SHEET. What bounds a whole
 * document is the viewer: at most SHARP_MOST sheets are sharp at once, three sheets of at most
 * 900 x 3 pixels across, and every other sheet is the fitted one a fresh draw made. Up to the widest
 * fitted width this is `dpr` itself.
 */
export function drawDensity(cssWidth: number, dpr: number): number {
  if (!(cssWidth > 0)) return dpr;
  return Math.min(dpr, (WIDEST * dpr) / cssWidth);
}

/** Is drawing this sheet again worth it? Only for clearly more detail than it has: zooming out, or
 *  in by a hair, keeps the sheet that is there. */
export function worthSharpening(havePixels: number, wantPixels: number): boolean {
  return wantPixels > havePixels * WORTH_IT;
}

/** Where a sheet is on the glass, as the browser reports it. */
export type OnGlass = { left: number; top: number; width: number; height: number };

/**
 * WHICH PLACE ON A SHEET IS UNDER THE FINGERS, as fractions of the sheet's own width and height, in
 * the frame the sheet was laid out in. Turned sideways the sheet is drawn a quarter turn round, so
 * across the glass is down the sheet: the same inverse lib/turned-geometry's whereTheFingerLands()
 * uses, and the test holds the two together. The fractions may fall outside 0..1 when the fingers are
 * in the gap between two sheets; the arithmetic is the same there.
 */
export function placeOnSheet(fingers: Point, sheet: OnGlass, held: Held): Point {
  if (!(sheet.width > 0) || !(sheet.height > 0)) return { x: 0.5, y: 0.5 };
  const across = (fingers.x - sheet.left) / sheet.width;
  const down = (fingers.y - sheet.top) / sheet.height;
  if (held === "clockwise") return { x: 1 - down, y: across };
  if (held === "counterclockwise") return { x: down, y: 1 - across };
  return { x: across, y: down };
}

/** The other way: where that place of the sheet is on the glass now. */
export function whereOnGlass(place: Point, sheet: OnGlass, held: Held): Point {
  let across = place.x;
  let down = place.y;
  if (held === "clockwise") {
    across = place.y;
    down = 1 - place.x;
  } else if (held === "counterclockwise") {
    across = 1 - place.y;
    down = place.x;
  }
  return { x: sheet.left + across * sheet.width, y: sheet.top + down * sheet.height };
}

/**
 * HOW FAR TO SCROLL so the place that was under the fingers is under them again, after the sheets
 * changed size. `sheetNow` is the sheet's box on the glass AFTER the change. The answer is in the
 * scroller's own frame (add dx to scrollLeft and dy to scrollTop), which is why it goes through
 * thumbThroughTheTurn(): a difference on the glass is a difference a quarter turn round in a
 * scroller that is drawn turned.
 */
export function scrollToKeep(o: { place: Point; sheetNow: OnGlass; fingers: Point; held: Held }): Drag {
  const now = whereOnGlass(o.place, o.sheetNow, o.held);
  return thumbThroughTheTurn({ dx: now.x - o.fingers.x, dy: now.y - o.fingers.y }, o.held);
}

/**
 * THE ORDER TO DRAW SHEETS AGAIN IN: the one being read first, then outward both ways, so the page
 * under a person's eyes is sharp first and page one of a long list does not make them wait.
 */
export function nearestFirst(count: number, from: number): number[] {
  if (!(count > 0)) return [];
  const start = Math.min(count - 1, Math.max(0, Math.floor(Number.isFinite(from) ? from : 0)));
  const order = [start];
  for (let step = 1; order.length < count; step++) {
    if (start + step < count) order.push(start + step);
    if (start - step >= 0) order.push(start - step);
  }
  return order;
}

/**
 * THE MOST SHEETS THAT ARE DRAWN SHARP AT ONCE. A person reads one sheet and sees the edge of the
 * next, so three covers a phone, and three is what keeps a long document's memory where a short
 * one's is: every other sheet is the fitted one.
 */
export const SHARP_MOST = 3;

/** Is any of this sheet on the glass the scroller shows? Touching edges are not overlap. */
export function onScreen(sheet: OnGlass, view: OnGlass): boolean {
  if (!(sheet.width > 0) || !(sheet.height > 0) || !(view.width > 0) || !(view.height > 0)) return false;
  return (
    sheet.left < view.left + view.width &&
    sheet.left + sheet.width > view.left &&
    sheet.top < view.top + view.height &&
    sheet.top + sheet.height > view.top
  );
}

// ── THE GESTURE RULE ────────────────────────────────────────────────────────────────────────────
// The whole rule, pure, the way components/pull-to-refresh reads its pull: the viewer hands each touch
// event over with what it knows of the screen, and carries out the one act that comes back.

/** A finger lifted this soon after it landed, and this close to where it landed, is a tap. */
const TAP_MS = 300;
const TAP_SLOP = 12;
/** Two taps this close together in time and on the glass are a double tap. */
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_SLOP = 30;
/** A mouse's double click within this long of a finger is the one a browser makes up after a tap. */
const TOUCH_THEN_CLICK_MS = 700;

export type GestureState = {
  /** A pinch in progress: how far apart the fingers were and the zoom when it began. */
  pinch: { spread: number; zoom: number } | null;
  /** One finger down and where: a tap is that finger lifted soon, close to where it landed. */
  down: { at: number; x: number; y: number } | null;
  lastTap: { at: number; x: number; y: number } | null;
  /** Two fingers have been down since every finger was last up: the lifts that follow are no tap. */
  wasPinch: boolean;
};

export const NO_GESTURE: GestureState = { pinch: null, down: null, lastTap: null, wasPinch: false };

/**
 * One touch event, as the viewer saw it. `touches` are the fingers on the glass AFTER the event, as a
 * TouchEvent's own `touches` are. `ready` is the viewer's word that the whole document is on the
 * screen; `cancelable` is the move's own, false when the browser has already taken the touch.
 */
export type GestureEvent =
  | { kind: "start"; touches: readonly Point[]; at: number; ready: boolean; zoom: number }
  | { kind: "move"; touches: readonly Point[]; ready: boolean; cancelable: boolean; room: number }
  | { kind: "end"; touches: readonly Point[]; lifted: Point | null; at: number; ready: boolean }
  | { kind: "cancel" };

export type GestureAct =
  /** A pinch begins: remember the place under this point. */
  | { kind: "hold"; at: Point }
  /** Show this zoom about these fingers, and refuse the browser the move. */
  | { kind: "show"; zoom: number; fingers: Point }
  /** The pinch is over: show the last ask, then draw sharp. */
  | { kind: "finish" }
  /** The pinch is over and there is nothing to sharpen: the document is being fetched or drawn. */
  | { kind: "drop" }
  /** A double tap. */
  | { kind: "toggle"; at: Point }
  | null;

/** What one touch event does to a gesture, and the one thing the viewer is to do about it. */
export function gestureStep(state: GestureState, e: GestureEvent): { state: GestureState; act: GestureAct } {
  if (e.kind === "cancel") {
    // The system took the touch (a notification pulled down, a call): a pinch ends where it was.
    return { state: NO_GESTURE, act: state.pinch ? { kind: "finish" } : null };
  }

  if (e.kind === "start") {
    const n = e.touches.length;
    if (n === 1) {
      const [f] = e.touches;
      return { state: { ...state, down: { at: e.at, x: f.x, y: f.y } }, act: null };
    }
    if (n < 1) return { state, act: null };
    const cleared = { ...state, down: null, lastTap: null, wasPinch: true };
    if (n === 2) {
      const [a, b] = e.touches;
      if (e.ready) return { state: { ...cleared, pinch: { spread: spread(a, b), zoom: e.zoom } }, act: { kind: "hold", at: between(a, b) } };
      // Not ready: nothing to zoom. A pinch that was somehow still held is let go of, with nothing to
      // sharpen, so the viewer never stays in a pinch that is over.
      return { state: { ...cleared, pinch: null }, act: state.pinch ? { kind: "drop" } : null };
    }
    // A third finger: whatever this is, it is not a pinch, and a pinch in progress ends where it was.
    return { state: { ...cleared, pinch: null }, act: state.pinch ? { kind: "finish" } : null };
  }

  if (e.kind === "move") {
    // ONE finger is never ours: it is the scroller's, and it is how a zoomed sheet is panned.
    if (!state.pinch || e.touches.length !== 2) return { state, act: null };
    // A fresh draw or a fetch began under the fingers: the sheets the pinch held are going away.
    if (!e.ready) return { state: { ...state, pinch: null }, act: { kind: "drop" } };
    // The browser owns this touch and will not be refused: let it have it, and end where we were.
    if (!e.cancelable) return { state: { ...state, pinch: null }, act: { kind: "finish" } };
    const [a, b] = e.touches;
    const zoom = zoomAfterPinch({ zoomAtStart: state.pinch.zoom, spreadAtStart: state.pinch.spread, spreadNow: spread(a, b), room: e.room });
    return { state, act: { kind: "show", zoom, fingers: between(a, b) } };
  }

  // end
  let next = state;
  let act: GestureAct = null;
  if (state.pinch && e.touches.length < 2) {
    next = { ...next, pinch: null };
    act = { kind: "finish" };
  }
  if (e.touches.length > 0) return { state: next, act };
  const down = next.down;
  const lifted = e.lifted;
  const tap =
    !next.wasPinch && down && lifted && e.at - down.at < TAP_MS && Math.hypot(lifted.x - down.x, lifted.y - down.y) < TAP_SLOP
      ? { at: e.at, x: lifted.x, y: lifted.y }
      : null;
  next = { ...next, wasPinch: false, down: null };
  if (!tap) return { state: { ...next, lastTap: null }, act };
  const last = next.lastTap;
  if (last && tap.at - last.at < DOUBLE_TAP_MS && Math.hypot(tap.x - last.x, tap.y - last.y) < DOUBLE_TAP_SLOP) {
    return { state: { ...next, lastTap: null }, act: e.ready ? { kind: "toggle", at: { x: tap.x, y: tap.y } } : null };
  }
  return { state: { ...next, lastTap: tap }, act };
}

/** A mouse's double click counts only when no finger touched in the last 700 ms: a browser makes one
 *  up after a finger's double tap, and read too it would undo the tap's zoom. */
export function mouseDoubleClickCounts(now: number, touchedAt: number): boolean {
  return now - touchedAt >= TOUCH_THEN_CLICK_MS;
}
