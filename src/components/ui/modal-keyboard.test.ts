import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keyboardClosed, nextKeyboardBaseline, revealScroll, type KeyboardBaseline } from "./modal-keyboard";

/** Run a sheet: the heights the visual viewport reports, in order, and what the Modal decides at each. */
function run(frames: { height: number; width?: number }[]): boolean[] {
  let baseline: KeyboardBaseline | null = null;
  return frames.map((f) => {
    baseline = nextKeyboardBaseline(baseline, { height: f.height, width: f.width ?? 402 });
    return keyboardClosed(f.height, baseline.height);
  });
}

// Figures measured on an iPhone 16 Pro simulator (402x874, iOS 18.6), New Job, Description
// focused — in the CNShell WKWebView and in Safari (report 62be0852).
describe("keyboardClosed — measured against the visual viewport's own height when the sheet opened", () => {
  it("iOS 18 in the shell: opens at 874, the keyboard takes it to 494 — OPEN, whatever innerHeight says", () => {
    // innerHeight shrank to 494 with the keyboard: measured against it, 494 read as closed (the bug).
    expect(keyboardClosed(494, 494)).toBe(true);
    expect(run([{ height: 874 }, { height: 494 }])).toEqual([true, false]);
  });

  it("iOS 26 and later, where a page height may move with the keyboard too: still OPEN (no page height is read)", () => {
    // Whatever documentElement.clientHeight or innerHeight do, the sheet opened at 874 and is 494 now.
    expect(run([{ height: 874 }, { height: 494 }, { height: 494 }])).toEqual([true, false, false]);
  });

  it("a page that runs under a floating toolbar: shorter than the page with no keyboard, and still CLOSED", () => {
    // Opened at 812 (the toolbar's share is never counted), the keyboard comes and goes.
    expect(run([{ height: 812 }, { height: 812 }, { height: 440 }, { height: 812 }])).toEqual([true, true, false, true]);
  });

  it("Safari (678 → 410) reads OPEN, and closes again when the keyboard goes", () => {
    expect(run([{ height: 678 }, { height: 410 }, { height: 678 }])).toEqual([true, false, true]);
  });

  it("a sheet opened while a keyboard was still up learns the full height the moment it goes", () => {
    // Opened at 494 (the keyboard of the page underneath), then 874, then a field in the sheet.
    expect(run([{ height: 494 }, { height: 874 }, { height: 494 }])).toEqual([true, true, false]);
  });

  it("a rotation is a new screen: the baseline starts again at the new width", () => {
    // Portrait 874 tall, then landscape (874 wide, 402 tall, no keyboard): closed, not "open by 472px".
    expect(run([{ height: 874, width: 402 }, { height: 402, width: 874 }, { height: 210, width: 874 }])).toEqual([true, true, false]);
  });

  it("nothing to measure against reads closed; a hair of rounding is still closed", () => {
    expect(keyboardClosed(500, 0)).toBe(true);
    expect(keyboardClosed(873.5, 874)).toBe(true);
    expect(nextKeyboardBaseline(null, { height: 700, width: 400 })).toEqual({ height: 700, width: 400 });
    expect(nextKeyboardBaseline({ height: 700, width: 400 }, { height: 650, width: 400 })).toEqual({ height: 700, width: 400 });
  });
});

describe("revealScroll — the field being typed in shows, with its label", () => {
  const view = { top: 119, bottom: 390 }; // the capped body's visible slice

  it("scrolls a field below the slice up into it, label and all", () => {
    const box = { top: 500, bottom: 606 }; // Description's label + textarea, under the keyboard
    const d = revealScroll(box, view);
    expect(d).toBe(606 - (390 - 8));
    expect(box.bottom - d).toBeLessThanOrEqual(view.bottom - 8);
    expect(box.top - d).toBeGreaterThanOrEqual(view.top + 8);
  });

  it("never pushes the label off the top to show the bottom of a tall box", () => {
    const box = { top: 200, bottom: 700 };
    const d = revealScroll(box, view);
    expect(d).toBe(200 - (119 + 8));
    expect(box.top - d).toBe(view.top + 8);
  });

  it("scrolls back down to a field above the slice", () => {
    expect(revealScroll({ top: 60, bottom: 140 }, view)).toBe(60 - 127);
  });

  it("leaves a field that already shows alone", () => {
    expect(revealScroll({ top: 200, bottom: 300 }, view)).toBe(0);
  });
});

describe("the Modal uses them: the header, the field being typed and the Save button stay on screen", () => {
  const src = readFileSync(join(process.cwd(), "src/components/ui/modal.tsx"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
  it("decides keyboard-closed from the sheet's own opening height, never a page height", () => {
    expect(code).toContain("baseline = nextKeyboardBaseline(baseline, { height: vv.height, width: vv.width });");
    expect(code).toContain("keyboardClosed(vv.height, baseline.height)");
    expect(code).not.toMatch(/keyboardClosed\([^)]*(clientHeight|innerHeight)/);
    expect(code).not.toMatch(/vv\.height >= window\.innerHeight/);
  });
  it("with the keyboard up the overlay rides the visual viewport and the panel is capped to it", () => {
    expect(code).toContain("top: kbClosed ? 0 : vv.offsetTop");
    expect(code).toContain("height: vv.height");
    expect(code).toMatch(/setKbMaxH\(`\$\{Math\.max\(200, Math\.round\(vv\.height - satPx - 12\)\)\}px`\)/);
  });
  it("scrolls the panel body, not the page, and stays in place (no portal by default)", () => {
    expect(code).toContain("body.scrollTop += delta");
    expect(code).toContain("ref={bodyRef}");
    expect(code).toMatch(/portal = false/);
    expect(code).toContain('lockBodyForModal()');
  });
});
