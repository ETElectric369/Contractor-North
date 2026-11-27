import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * ZOOM IN THE DOCUMENT PREVIEW: what the viewer does with lib/pdf-zoom.
 *
 * What a touch MEANS (a pinch, a tap, a double tap, when a pinch is over) is lib/pdf-zoom's
 * gestureStep(), pure, and driven event by event in the test beside it. These are the rules a
 * browser is needed to FEEL and a reader of the source can still hold: who a touch belongs to, when
 * the document counts as on the screen, what a fresh draw does to the zoom, and what the sharper
 * drawing may and may not do to the screen and to memory. Each was seen red once on the real file.
 *
 * WHAT A READER OF THE SOURCE CANNOT HOLD was driven with the real viewer, bundled from this source
 * into a stand-in page kept outside the repository, in two real engines on 2026-11-27: the desktop
 * app's browser with synthetic fingers and the iPhone simulator's Safari with real ones. That is
 * where the gesture while pages were still being drawn, and the second pinch that lost its moves
 * when a sheet was swapped under it, were seen: no test in this file would have found either.
 */
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const VIEWER = read("src/app/print/pdf-preview/viewer.tsx");
const CSS = read("src/app/globals.css");

/** The text of one function or handler: from its first line to the line that begins the next thing. */
function body(from: string, to: string): string {
  const a = VIEWER.indexOf(from);
  expect(a, `not found: ${from}`).toBeGreaterThan(-1);
  const b = VIEWER.indexOf(to, a + from.length);
  expect(b, `not found after it: ${to}`).toBeGreaterThan(a);
  return VIEWER.slice(a, b);
}

const PAINT = body("const paint = useCallback", "const ready = useCallback");
const READY = body("const ready = useCallback", "const sharpen = useCallback");
const SHARPEN = body("const sharpen = useCallback", "const sharpenSoonAfter = useCallback");
const SOON = body("const sharpenSoonAfter = useCallback", "// ── PINCH, DOUBLE TAP, CTRL + WHEEL");
const LOAD = body("const load = useCallback", "useEffect(() => {");
const SHOW = body("const show = (zoom: number, hold: Hold, fingers: Point) => {", "const letGo = () => {");
const CARRY = body("const carryOut = (act: GestureAct, e: Event | null) => {", "const step = (ev: GestureEvent, e: Event | null) => {");
const SHOW_ACT = body('if (act.kind === "show") {', 'if (act.kind === "finish") {');
const FINISH_ACT = body('if (act.kind === "finish") {', 'if (act.kind === "drop") {');
const HOLD_ACT = body('if (act.kind === "hold") {', 'if (act.kind === "show") {');
const START = body("const onTouchStart = (e: TouchEvent) => {", "const onTouchMove = (e: TouchEvent) => {");
const AFTER_LIFT = body("const afterLift = (still: Point[]) => {", "const onTouchEnd = (e: TouchEvent) => {");
const END = body("const onTouchEnd = (e: TouchEvent) => {", "const onTouchCancel = (e: TouchEvent) => {");
const CANCEL = body("const onTouchCancel = (e: TouchEvent) => {", "const onWheel = (e: WheelEvent) => {");
const WHEEL = body("const onWheel = (e: WheelEvent) => {", "const onDoubleClick = (e: MouseEvent) => {");
const DOUBLE_CLICK = body("const onDoubleClick = (e: MouseEvent) => {", 'box.addEventListener("touchstart"');
const REMEMBER = body("const remember = (e: Event) => {", 'box.addEventListener("scroll", remember, true)');

