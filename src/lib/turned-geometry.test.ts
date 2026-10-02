import { describe, expect, it } from "vitest";
import {
  EVERY_WAY_HELD,
  isTurned,
  laidOutAt,
  placeTheFace,
  roomBetweenTheChrome,
  tapTargetOnGlass,
  uprightDegrees,
  uprightTurn,
  whereTheFingerLands,
  type Held,
} from "./turned-geometry";

/**
 * THE ARITHMETIC OF A TURNED PHONE, on Erik's own numbers.
 *
 * His phone is an iPhone 16 Pro: 402 x 874 CSS pixels, and the interface is locked to portrait, so
 * those are the numbers whichever way he holds it. Measured off the real chrome in the app:
 *   · the top bar is 4rem + the top safe area = 64 + 59 = 123px
 *   · the dock covers the bottom 67px of the scrolling middle (8px of `bottom-2` plus a 59px bar)
 * which leaves the middle 402 wide and 874 - 123 = 751 tall, with 67 of that under the dock: a
 * usable 402 x 684. Turned, the page is laid out at 684 x 402.
 *
 * WHY THAT IS THE BETTER TRADE, in one sum. Letting iOS rotate (what cn-v1041 shipped) makes the
 * screen 874 x 402 and the chrome then eats the SHORT side: 402 - 64 - 67 = 271 of height. So his way
 * is 190px narrower and 131px TALLER. On a calendar of time rows and on a page of print, height is
 * what you run out of.
 */

const PHONE = { width: 402, height: 874 };
const TOP_BAR = 123;
const DOCK = 67;
const MIDDLE = { width: PHONE.width, height: PHONE.height - TOP_BAR };

describe("one number, and which way it goes", () => {
  it("clockwise is a quarter turn back the other way; counterclockwise is its mirror", () => {
    // He turns the phone clockwise, so its TOP edge now points to his right. The content's "up" points
    // right with it, and to bring "up" back to up you turn it anti-clockwise: -90.
    expect(uprightDegrees("clockwise")).toBe(-90);
    expect(uprightDegrees("counterclockwise")).toBe(90);
    expect(uprightDegrees("upright")).toBe(0);
  });

  it("the stylesheet gets the same number, spelled the way CSS spells it", () => {
    expect(uprightTurn("clockwise")).toBe("-90deg");
    expect(uprightTurn("counterclockwise")).toBe("90deg");
    expect(uprightTurn("upright")).toBe("0deg");
  });

  it("A CHROME GLYPH AND THE PAGE GET THE SAME TURN — there is one number, not two", () => {
    // The buttons are not "counter-rotated" relative to anything: the top bar is not transformed at
    // all, so a glyph in it is in the device's frame exactly like the page is, and the turn that makes
    // one read upright is the turn that makes the other read upright. Two functions here would be two
    // things to get out of step.
    for (const held of EVERY_WAY_HELD) expect(uprightDegrees(held)).toBe(placeTheFace(MIDDLE, held).degrees);
  });

  it("only the two turns count as turned", () => {
    expect(isTurned("clockwise")).toBe(true);
    expect(isTurned("counterclockwise")).toBe(true);
    expect(isTurned("upright")).toBe(false);
  });
});

describe("the room between the chrome", () => {
  it("the dock comes off the bottom — it FLOATS over the middle, it does not take a row", () => {
    expect(roomBetweenTheChrome(MIDDLE, DOCK)).toEqual({ width: 402, height: 684 });
  });

  it("with no dock (a document screen, a desktop window) the whole box is the room", () => {
    expect(roomBetweenTheChrome(MIDDLE)).toEqual({ width: 402, height: 751 });
  });

  it("a measurement taken mid-layout can be smaller than the dock, and never goes negative", () => {
    expect(roomBetweenTheChrome({ width: 402, height: 40 }, DOCK)).toEqual({ width: 402, height: 0 });
    expect(roomBetweenTheChrome({ width: -5, height: -5 }, 10)).toEqual({ width: 0, height: 0 });
  });
});

