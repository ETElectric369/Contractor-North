import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

import { RowMoreSheet, RowMoreSheetView, SheetLink, SHEET_ROW, ROW_MORE_TRIGGER, replacesSheetEntry } from "./row-more-sheet";
import { Modal } from "./ui/modal";
import { createBackStepper, createOverlayStack } from "./ui/overlay-history";

/**
 * THE APP'S ONE ROW ⋯ (My Day's agenda rows first, every Needs You row next). A 44px ⋯ opens a small
 * sheet titled with the row. A row can open a sheet of its own above it (Move To Another Day…, Edit
 * Details…): the ⋯ sheet stays mounted under it, the child stacks above it, and a Back, an Escape or
 * the child's Cancel closes the child only.
 */

const tagOpen = (html: string, from: number) => html.lastIndexOf("<div", from);
// Children go in createElement's third argument (react/no-children-prop), the props cast the way which-job-sheet.test.ts does.
const el = <P extends object>(type: FunctionComponent<P>, props: Omit<P, "children">, children: ReactNode) =>
  createElement(type, props as P, children);

describe("the ⋯ trigger", () => {
  it("is 44px and says which row it is for", () => {
    const html = renderToStaticMarkup(el(RowMoreSheet, { title: "Smith inspection" }, "rows"));
    expect(ROW_MORE_TRIGGER).toContain("h-11 w-11");
    expect(html).toMatch(/<button type="button" aria-label="More For Smith inspection"[^>]*class="[^"]*h-11 w-11[^"]*"/);
    // Closed, the sheet draws nothing.
    expect(html).not.toContain("rows");
  });
});

describe("the sheet", () => {
  it("is titled with the row, a quiet subline under it, then its rows in the row grammar", () => {
    const html = renderToStaticMarkup(
      el(
        RowMoreSheetView,
        { open: true, title: "Smith inspection", subline: "9:00 AM · 41 Larkspur", onClose: () => {} },
        createElement("button", { type: "button", className: SHEET_ROW }, "Mark Done"),
      ),
    );
    expect(html).toContain(">Smith inspection</h2>");
    expect(html).toContain("9:00 AM · 41 Larkspur");
    expect(html).toContain("max-w-sm"); // size sm
    expect(html).toMatch(/<button type="button" class="[^"]*min-h-\[44px\][^"]*">Mark Done<\/button>/);
    expect(html.indexOf("9:00 AM")).toBeLessThan(html.indexOf("Mark Done"));
  });

  it("stays mounted while a child sheet is open; the child renders after it, so it stacks above it at the same z-index", () => {
    const child = el(Modal, { open: true, onClose: () => {}, title: "Move To Another Day" }, "day chips");
    const html = renderToStaticMarkup(el(RowMoreSheetView, { open: true, title: "Smith inspection", onClose: () => {} }, child));
    const sheetTitle = html.indexOf(">Smith inspection</h2>");
    const childTitle = html.indexOf(">Move To Another Day</h2>");
    expect(sheetTitle).toBeGreaterThan(0);
    expect(childTitle).toBeGreaterThan(sheetTitle);
    // Both overlays are the same layer; the child's, later in the tree and inside the sheet, paints on top.
    expect(html.match(/z-\[120\]/g)).toHaveLength(2);
    const sheetOverlay = tagOpen(html, html.indexOf("z-[120]"));
    const childOverlay = html.indexOf("z-[120]", html.indexOf("z-[120]") + 1);
    expect(sheetOverlay).toBeLessThan(sheetTitle);
    expect(childOverlay).toBeGreaterThan(sheetTitle);
    expect(childOverlay).toBeLessThan(childTitle);
    // The child is inside the sheet's body: the sheet is still there under it.
    expect(html.lastIndexOf("</div>")).toBeGreaterThan(childTitle);
  });
});

describe("a row that goes somewhere", () => {
  it("is a 44px link that never closes the sheet first; with the sheet's entry on top, the new page replaces it", () => {
    const html = renderToStaticMarkup(el(SheetLink, { href: "/tasks" }, "Open"));
    expect(html).toMatch(/<a class="[^"]*min-h-\[44px\][^"]*" href="\/tasks">Open<\/a>/);
    expect(replacesSheetEntry({ cnOverlay: true, __NA: true })).toBe(true);
    expect(replacesSheetEntry({ __NA: true })).toBe(false);
    expect(replacesSheetEntry(null)).toBe(false);
    const src = readFileSync(join(process.cwd(), "src/components/row-more-sheet.tsx"), "utf8");
    const link = src.slice(src.indexOf("export function SheetLink"), src.indexOf("export function RowMoreSheetView"));
    expect(link).toContain("router.replace(href);");
    expect(link).not.toContain("close");
  });
});