describe("who a touch on the sheets belongs to", () => {
  it("two fingers are the viewer's: the move listener may refuse the browser, and the show act does", () => {
    // A passive listener cannot call preventDefault(): the browser ignores it and says so in the console.
    expect(VIEWER).toContain('box.addEventListener("touchmove", onTouchMove, { passive: false })');
    expect(SHOW_ACT).toContain("e?.preventDefault();");
  });

  it("nothing held is nothing refused: the show act refuses the browser only after it has a hold", () => {
    const guard = SHOW_ACT.indexOf("if (!hold) return;");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(SHOW_ACT.indexOf("e?.preventDefault()"));
    // …and preventDefault is called nowhere else in the gesture's carrying out.
    expect(CARRY.match(/preventDefault/g)?.length).toBe(1);
  });

  it("the start of a touch refuses nothing at all, so a scroll never waits on this listener", () => {
    expect(VIEWER).toContain('box.addEventListener("touchstart", onTouchStart, { passive: true })');
    expect(START).not.toContain("preventDefault");
    // It hands the step no event to refuse.
    expect(START).toMatch(/zoom: zoomRef\.current \}, null\);/);
  });

  it("a plain wheel is the scroller's too: only ctrl + wheel zooms, and only then is the browser refused", () => {
    const guard = WHEEL.indexOf("if (!e.ctrlKey || !ready()) return;");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(WHEEL.indexOf("e.preventDefault()"));
    expect(VIEWER).toContain('box.addEventListener("wheel", onWheel, { passive: false })');
  });

  it("a mouse's double click goes through the one rule about the double click a tap makes up", () => {
    expect(DOUBLE_CLICK).toContain("if (!mouseDoubleClickCounts(Date.now(), touchedAt)) return;");
  });

  it("every listener that goes on comes off", () => {
    for (const name of ["touchstart", "touchmove", "touchend", "touchcancel", "wheel", "dblclick"]) {
      expect(VIEWER, name).toContain(`box.addEventListener("${name}"`);
      expect(VIEWER, name).toContain(`box.removeEventListener("${name}"`);
    }
  });

  it("the stylesheet tells a browser the same thing: pan only, on the scroller and on its turned face", () => {
    const rule = /\.pdf-pages-scroll,\s*\.pdf-pages-scroll > \.turn-face \{\s*touch-action: pan-x pan-y;\s*\}/;
    expect(CSS).toMatch(rule);
  });

  it("a gesture holds a PAGE BY NUMBER, never a sheet element, because a sharper drawing replaces the element", () => {
    expect(VIEWER).toContain("type Hold = { page: string; place: Point; epoch: number };");
    expect(SHOW).toContain("sheets.find((s) => s.dataset.page === hold.page)");
  });

  it("the way the phone is held is the turned face's own word", () => {
    const held = body("function heldNow(", "function sheetsIn(");
    expect(held).toContain(':scope > .turn-face[data-held]")?.dataset.held');
    expect(held).toContain("EVERY_WAY_HELD.find((h) => h === word)");
  });
});

describe("what the gesture rule's answers are made into", () => {
  it("the touch handlers ask lib/pdf-zoom, and nothing in the viewer decides a tap or a pinch", () => {
    expect(VIEWER).toContain("const next = gestureStep(gesture, ev);");
    expect(VIEWER).not.toMatch(/e\.touches\.length/);
    expect(VIEWER).not.toContain("wasPinch");
  });

  it("a hold takes the place under the fingers and nothing else: who may sharpen is the finger rule's", () => {
    expect(HOLD_ACT).toContain("hold = holdAt(act.at);");
    expect(HOLD_ACT).not.toContain("sharpen");
  });

  it("a pinch draws at most once a frame", () => {
    const once = SHOW_ACT.indexOf("if (frame) return;");
    expect(once).toBeGreaterThan(-1);
    expect(once).toBeLessThan(SHOW_ACT.indexOf("requestAnimationFrame("));
  });

  it("a finish shows the last ask now, lets go, and asks for a sharpen; a drop asks for none", () => {
    const last = FINISH_ACT.indexOf("if (hold && asked) show(asked.zoom, hold, asked.fingers);");
    expect(last).toBeGreaterThan(-1);
    expect(last).toBeLessThan(FINISH_ACT.indexOf("letGo();"));
    expect(FINISH_ACT).toContain("sharpenSoonAfter();");
    const drop = body('if (act.kind === "drop") {', "toggleAt(act.at);");
    expect(drop).toContain("letGo();");
    expect(drop).not.toContain("sharpenSoonAfter");
  });

  it("show() refuses a document that is not whole, or a hold taken before a fresh draw, and writes the zoom", () => {
    expect(SHOW).toContain("if (!ready() || hold.epoch !== epoch.current) return;");
    expect(SHOW).toContain("zoomRef.current = zoom;");
  });
});