describe("THE GEOMETRY: the content gets the swapped dimensions", () => {
  it("turned, his page is laid out at 684 x 402 — a real landscape viewport, in its own pixels", () => {
    // This is the whole claim. Not a portrait layout squeezed: 684 CSS pixels of width, so a seven-day
    // week and a 1080px price table reflow for real.
    const room = roomBetweenTheChrome(MIDDLE, DOCK);
    expect(laidOutAt(room, "clockwise")).toEqual({ width: 684, height: 402 });
    expect(laidOutAt(room, "counterclockwise")).toEqual({ width: 684, height: 402 });
  });

  it("upright nothing is swapped — the page is exactly the box, as it is today", () => {
    const room = roomBetweenTheChrome(MIDDLE, DOCK);
    expect(laidOutAt(room, "upright")).toEqual({ width: 402, height: 684 });
  });

  it("…and it is TALLER than letting iOS rotate the whole view, which is the point", () => {
    // What shipped: the screen becomes 874 x 402 and the chrome eats the short side.
    const whatShipped = { width: 874, height: 402 - 64 - DOCK };
    const hisWay = laidOutAt(roomBetweenTheChrome(MIDDLE, DOCK), "clockwise");
    expect(whatShipped.height).toBe(271);
    expect(hisWay.height).toBe(402);
    expect(hisWay.height - whatShipped.height).toBe(131);
    expect(whatShipped.width - hisWay.width).toBe(190);
  });

  it("the face is pinned to the centre of the ROOM, not of the box — the dock is not the middle", () => {
    const p = placeTheFace(MIDDLE, "clockwise", DOCK);
    expect(p).toEqual({ width: 684, height: 402, left: 201, top: 342, degrees: -90 });
    // Pinned at the room's centre, with translate(-50%,-50%), a 684 x 402 box rotated a quarter turn
    // paints exactly the 402 x 684 of glass the room is: top edge at 342 - 342 = 0, bottom at 684.
    expect(p.top - p.width / 2).toBe(0);
    expect(p.top + p.width / 2).toBe(684);
    expect(p.left - p.height / 2).toBe(0);
    expect(p.left + p.height / 2).toBe(402);
  });

  it("upright, the placement is the box itself and no turn at all", () => {
    expect(placeTheFace(MIDDLE, "upright", DOCK)).toEqual({
      width: 402,
      height: 684,
      left: 201,
      top: 342,
      degrees: 0,
    });
  });
});