describe("one Back closes one sheet, the top one (the Modal's overlay stack)", () => {
  const open = (...ids: string[]) => {
    const s = createOverlayStack();
    for (const id of ids) s.open(id);
    return s;
  };
  const button = { pushed: true, popped: false, stillOurs: true };
  const back = { pushed: true, popped: true, stillOurs: false };
  const navigated = { pushed: true, popped: false, stillOurs: false };

  it("a Back with Move open above the ⋯ sheet closes Move only; the next Back closes the sheet", () => {
    const s = open("sheet", "move");
    expect(s.ownsPop("sheet")).toBe(false); // under another: not its Back
    expect(s.ownsPop("move")).toBe(true);
    expect(s.close("move", back)).toBe(0); // its entry is gone already
    expect(s.order).toEqual(["sheet"]);
    expect(s.ownsPop("sheet")).toBe(true);
    expect(s.close("sheet", back)).toBe(0);
  });

  it("closing the child (Cancel, the X) leaves the sheet open: the child's own step back is not a Back", () => {
    const s = open("sheet", "edit");
    expect(s.close("edit", button)).toBe(1); // it takes its own entry off...
    expect(s.ownsPop("sheet")).toBe(false); // ...and that pop is not the sheet's Back
    expect(s.order).toEqual(["sheet"]);
    // A real Back after that is the sheet's.
    expect(s.ownsPop("sheet")).toBe(true);
  });

  it("Escape belongs to the top one too", () => {
    const esc = open("sheet", "move");
    expect(esc.isTop("move")).toBe(true);
    expect(esc.isTop("sheet")).toBe(false);
    esc.close("move", { pushed: false, popped: false, stillOurs: false });
    expect(esc.isTop("sheet")).toBe(true);
  });

  it("a landed Move closes both in one moment, child first: one step of two, not two steps", () => {
    const s = open("sheet", "move");
    const go = vi.fn();
    const later: (() => void)[] = [];
    const step = createBackStepper(go, (fn) => later.push(fn));
    step(s.close("move", button));
    step(s.close("sheet", button));
    expect(go).not.toHaveBeenCalled();
    later.forEach((fn) => fn());
    expect(go).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith(2);
  });

  it("the row going away with both open (parent first): the child takes the sheet's entry off with its own", () => {
    const s = open("sheet", "move");
    expect(s.close("sheet", button)).toBe(0); // under the Move sheet: handed over
    expect(s.close("move", button)).toBe(2);
  });

  it("a link inside the child that navigated: history is left alone, the sheet's entry included", () => {
    const s = open("sheet", "edit");
    expect(s.close("sheet", navigated)).toBe(0);
    expect(s.close("edit", navigated)).toBe(0);
  });

  it("one overlay on its own behaves as it always did", () => {
    const s = open("only");
    expect(s.ownsPop("only")).toBe(true);
    expect(s.close("only", button)).toBe(1);
    const t = open("only");
    expect(t.close("only", back)).toBe(0);
    const u = open("only");
    expect(u.close("only", navigated)).toBe(0);
  });

  it("steps asked for in different moments go out separately", () => {
    const go = vi.fn();
    const later: (() => void)[] = [];
    const step = createBackStepper(go, (fn) => later.push(fn));
    step(1);
    later.shift()!();
    step(1);
    later.shift()!();
    step(0); // nothing to take off: no step at all
    expect(later).toHaveLength(0);
    expect(go.mock.calls).toEqual([[1], [1]]);
  });

  it("every Modal uses the stack: a Back and an Escape reach the top overlay only", () => {
    const modal = readFileSync(join(process.cwd(), "src/components/ui/modal.tsx"), "utf8");
    expect(modal).toContain("if (!backStack.ownsPop(overlayId)) return;");
    expect(modal).toContain("stepBack(backStack.close(overlayId, { pushed: pushedRef.current, popped: poppedRef.current, stillOurs }));");
    expect(modal).toContain('e.key === "Escape" && escapeStack.isTop(overlayId) && requestCloseRef.current()');
    // No Modal steps history back on its own any more: the stack says how far, once per moment.
    expect(modal).not.toMatch(/window\.history\.back\(\)/);
  });
});