describe("no sheet is swapped under a finger", () => {
  // A browser sends every later event of a touch to the element the finger first landed on, and an
  // element taken off the page no longer passes them up to the box. Seen with the real viewer in a
  // real engine on 2026-11-27: a second pinch, made while the sharper drawing of the first was under
  // way, lost its moves the moment that drawing swapped the sheet under the fingers.
  it("a finger landing marks the glass and stops the sharper drawing under way, before the rule is asked", () => {
    const mark = START.indexOf("fingerDown.current = true;");
    const stop = START.indexOf("sharpenRun.current++;");
    expect(mark).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(-1);
    expect(START.indexOf("step(")).toBeGreaterThan(Math.max(mark, stop));
  });

  it("no sharper drawing starts while a finger is down", () => {
    expect(SOON).toContain("if (!pdf || fingerDown.current || !ready()) return;");
  });

  it("the sharper drawing swaps a sheet in the same step as its last check, with no wait between", () => {
    const swap = SHARPEN.indexOf("host.replaceChild(canvas, there);");
    const check = SHARPEN.lastIndexOf("if (gone()) return;", swap);
    expect(check).toBeGreaterThan(-1);
    expect(swap).toBeGreaterThan(check);
    expect(SHARPEN.slice(check, swap)).not.toContain("await");
  });

  it("every put back happens before the first wait of a sharper drawing", () => {
    const putBack = SHARPEN.indexOf("host.replaceChild(base, sharp)");
    expect(putBack).toBeGreaterThan(-1);
    expect(SHARPEN.indexOf("await")).toBeGreaterThan(putBack);
  });

  it("each lift says how many fingers are left, and the last one up asks again while anything is zoomed or sharp", () => {
    expect(AFTER_LIFT).toContain("fingerDown.current = still.length > 0;");
    expect(AFTER_LIFT).toContain("if (!fingerDown.current && (zoomRef.current > FIT || bases.current.size > 0)) sharpenSoonAfter();");
    for (const handler of [END, CANCEL]) {
      const asked = handler.indexOf("step(");
      expect(asked).toBeGreaterThan(-1);
      expect(handler.indexOf("afterLift(")).toBeGreaterThan(asked);
    }
  });

  it("a fresh draw clears the mark in the step that empties the list, because that finger's lift never arrives", () => {
    const emptied = PAINT.indexOf('host.innerHTML = ""');
    const cleared = PAINT.indexOf("fingerDown.current = false;");
    expect(emptied).toBeGreaterThan(-1);
    expect(cleared).toBeGreaterThan(emptied);
    expect(PAINT.slice(emptied, cleared)).not.toContain("await");
  });
});

describe("ready means the whole document is on the screen", () => {
  it("ready() asks for a whole draw, no fetch, and sheets", () => {
    expect(READY).toContain("drawnWhole.current && !turns.current.isLoading()");
    expect(READY).toContain('querySelector("canvas.pdf-page-canvas")');
  });

  it("a load and a fresh draw each say it is not whole, right where they start, and move the epoch", () => {
    expect(LOAD).toMatch(/turns\.current\.startLoad\(\);\s*drawnWhole\.current = false;\s*epoch\.current\+\+;/);
    expect(PAINT).toMatch(/turns\.current\.startPaint\(containerW\);[^]*?drawnWhole\.current = false;\s*epoch\.current\+\+;/);
    expect(PAINT.indexOf("drawnWhole.current = false;")).toBeLessThan(PAINT.indexOf('host.innerHTML = ""'));
  });

  it("only a fresh draw that finished as the owner says it is whole, and nothing else does", () => {
    expect(PAINT).toMatch(/if \(!turns\.current\.finishedPaint\(seq, containerW\)\) return;\s*drawnWhole\.current = true;/);
    expect(VIEWER.match(/drawnWhole\.current = true/g)?.length).toBe(1);
  });
});

