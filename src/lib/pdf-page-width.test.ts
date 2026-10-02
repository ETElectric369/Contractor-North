import { describe, expect, it } from "vitest";
import { pageWidthInside, worthRedrawing } from "./pdf-page-width";

describe("how wide a page is drawn", () => {
  it("a portrait phone draws exactly what it drew before this changed", () => {
    // iPhone 16 Pro portrait: 402pt of window, the scroller's px-2 takes 16, so 386 is measured
    // inside it — and 386 − 16 of frame is the same 386 − 32 the old window-based sum produced.
    expect(pageWidthInside(402 - 16)).toBe(402 - 32);
  });

  it("the same phone sideways draws a page twice as wide, clear of the camera", () => {
    // 874pt of window sideways, less ~59pt of cutout inset on EACH side (globals.css pads the
    // scroller past it, which is why this is measured inside and not from window.innerWidth).
    const inside = 874 - 59 * 2;
    expect(pageWidthInside(inside)).toBe(740);
    expect(pageWidthInside(inside)).toBeGreaterThan(2 * pageWidthInside(402 - 16) * 0.95);
  });

  it("zero — a display:none element — floors instead of going negative (the blank sheets)", () => {
    // The original bug: clientWidth 0 on a hidden host, minus the frame, rendered every page into a
    // negative-width canvas and Erik got a stack of blank paper.
    expect(pageWidthInside(0)).toBe(280);
    expect(pageWidthInside(10)).toBe(280);
    expect(pageWidthInside(-500)).toBe(280);
  });

  it("a measurement that isn't a number floors too", () => {
    // Both of these mean "nobody measured anything", and the safe answer to that is the narrowest
    // readable page, not the widest — a page too small is legible, a page too large eats the memory
    // budget the whole dpr ladder exists to protect.
    expect(pageWidthInside(NaN)).toBe(280);
    expect(pageWidthInside(Infinity)).toBe(280);
  });

  it("a wide desktop stops at 900 — a sheet never gets bigger than the paper", () => {
    expect(pageWidthInside(1600)).toBe(900);
    expect(pageWidthInside(916)).toBe(900);
  });

  it("is a whole number of pixels — a fractional canvas width rounds the aspect ratio off", () => {
    expect(pageWidthInside(500.7)).toBe(484);
    expect(Number.isInteger(pageWidthInside(500.7))).toBe(true);
  });
});

describe("when it is worth drawing them again", () => {
  it("a rotation is", () => {
    expect(worthRedrawing(740, 370)).toBe(true);
  });

  it("the same width measured twice is not", () => {
    expect(worthRedrawing(370, 370)).toBe(false);
  });

  it("a scrollbar appearing is not", () => {
    // Re-rasterizing a twelve-page material list because a 7px scrollbar showed up is the kind of
    // thing that makes a document feel broken.
    expect(worthRedrawing(363, 370)).toBe(false);
  });

  it("…and eight pixels is where it starts to be", () => {
    expect(worthRedrawing(362, 370)).toBe(true);
  });

  it("nothing drawn yet is always worth drawing", () => {
    expect(worthRedrawing(370, 0)).toBe(true);
  });
});
