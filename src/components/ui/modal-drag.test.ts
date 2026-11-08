import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CATALOGS, dict, translator } from "@/lib/i18n";
import { LangProvider } from "@/components/lang-provider";
import { Modal } from "./modal";
import { MODAL_WORDS } from "./modal-words";
import { clampOffset, isDragTarget, pastThreshold, type Offset } from "./modal-drag";

/**
 * EVERY POP-UP CAN BE DRAGGED OUT OF THE WAY (Erik, 2026-11-07: "could we make it so all pop-up boxes can be
 * moved around on screen by dragging them so i can see relevant information in the background? that would be
 * amazing everywhere actually"). Every pop-up is the one Modal, so the rules are pinned once, here: where
 * the panel may go, what counts as a drag, what on the title bar is a handle and what keeps its own job —
 * and that a sheet at rest renders byte for byte the markup it rendered before the drag existed.
 */

// A 1000×800 room with the default 8px margin; a 400×300 panel centered in it (left 300, top 250).
const ROOM = { width: 1000, height: 800 };
const CENTERED = { left: 300, top: 250, width: 400, height: 300 };
const REST: Offset = { x: 0, y: 0 };

describe("clampOffset — the panel stays inside the viewport, a margin on every side", () => {
  it("a centered panel dragged a little moves exactly that far", () => {
    expect(clampOffset({ x: 20, y: -10 }, CENTERED, REST, ROOM)).toEqual({ x: 20, y: -10 });
    expect(clampOffset({ x: -150, y: 120 }, CENTERED, REST, ROOM)).toEqual({ x: -150, y: 120 });
  });

  it("dragged far left / right / up / down it stops at the margin", () => {
    // Left edge at 8: 8 − 300. Right edge at 1000 − 8: left 592, so 592 − 300.
    expect(clampOffset({ x: -1000, y: 0 }, CENTERED, REST, ROOM)).toEqual({ x: -292, y: 0 });
    expect(clampOffset({ x: 1000, y: 0 }, CENTERED, REST, ROOM)).toEqual({ x: 292, y: 0 });
    // Top edge at 8: 8 − 250. Bottom edge at 800 − 8: top 492, so 492 − 250.
    expect(clampOffset({ x: 0, y: -1000 }, CENTERED, REST, ROOM)).toEqual({ x: 0, y: -242 });
    expect(clampOffset({ x: 0, y: 1000 }, CENTERED, REST, ROOM)).toEqual({ x: 0, y: 242 });
    // Both at once, into a corner.
    expect(clampOffset({ x: -5000, y: 5000 }, CENTERED, REST, ROOM)).toEqual({ x: -292, y: 242 });
  });

  it("a panel wider than the room covers it and never drifts out: its left edge stays between room − margin − width and margin", () => {
    const wide = { left: -100, top: 250, width: 1200, height: 300 }; // centered: 100px over on each side
    expect(clampOffset({ x: 500, y: 0 }, wide, REST, ROOM)).toEqual({ x: 108, y: 0 }); // left edge 8
    expect(clampOffset({ x: -500, y: 0 }, wide, REST, ROOM)).toEqual({ x: -108, y: 0 }); // left edge −208, right edge 992
    expect(clampOffset({ x: 50, y: 0 }, wide, REST, ROOM)).toEqual({ x: 50, y: 0 }); // inside the band: exact
    const tall = { left: 300, top: -100, width: 400, height: 1000 };
    expect(clampOffset({ x: 0, y: 500 }, tall, REST, ROOM)).toEqual({ x: 0, y: 108 });
    expect(clampOffset({ x: 0, y: -500 }, tall, REST, ROOM)).toEqual({ x: 0, y: -108 });
  });

  it("a rect measured while the panel already sits at an offset is read back to offset 0 first", () => {
    // The same centered panel, measured after a drag of (100, 40): its rect is 100/40 further along.
    const have = { x: 100, y: 40 };
    const measured = { left: 400, top: 290, width: 400, height: 300 };
    expect(clampOffset({ x: 120, y: 60 }, measured, have, ROOM)).toEqual({ x: 120, y: 60 });
    expect(clampOffset({ x: 1000, y: 0 }, measured, have, ROOM)).toEqual({ x: 292, y: 0 }); // the same limit as from rest
    expect(clampOffset({ x: 0, y: -1000 }, measured, have, ROOM)).toEqual({ x: 0, y: -242 });
  });

  it("margin 0 lets the panel touch the edges", () => {
    expect(clampOffset({ x: -1000, y: -1000 }, CENTERED, REST, ROOM, 0)).toEqual({ x: -300, y: -250 });
    expect(clampOffset({ x: 1000, y: 1000 }, CENTERED, REST, ROOM, 0)).toEqual({ x: 300, y: 250 });
  });
});