describe("a fresh draw is a fitted one", () => {
  it("paint() puts the zoom back to FIT before it empties the list, and drops a waiting sharpen", () => {
    const reset = PAINT.indexOf("zoomRef.current = FIT;");
    expect(reset).toBeGreaterThan(-1);
    expect(reset).toBeLessThan(PAINT.indexOf('host.innerHTML = ""'));
    expect(PAINT).toContain("clearTimeout(sharpenSoon.current);");
  });

  it("paint() lets go of every sharp sheet and every kept one before it empties the list", () => {
    const letGo = PAINT.indexOf("letGoOfSharp(host, bases.current);");
    expect(letGo).toBeGreaterThan(-1);
    expect(letGo).toBeLessThan(PAINT.indexOf('host.innerHTML = ""'));
    const fn = body("function letGoOfSharp(", "/**\n * The document PDF viewer.");
    expect(fn).toContain("bases.clear();");
    expect(fn).toContain('canvas[data-sharp="1"]');
  });

  it("every sheet carries its page number and the size it was fitted at", () => {
    expect(PAINT).toContain("canvas.dataset.page = String(n);");
    expect(PAINT).toContain("canvas.dataset.fitW = String(cssW);");
    expect(PAINT).toContain("canvas.dataset.fitH = String(cssH);");
  });

  it("leaving the screen lets go too, and stops a sharpen under way", () => {
    const leaving = body("turnsOnLeaving.abandonAll();", "setBlobUrl((old) => {");
    expect(leaving).toContain("clearTimeout(sharpenSoon.current);");
    expect(leaving).toContain("moveTheEpochOnLeaving();");
    expect(VIEWER).toMatch(/const moveTheEpochOnLeaving = \(\) => \{\s*epoch\.current\+\+;/);
    expect(leaving).toContain("letGoOfSharp(host, keptOnLeaving);");
  });
});

describe("the sharper drawing is a guest, not a paint turn", () => {
  it("it takes no turn, settles none, and never touches Print, the screen's state or the list", () => {
    for (const word of [
      "startPaint",
      "finishedPaint",
      "paintOwns",
      "startLoad",
      "settled(",
      "setAllPainted",
      "setState",
      "setError",
      "repainting.current",
      "innerHTML",
    ]) {
      expect(SHARPEN, word).not.toContain(word);
    }
  });

  it("it refuses to start unless the whole document is drawn and nothing is being fetched", () => {
    expect(SHARPEN).toContain("if (!host || !drawnWhole.current || turns.current.isLoading()) return;");
  });

  it("after every wait it checks its own run and the epoch, and stops", () => {
    expect(SHARPEN).toContain("const gone = () => sharpenRun.current !== run || epoch.current !== ep;");
    const waits = SHARPEN.match(/await /g)?.length ?? 0;
    expect(waits).toBe(2);
    expect(SHARPEN.match(/;\s*if \(gone\(\)\) return;/g)?.length).toBe(waits);
    // …and what it was drawing gives its memory back however it stops.
    expect(SHARPEN).toMatch(/finally \{[^}]*release\(drawing\);/);
  });

  it("it starts from the sheet being read and takes at most SHARP_MOST on the glass", () => {
    expect(SHARPEN).toContain("nearestFirst(sheets.length, sheetBeingRead(sheets, scroller))");
    expect(SHARPEN).toContain("if (wanted.length >= SHARP_MOST) break;");
    expect(SHARPEN).toContain("onScreen(sheets[i].getBoundingClientRect(), view)");
    // At FIT none is wanted.
    expect(SHARPEN).toContain("if (zoomRef.current > FIT && scroller) {");
  });

  it("memory falls before it rises: every put back comes before the first drawing", () => {
    const putBack = SHARPEN.indexOf("host.replaceChild(base, sharp);");
    expect(putBack).toBeGreaterThan(-1);
    // …walking every sheet on the screen, not some of them.
    expect(SHARPEN).toContain("const sheets = sheetsIn(host);");
    expect(SHARPEN).toMatch(/for \(const sharp of sheets\) \{\s*const page = sharp\.dataset\.page;/);
    expect(putBack).toBeLessThan(SHARPEN.indexOf("await pdf.getPage("));
    // A sheet put back releases the sharp one at once and is forgotten.
    const after = SHARPEN.slice(putBack, SHARPEN.indexOf("await pdf.getPage("));
    expect(after).toMatch(/release\(sharp\);\s*kept\.delete\(page\);/);
    // A released canvas gives its bitmap back: width and height to nothing.
    const rel = body("function release(", "/**\n * LET GO OF EVERY SHARP SHEET");
    expect(rel).toContain("canvas.width = 0;");
    expect(rel).toContain("canvas.height = 0;");
  });

  it("the fitted sheet is kept the first time; a sharp one replaced by a sharper one is released", () => {
    expect(SHARPEN).toMatch(/if \(there\.dataset\.sharp === "1"\) release\(there\);\s*else kept\.set\(n, there\);/);
    expect(SHARPEN).toContain('canvas.dataset.sharp = "1";');
  });

  it("the sheet is found again after each wait, by page number, never held across one", () => {
    expect(SHARPEN).toContain("const there = sheetFor(host, n);");
    expect(SHARPEN).toContain("host.replaceChild(canvas, there);");
    // The drawing loop walks page numbers; the list of sheets read before it is not used past its block.
    const loop = SHARPEN.slice(SHARPEN.indexOf("for (const n of wanted) {"));
    expect(loop.length).toBeLessThan(SHARPEN.length);
    expect(loop).not.toMatch(/\bsheets(\[|\.|\)|,)/);
  });

  it("draws at a short document's density under the per-sheet cap, and only for clearly more detail", () => {
    expect(SHARPEN).toContain("const dpr = sharpnessFor(1);");
    expect(SHARPEN).toContain("const density = drawDensity(size.width, dpr);");
    expect(SHARPEN).toContain("if (!worthSharpening(sheet.width, across)) continue;");
    expect(PAINT).toContain("const dpr = sharpnessFor(pdf.numPages);");
  });

  it("gives the new sheet the size the screen shows NOW, read after the page was drawn", () => {
    const drawn = SHARPEN.indexOf("await page.render(");
    const now = SHARPEN.indexOf("const now = zoomedSize(fitted, zoomRef.current);");
    expect(drawn).toBeGreaterThan(-1);
    expect(now).toBeGreaterThan(drawn);
    expect(now).toBeLessThan(SHARPEN.indexOf("host.replaceChild(canvas, there)"));
  });
});

describe("when the sharper drawing runs", () => {
  it("it waits for things to be still, and never starts under a finger or while the document is being fetched or drawn", () => {
    expect(SOON).toContain("clearTimeout(sharpenSoon.current);");
    expect(SOON).toContain("if (!pdf || fingerDown.current || !ready()) return;");
    expect(SOON).toContain("void sharpen(pdf);");
  });

  it("a scroll asks for it only while zoomed, and never during a repaint", () => {
    const guard = REMEMBER.indexOf("if (repainting.current) return");
    const ask = REMEMBER.indexOf("if (zoomRef.current > FIT) sharpenSoonAfter();");
    expect(guard).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(guard);
  });
});

describe("what print still does", () => {
  it("a sheet prints the width of the paper whatever size the screen was showing it at", () => {
    expect(CSS).toMatch(/\.pdf-page-canvas \{ width: 100% !important; height: auto !important;/);
  });
});
