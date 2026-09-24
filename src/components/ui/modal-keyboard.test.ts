import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keyboardClosed, revealScroll } from "./modal-keyboard";

// Figures measured on an iPhone 16 Pro simulator (402x874, iOS 18.6), New Job, Description
// focused — in the CNShell WKWebView and in Safari (report 62be0852).
describe("keyboardClosed — measured against the layout viewport, never innerHeight", () => {
  it("reads OPEN with the keyboard up in the shell, where innerHeight shrank with it", () => {
    const innerHeight = 494; // iOS 18: tracks the visual viewport
    const vvHeight = 494;
    const clientHeight = 874; // the layout viewport: does not move with the keyboard
    // The old test, `vv.height >= innerHeight - 1`, said closed — the bug.
    expect(vvHeight >= innerHeight - 1).toBe(true);
    expect(keyboardClosed(vvHeight, clientHeight)).toBe(false);
  });

  it("reads OPEN in Safari too (678 → 410)", () => {
    expect(keyboardClosed(410, 678)).toBe(false);
  });

  it("reads CLOSED at full height, and when there is nothing to measure", () => {
    expect(keyboardClosed(874, 874)).toBe(true);
    expect(keyboardClosed(873.5, 874)).toBe(true);
    expect(keyboardClosed(500, 0)).toBe(true);
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

describe("the Modal uses both", () => {
  const src = readFileSync(join(process.cwd(), "src/components/ui/modal.tsx"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
  it("decides keyboard-closed from documentElement.clientHeight, not innerHeight", () => {
    expect(code).toContain("keyboardClosed(vv.height, document.documentElement.clientHeight)");
    expect(code).not.toMatch(/vv\.height >= window\.innerHeight/);
  });
  it("scrolls the panel body, not the page, and stays in place (no portal by default)", () => {
    expect(code).toContain("body.scrollTop += delta");
    expect(code).toContain("ref={bodyRef}");
    expect(code).toMatch(/portal = false/);
    expect(code).toContain('lockBodyForModal()');
  });
});
