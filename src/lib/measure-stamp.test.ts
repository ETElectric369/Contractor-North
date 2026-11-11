import { describe, it, expect, vi, afterEach } from "vitest";
import { MIN_FIGURE_PX, MIN_LABEL_PX, STAMP_MAX_DIM, roughWidth, stampFigure, stampLayout } from "./measure-stamp";

/**
 * THE FIGURE ON ITS PICTURE (cn-v1160). The drawing itself uses the phone's own fonts and cannot be
 * proved here; what can be is WHERE it is drawn (stampLayout, numbers only) and that nothing in the
 * helper can lose the picture: every way it can fail hands back the very file it was given.
 */

const picture = (name = "measure-1.jpg") => new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], name, { type: "image/jpeg" });

describe("stampLayout: one band at the foot of the picture's middle square", () => {
  it("a tall phone picture: the band ends where a square tile's cut ends, never at the picture's bottom edge", () => {
    const lay = stampLayout(738, 1600, "12 ft 0 in", "Measured length");
    // The middle square of 738 × 1600 runs from 431 to 1169.
    expect(lay.band.x).toBe(0);
    expect(lay.band.w).toBe(738);
    expect(lay.band.y + lay.band.h).toBe(1169);
    expect(lay.band.y).toBeGreaterThanOrEqual(431);
    // The exact numbers, so a change to the proportions is a decision.
    expect(lay).toEqual({
      band: { x: 0, y: 983, w: 738, h: 186 },
      label: { text: "Measured length", x: 369, y: 1028, size: 37 },
      figure: { text: "12 ft 0 in", x: 369, y: 1102, size: 82 },
    });
  });

  it("a wide picture: the middle square is the picture's whole height, so the band sits on its bottom edge", () => {
    const lay = stampLayout(1600, 900, "100 sq ft", "Measured area");
    expect(lay.band.y + lay.band.h).toBe(900);
    expect(lay.band.w).toBe(1600);
    expect(lay.figure.x).toBe(800);
  });

  it("the label sits over the figure, both inside the band, both centred", () => {
    for (const [w, h] of [[738, 1600], [1600, 900], [1000, 1000], [320, 480]] as const) {
      const lay = stampLayout(w, h, "3 ft 10.3 in", "Measured length");
      const bottom = lay.band.y + lay.band.h;
      expect(lay.label).not.toBeNull();
      expect(lay.label!.y).toBeLessThan(lay.figure.y);
      expect(lay.label!.y - lay.label!.size / 2).toBeGreaterThanOrEqual(lay.band.y);
      expect(lay.figure.y + lay.figure.size / 2).toBeLessThanOrEqual(bottom);
      expect(lay.label!.x).toBe(Math.round(w / 2));
      expect(lay.figure.x).toBe(Math.round(w / 2));
      expect(lay.figure.size).toBeGreaterThan(lay.label!.size);
    }
  });

  it("words too wide for the middle square shrink until they fit it", () => {
    const widthOf = (text: string, size: number) => text.length * size; // every character a full square
    const lay = stampLayout(738, 1600, "123 ft 11.9 in (approx.)", "Measured length (approx.)", widthOf);
    const room = 738 - 2 * 26;
    expect(widthOf(lay.figure.text, lay.figure.size)).toBeLessThanOrEqual(room);
    expect(widthOf(lay.label!.text, lay.label!.size)).toBeLessThanOrEqual(room);
    // ...and a short figure keeps its full size on the same picture.
    expect(stampLayout(738, 1600, "9 in", "", widthOf).figure.size).toBe(82);
  });

  it("with no label there is one line and a shorter band", () => {
    const both = stampLayout(738, 1600, "12 ft 0 in", "Measured length");
    const one = stampLayout(738, 1600, "12 ft 0 in", "   ");
    expect(one.label).toBeNull();
    expect(one.band.h).toBeLessThan(both.band.h);
    expect(one.band.y + one.band.h).toBe(1169);
    expect(one.figure.size).toBe(both.figure.size);
  });

  it("a picture too small to carry words keeps the band inside itself and never sizes a word to nothing", () => {
    const lay = stampLayout(40, 30, "12 ft 0 in", "Measured length");
    expect(lay.band.y).toBeGreaterThanOrEqual(0);
    expect(lay.band.y + lay.band.h).toBeLessThanOrEqual(30);
    expect(lay.figure.size).toBe(MIN_FIGURE_PX);
    expect(lay.label!.size).toBe(MIN_LABEL_PX);
    // Nonsense sizes are a picture of one pixel, not a crash.
    expect(() => stampLayout(0, Number.NaN, "1 in", "x")).not.toThrow();
  });

  it("the default measure is a rough one: longer words are wider, bigger words are wider", () => {
    expect(roughWidth("12 ft 0 in", 80)).toBeGreaterThan(roughWidth("9 in", 80));
    expect(roughWidth("9 in", 80)).toBeGreaterThan(roughWidth("9 in", 40));
  });
});