describe("A TAP IN THE TURNED REGION LANDS ON THE RIGHT ELEMENT", () => {
  // A browser applies the inverse of the transform when it hit-tests, which is what makes taps and
  // scrolling work through a rotated box at all. The inverse is written out so the claim is a thing
  // with a test under it rather than a hope — and the live check against a real browser has to agree
  // with these same numbers.
  const room = roomBetweenTheChrome(MIDDLE, DOCK); // 402 x 684 of glass; content laid out 684 x 402

  it("held clockwise, the glass's top-left is the person's top-RIGHT", () => {
    expect(whereTheFingerLands({ x: 0, y: 0 }, MIDDLE, "clockwise", DOCK)).toEqual({ x: 684, y: 0 });
    expect(whereTheFingerLands({ x: 0, y: 684 }, MIDDLE, "clockwise", DOCK)).toEqual({ x: 0, y: 0 });
    expect(whereTheFingerLands({ x: 402, y: 684 }, MIDDLE, "clockwise", DOCK)).toEqual({ x: 0, y: 402 });
    expect(whereTheFingerLands({ x: 402, y: 0 }, MIDDLE, "clockwise", DOCK)).toEqual({ x: 684, y: 402 });
  });

  it("held counterclockwise it is the mirror of that, corner for corner", () => {
    expect(whereTheFingerLands({ x: 0, y: 0 }, MIDDLE, "counterclockwise", DOCK)).toEqual({ x: 0, y: 402 });
    expect(whereTheFingerLands({ x: 0, y: 684 }, MIDDLE, "counterclockwise", DOCK)).toEqual({ x: 684, y: 402 });
    expect(whereTheFingerLands({ x: 402, y: 684 }, MIDDLE, "counterclockwise", DOCK)).toEqual({ x: 684, y: 0 });
    expect(whereTheFingerLands({ x: 402, y: 0 }, MIDDLE, "counterclockwise", DOCK)).toEqual({ x: 0, y: 0 });
  });

  it("every point on the glass lands INSIDE the content, never off it", () => {
    for (const held of ["clockwise", "counterclockwise"] as Held[]) {
      const size = laidOutAt(room, held);
      for (let x = 0; x <= room.width; x += 37) {
        for (let y = 0; y <= room.height; y += 57) {
          const at = whereTheFingerLands({ x, y }, MIDDLE, held, DOCK);
          expect(at.x).toBeGreaterThanOrEqual(0);
          expect(at.y).toBeGreaterThanOrEqual(0);
          expect(at.x).toBeLessThanOrEqual(size.width);
          expect(at.y).toBeLessThanOrEqual(size.height);
        }
      }
    }
  });

  it("the centre of the glass is the centre of the content, both ways round", () => {
    const mid = { x: room.width / 2, y: room.height / 2 };
    for (const held of ["clockwise", "counterclockwise"] as Held[]) {
      const size = laidOutAt(room, held);
      expect(whereTheFingerLands(mid, MIDDLE, held, DOCK)).toEqual({ x: size.width / 2, y: size.height / 2 });
    }
  });

  it("upright, a tap is where it was — nothing is transformed and nothing is computed", () => {
    expect(whereTheFingerLands({ x: 17, y: 300 }, MIDDLE, "upright", DOCK)).toEqual({ x: 17, y: 300 });
  });

  it("the two turns are each other's inverse: go through one, come back through the other", () => {
    // If the mapping were wrong in the same way in both directions this is the test that would catch
    // it — they have to be mirror images, not copies.
    for (const p of [{ x: 0, y: 0 }, { x: 402, y: 684 }, { x: 100, y: 500 }, { x: 390, y: 12 }]) {
      const cw = whereTheFingerLands(p, MIDDLE, "clockwise", DOCK);
      const ccw = whereTheFingerLands(p, MIDDLE, "counterclockwise", DOCK);
      expect(cw.x + ccw.x).toBe(room.height);
      expect(cw.y + ccw.y).toBe(room.width);
    }
  });
});

describe("44px IN BOTH ORIENTATIONS — measured on the glass, after the turn", () => {
  it("every control in the top bar is a square, so a quarter turn leaves it 44 x 44", () => {
    for (const held of EVERY_WAY_HELD) {
      const t = tapTargetOnGlass({ width: 44, height: 44 }, held);
      expect(Math.min(t.width, t.height)).toBeGreaterThanOrEqual(44);
    }
  });

  it("a dock tile is 77 x 47 upright and 47 x 77 turned — over 44 in both, both ways", () => {
    // Five tiles sharing 402px less the dock's own padding. The tile's box does not change; what the
    // turn changes is which of its two sides the person sees as the taller one.
    const tile = { width: 77, height: 47 };
    for (const held of EVERY_WAY_HELD) {
      const t = tapTargetOnGlass(tile, held);
      expect(Math.min(t.width, t.height)).toBeGreaterThanOrEqual(44);
    }
    expect(tapTargetOnGlass(tile, "clockwise")).toEqual({ width: 47, height: 77 });
  });

  it("a control that is 44 in ONE direction keeps its 44 — in the other direction", () => {
    // The thing that would be easy to get wrong: a 44 x 120 pill turned is 120 x 44, which still has
    // 44 of the side that was short. A control that was under 44 was under 44 before the turn too.
    expect(tapTargetOnGlass({ width: 44, height: 120 }, "clockwise")).toEqual({ width: 120, height: 44 });
    const t = tapTargetOnGlass({ width: 44, height: 120 }, "counterclockwise");
    expect(Math.min(t.width, t.height)).toBe(44);
  });
});