describe("pastThreshold — a tap is not a drag", () => {
  it("nothing moves until the pointer has travelled more than 3px", () => {
    expect(pastThreshold({ x: 10, y: 10 }, { x: 10, y: 10 })).toBe(false);
    expect(pastThreshold({ x: 10, y: 10 }, { x: 12, y: 12 })).toBe(false); // 2.83px
    expect(pastThreshold({ x: 10, y: 10 }, { x: 13, y: 10 })).toBe(false); // exactly 3: not past it
    expect(pastThreshold({ x: 10, y: 10 }, { x: 14, y: 10 })).toBe(true);
    expect(pastThreshold({ x: 10, y: 10 }, { x: 13, y: 13 })).toBe(true); // 4.24px
    expect(pastThreshold({ x: 10, y: 10 }, { x: 10, y: 6 })).toBe(true);
  });

  it("takes another threshold when asked", () => {
    expect(pastThreshold({ x: 0, y: 0 }, { x: 8, y: 0 }, 10)).toBe(false);
    expect(pastThreshold({ x: 0, y: 0 }, { x: 11, y: 0 }, 10)).toBe(true);
  });
});

/**
 * The title bar as a tree of plain objects (the stand-in idiom of glass-menu.test.ts): the bar, its title,
 * the X with its icon, and the controls a caller could put in a bar one day.
 */
type Fake = { tagName: string; parentElement: Fake | null; getAttribute: (name: string) => string | null };
function titleBar() {
  const el = (tagName: string, parentElement: Fake | null, attrs: Record<string, string> = {}): Fake => ({
    tagName,
    parentElement,
    getAttribute: (name) => attrs[name] ?? null,
  });
  const header = el("DIV", null);
  const h2 = el("H2", header);
  const titleSpan = el("SPAN", h2);
  const x = el("BUTTON", header);
  const icon = el("svg", x); // an SVG element reports a lowercase tagName
  const iconPath = el("path", icon);
  const link = el("A", header);
  const linkText = el("SPAN", link);
  const roleButton = el("DIV", header, { role: "button" });
  const inRoleButton = el("SPAN", roleButton);
  const input = el("INPUT", header);
  const select = el("SELECT", header);
  const textarea = el("TEXTAREA", header);
  const outside = el("DIV", null);
  return { header, h2, titleSpan, x, icon, iconPath, link, linkText, roleButton, inRoleButton, input, select, textarea, outside };
}
const target = (f: Fake | null) => f as unknown as EventTarget | null;
const handle = (f: Fake) => f as unknown as Element;

describe("isDragTarget — the bar and its title are the handle; a control inside it keeps its own job", () => {
  const bar = titleBar();

  it("the bar itself, the title and plain text inside the title start a drag", () => {
    expect(isDragTarget(target(bar.header), handle(bar.header))).toBe(true);
    expect(isDragTarget(target(bar.h2), handle(bar.header))).toBe(true);
    expect(isDragTarget(target(bar.titleSpan), handle(bar.header))).toBe(true);
  });

  it("the X does not — nor its icon, nor anything inside a button, so it still closes", () => {
    expect(isDragTarget(target(bar.x), handle(bar.header))).toBe(false);
    expect(isDragTarget(target(bar.icon), handle(bar.header))).toBe(false);
    expect(isDragTarget(target(bar.iconPath), handle(bar.header))).toBe(false);
  });

  it("a link, a field, a select, a textarea or a role=button inside the bar keep their own jobs", () => {
    expect(isDragTarget(target(bar.link), handle(bar.header))).toBe(false);
    expect(isDragTarget(target(bar.linkText), handle(bar.header))).toBe(false);
    expect(isDragTarget(target(bar.roleButton), handle(bar.header))).toBe(false);
    expect(isDragTarget(target(bar.inRoleButton), handle(bar.header))).toBe(false);
    expect(isDragTarget(target(bar.input), handle(bar.header))).toBe(false);
    expect(isDragTarget(target(bar.select), handle(bar.header))).toBe(false);
    expect(isDragTarget(target(bar.textarea), handle(bar.header))).toBe(false);
  });

  it("nothing, or something outside the bar, is not a drag", () => {
    expect(isDragTarget(null, handle(bar.header))).toBe(false);
    expect(isDragTarget(target(bar.outside), handle(bar.header))).toBe(false);
  });
});

// Children go in createElement's third argument (react/no-children-prop), as row-more-sheet.test.ts does.
const el = <P extends object>(type: FunctionComponent<P>, props: Omit<P, "children">, children: ReactNode) =>
  createElement(type, props as P, children);
const sheet = (title: string) => el(Modal, { open: true, onClose: () => {}, title }, "the body");