describe("stampFigure: the file as it came, whenever the figure cannot be drawn", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A stand-in canvas that records what was drawn on it. */
  function fakePage(o: { context?: boolean; blob?: Blob | null } = {}) {
    const drawn: unknown[][] = [];
    const ctx = {
      font: "",
      fillStyle: "",
      textAlign: "",
      textBaseline: "",
      drawImage: (...a: unknown[]) => drawn.push(["image", ...a.slice(1)]),
      measureText: (text: string) => ({ width: text.length * 10 }),
      fillRect: (...a: unknown[]) => drawn.push(["band", ...a]),
      fillText(this: { font: string }, ...a: unknown[]) {
        drawn.push(["text", ...a, this.font]);
      },
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => (o.context === false ? null : ctx),
      toBlob: (done: (b: Blob | null) => void, type: string) => done(o.blob === undefined ? new Blob([new Uint8Array([1, 2, 3])], { type }) : o.blob),
    };
    vi.stubGlobal("document", { createElement: () => canvas });
    return { drawn, canvas };
  }
  const bitmap = (w: number, h: number) => {
    const close = vi.fn();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: w, height: h, close })));
    return close;
  };

  it("no page to draw on (a server, this test): the same file", async () => {
    const file = picture();
    expect(typeof document).toBe("undefined");
    expect(await stampFigure(file, "12 ft 0 in", "Measured length")).toBe(file);
  });

  it("no figure to draw: the same file", async () => {
    fakePage();
    bitmap(738, 1600);
    const file = picture();
    expect(await stampFigure(file, "   ", "Measured length")).toBe(file);
  });

  it("a picture that will not decode: the same file", async () => {
    fakePage();
    vi.stubGlobal("createImageBitmap", vi.fn(async () => { throw new Error("The source image could not be decoded."); }));
    const file = picture();
    expect(await stampFigure(file, "12 ft 0 in", "Measured length")).toBe(file);
  });

  it("a canvas with no drawing surface, and an encoder that hands nothing back: the same file", async () => {
    const file = picture();
    fakePage({ context: false });
    bitmap(738, 1600);
    expect(await stampFigure(file, "12 ft 0 in", "Measured length")).toBe(file);
    vi.unstubAllGlobals();
    fakePage({ blob: null });
    const close = bitmap(738, 1600);
    expect(await stampFigure(file, "12 ft 0 in", "Measured length")).toBe(file);
    // The decoded picture is let go either way.
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("drawn: the picture, then the band, then the label and the figure where the layout says, and a JPEG back under the same name", async () => {
    const { drawn, canvas } = fakePage();
    const close = bitmap(738, 1600);
    const file = picture("measure-1731300000000.jpeg");
    const out = await stampFigure(file, "12 ft 0 in", "Measured length");
    expect(out).not.toBe(file);
    expect(out.type).toBe("image/jpeg");
    expect(out.name).toBe("measure-1731300000000.jpg");
    expect(out.size).toBe(3);
    expect([canvas.width, canvas.height]).toEqual([738, 1600]);

    const lay = stampLayout(738, 1600, "12 ft 0 in", "Measured length", (text) => text.length * 10);
    expect(drawn.map((d) => d[0])).toEqual(["image", "band", "text", "text"]);
    expect(drawn[0]).toEqual(["image", 0, 0, 738, 1600]);
    expect(drawn[1]).toEqual(["band", lay.band.x, lay.band.y, lay.band.w, lay.band.h]);
    expect(drawn[2].slice(0, 4)).toEqual(["text", "Measured length", lay.label!.x, lay.label!.y]);
    expect(drawn[3].slice(0, 4)).toEqual(["text", "12 ft 0 in", lay.figure.x, lay.figure.y]);
    // The figure is the heavy line, at the layout's size.
    expect(String(drawn[3][4])).toMatch(new RegExp(`^700 ${lay.figure.size}px `));
    expect(String(drawn[2][4])).toMatch(new RegExp(`^600 ${lay.label!.size}px `));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("a picture bigger than the cap is drawn down to it, never up", async () => {
    const { canvas } = fakePage();
    bitmap(4400, 2200);
    await stampFigure(picture(), "12 ft 0 in", "Measured length");
    expect([canvas.width, canvas.height]).toEqual([STAMP_MAX_DIM, STAMP_MAX_DIM / 2]);
    bitmap(400, 300);
    await stampFigure(picture(), "12 ft 0 in", "Measured length");
    expect([canvas.width, canvas.height]).toEqual([400, 300]);
  });
});
