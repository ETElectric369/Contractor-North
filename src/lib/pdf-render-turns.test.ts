import { describe, expect, it } from "vitest";
import { renderTurns } from "./pdf-render-turns";
import { worthRedrawing } from "./pdf-page-width";

/**
 * The two document-preview races, walked step by step in the order the viewer walks them.
 *
 * Both were introduced when turning the phone started redrawing the sheets (2026-10-01), and both are
 * SILENT on an invoice: no spinner, no error, no retry — the screen simply stops agreeing with what he
 * chose or with the phone in his hand. These cases are the trace, not the implementation.
 */

describe("a rotation must never take the screen from a load in flight", () => {
  it("the margin he tapped still lands when he turns the phone mid-fetch", () => {
    const t = renderTurns();

    // He opens the invoice: the first load fetches it and draws it at 370.
    const first = t.startLoad();
    t.settled(first);
    const portrait = t.startPaint(370);
    expect(t.loadOwns(first)).toBe(true);
    expect(t.paintOwns(portrait)).toBe(true);

    // He taps "Wide · 1 in". A second load starts fetching; the sheets on screen are now the old
    // margin's and no longer own anything.
    const wide = t.startLoad();
    expect(t.paintOwns(portrait)).toBe(false);
    expect(t.isLoading()).toBe(true);

    // He turns the phone. The repaint timer fires 180 ms later and must DEFER — the document in hand
    // is the one being replaced, and the load re-measures the room itself when it draws.
    expect(t.isLoading()).toBe(true);

    // And even if something does paint in that window, the fetch must still own the screen. With one
    // shared counter this is where the Wide bytes were dropped on the floor.
    const rotated = t.startPaint(796);
    expect(t.loadOwns(wide)).toBe(true);
    expect(t.paintOwns(rotated)).toBe(true);

    // So the Wide document is adopted and drawn, instead of returning silently.
    t.settled(wide);
    expect(t.isLoading()).toBe(false);
    const redrawn = t.startPaint(796);
    expect(t.paintOwns(redrawn)).toBe(true);
    expect(t.paintOwns(rotated)).toBe(false);
  });

  it("a NEW load does cancel the paint of the document it replaces", () => {
    // The other direction has to keep working: the old document gets destroyed, so a loop still
    // rasterizing pages out of it must stop.
    const t = renderTurns();
    const first = t.startLoad();
    t.settled(first);
    const drawing = t.startPaint(370);
    t.startLoad();
    expect(t.paintOwns(drawing)).toBe(false);
  });

  it("a load that was superseded cannot clear the in-flight flag out from under the new one", () => {
    const t = renderTurns();
    const stale = t.startLoad();
    const current = t.startLoad();
    t.settled(stale);
    expect(t.isLoading()).toBe(true);
    t.settled(current);
    expect(t.isLoading()).toBe(false);
  });

  it("leaving the page stops every loop drawing into it", () => {
    const t = renderTurns();
    const load = t.startLoad();
    t.settled(load);
    const paint = t.startPaint(370);
    t.abandonAll();
    expect(t.loadOwns(load)).toBe(false);
    expect(t.paintOwns(paint)).toBe(false);
    expect(t.isLoading()).toBe(false);
  });
});

describe("an interrupted rotation does not leave the sheets the wrong width", () => {
  it("the width is claimed when the list is emptied, not when the last page lands", () => {
    const t = renderTurns();
    const load = t.startLoad();
    t.settled(load);
    // The list is emptied and refilling at 370 — that is what the screen shows from this instant,
    // page one or page twelve. Nothing has finished yet.
    t.startPaint(370);
    expect(t.drawnAtW()).toBe(370);
  });

  it("he turns the phone, turns it back mid-paint, and the sheets end up portrait-sized", () => {
    const t = renderTurns();
    const load = t.startLoad();
    t.settled(load);
    const portrait = t.startPaint(370);
    t.finishedPaint(portrait, 370);

    // Sideways. 180 ms later the repaint empties the list and starts appending 796px canvases.
    expect(worthRedrawing(796, t.drawnAtW())).toBe(true);
    const sideways = t.startPaint(796);
    expect(t.drawnAtW()).toBe(796);

    // Back upright before a 12-page material list finishes — so `sideways` never reaches its own
    // completion. The guard has to SEE that half-drawn 796: this is the comparison that returned
    // false and let the sideways paint run to the end into a portrait window, where the invoice could
    // only be read by panning sideways and no further resize ever came to heal it.
    expect(worthRedrawing(370, t.drawnAtW())).toBe(true);
    const back = t.startPaint(370);
    expect(t.paintOwns(sideways)).toBe(false);
    expect(t.paintOwns(back)).toBe(true);

    // And the superseded sideways paint finishing late may not claim the width back.
    expect(t.finishedPaint(sideways, 796)).toBe(false);
    expect(t.drawnAtW()).toBe(370);
    expect(t.finishedPaint(back, 370)).toBe(true);
    expect(t.drawnAtW()).toBe(370);
  });

  it("the mirror case too: sideways, upright, sideways again before it finishes", () => {
    const t = renderTurns();
    const load = t.startLoad();
    t.settled(load);
    const first = t.startPaint(796);
    t.finishedPaint(first, 796);
    t.startPaint(370);
    expect(worthRedrawing(796, t.drawnAtW())).toBe(true);
    const last = t.startPaint(796);
    expect(t.paintOwns(last)).toBe(true);
    expect(t.drawnAtW()).toBe(796);
  });

  it("a resize that changes nothing still repaints nothing", () => {
    // The point of recording the width at all: a scrollbar or a hairline of rounding must not
    // re-rasterize a twelve-page document.
    const t = renderTurns();
    const load = t.startLoad();
    t.settled(load);
    const only = t.startPaint(370);
    t.finishedPaint(only, 370);
    expect(worthRedrawing(373, t.drawnAtW())).toBe(false);
  });
});