describe("the sheet at rest: the handle is marked, nothing else has moved", () => {
  const html = renderToStaticMarkup(sheet("A Sheet"));

  it("the title bar carries the grab cursor and the hint, and the title and the X keep their markup", () => {
    expect(html).toContain(
      '<div class="flex shrink-0 items-center justify-between border-b border-slate-100 px-6 py-4 cursor-grab active:cursor-grabbing select-none touch-none" title="Drag to move this. Double-click to put it back."><h2 class="text-base font-semibold text-slate-900">A Sheet</h2>',
    );
    expect(html).toMatch(/<button class="rounded-lg p-1\.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-40" aria-label="Close">/);
  });

  it("the panel carries no inline left/top (no style at all) and the scrim is the full /40", () => {
    expect(html).toMatch(/<div class="relative z-10 flex max-h-\[calc\(100dvh-max\(0\.75rem,var\(--sat,0px\)\)-0\.75rem\)\] w-full max-w-lg flex-col rounded-2xl bg-white shadow-xl">/);
    expect(html).not.toContain("style=");
    expect(html).toContain('<div class="fixed inset-0 bg-slate-900/40"></div>');
    expect(html).not.toContain("bg-slate-900/15");
  });

  it("in Spanish the hint and the X read Spanish", () => {
    const es = renderToStaticMarkup(el(LangProvider, { lang: "es" }, sheet("Una Hoja")));
    expect(es).toContain('title="Arrastra para moverla. Doble clic para regresarla."');
    expect(es).toContain('aria-label="Cerrar"');
    expect(es).not.toContain("Drag to move");
  });
});

describe("the hint is a sheet word: one spelling in the component and the agenda catalog", () => {
  it("ag_modalDragHint reads modal-words in both languages, a sentence (so the Title Case judge leaves it alone), and the catalog names the sheet", () => {
    expect(translator("en")("ag_modalDragHint")).toBe(MODAL_WORDS.en.dragHint);
    expect(translator("es")("ag_modalDragHint")).toBe(MODAL_WORDS.es.dragHint);
    expect(dict("es").ag_modalDragHint).not.toBe(dict("en").ag_modalDragHint);
    expect(MODAL_WORDS.en.dragHint).toMatch(/\.$/);
    expect(MODAL_WORDS.es.dragHint).toMatch(/\.$/);
    expect(CATALOGS.find((c) => c.prefix === "ag_")?.files).toContain("src/components/ui/modal.tsx");
  });
});

describe("the Modal wires the rules: the bar is the handle, left/top moves the panel, never a transform", () => {
  const src = readFileSync(join(process.cwd(), "src/components/ui/modal.tsx"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");

  it("a pointer down on the bar starts a drag only from a handle target, captures the pointer, and moves past the threshold through clampOffset", () => {
    expect(code).toContain("isDragTarget(e.target, e.currentTarget)");
    expect(code).toContain("e.currentTarget.setPointerCapture(e.pointerId)");
    // A capture that throws (InvalidStateError on an inactive pointer) lets go of the ref (skeptic #55): the
    // ref is set before the capture, and `dragRef.current ||` refuses a new drag while one is held, so a
    // throw left in place would block every later drag until the sheet reopened.
    expect(code).toMatch(/try \{\s*e\.currentTarget\.setPointerCapture\(e\.pointerId\);\s*\} catch \{\s*dragRef\.current = null;\s*\}/);
    expect(code).toContain("pastThreshold(drag.start, now)");
    // The resting place is measured ONCE at pointer-down (the rect less the offset it is drawn at) and each
    // move clamps against it: a pointermove is a continuous event React may render behind, so a rect read
    // mid-drag against the closure's offset could pair a fresh rect with a stale offset.
    expect(code).toMatch(/rest: \{ left: rect\.left - vp\.left - offset\.x, top: rect\.top - vp\.top - offset\.y, width: rect\.width, height: rect\.height \}/);
    expect(code).toContain("clampOffset(want, drag.rest, AT_REST, viewportNow())");
    expect(code).toContain("onDoubleClick={onHandleDoubleClick}");
    expect(code).toContain("title={w.dragHint}");
    expect(code).toContain("ref={panelRef}");
  });

  it("the offset is left/top on the panel, written only while moved; no transform, translate or will-change anywhere in the code", () => {
    expect(code).toContain("left: offset.x, top: offset.y");
    expect(code).not.toMatch(/transform|translate|will-change/);
    expect(code).toContain('moved ? "bg-slate-900/15" : "bg-slate-900/40"');
  });

  it("every open starts at rest with no drag in flight, beside the discard guard's own reset", () => {
    expect(code).toMatch(/setConfirmDiscard\(false\);\s*setOffset\(AT_REST\);\s*dragRef\.current = null;/);
  });
});
