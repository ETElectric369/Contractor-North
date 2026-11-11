import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE ROW'S ⋯ SHEET IS DRAWN ON THE PAGE, NEVER INSIDE ITS ROW.
 *
 * Erik, 2026-11-10, a screenshot of the Schedule on a wide screen with no words: a waiting job's ⋯
 * sheet open with the calendar's hour lines running across it, the calendar's day header standing
 * bright over the scrim, and the calendar's own hint ("Add to Schedule: tap an open time") showing
 * over the sheet's last row. The sheet was behind the calendar. The waiting rail's wrapper is
 * `position: sticky` there, sticky always makes a stacking context, and a sheet drawn in place inside
 * it is trapped in the rail's layer: its z-index counts only inside the rail, so whatever the page
 * draws after the rail is drawn over the sheet, and a click on Put on Hold… lands on the calendar's
 * open spot. It had been so on a wide screen since the rail's cards got their ⋯ (a phone has no
 * sticky rail, so it never showed there).
 *
 * The cure is in the ONE row sheet, not in the rail: the sheet draws itself into <body>, so no
 * wrapper's layer can hold it, on this page or on the next one a row is put in.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

// The server renderer refuses a real portal, so the door to <body> is watched instead: what was handed
// to it and where it was sent. The sheet's markup is drawn in its place so the render can be read.
const sentTo: unknown[] = [];
vi.mock("react-dom", async (original) => {
  const real = await original<typeof import("react-dom")>();
  return {
    ...real,
    createPortal: (children: ReactNode, container: unknown) => {
      sentTo.push(container);
      return createElement("div", { "data-drawn-into-body": "" }, children);
    },
  };
});

import { RowMoreSheetView, SHEET_ROW } from "./row-more-sheet";

const el = <P extends object>(type: FunctionComponent<P>, props: Omit<P, "children">, children: ReactNode) =>
  createElement(type, props as P, children);

const sheet = () =>
  renderToStaticMarkup(
    el(
      RowMoreSheetView,
      { open: true, title: "41 Larkspur", subline: "41 Larkspur Ln", onClose: () => {} },
      createElement("button", { type: "button", className: SHEET_ROW }, "Put on Hold…"),
    ),
  );

afterEach(() => {
  vi.unstubAllGlobals();
  sentTo.length = 0;
});

describe("the row's ⋯ sheet is drawn on the page", () => {
  it("with a page to draw on, the whole sheet (scrim, panel, rows) goes into <body>", () => {
    const body = { nodeType: 1 };
    vi.stubGlobal("document", { body });
    const html = sheet();
    expect(sentTo).toEqual([body]);
    // Everything the sheet draws is inside what was sent: nothing of it is left in the row.
    expect(html.startsWith("<div data-drawn-into-body")).toBe(true);
    const inside = html.slice(html.indexOf("data-drawn-into-body"));
    expect(inside).toContain("z-[120]");
    expect(inside).toContain("bg-slate-900/40"); // the scrim
    expect(inside).toContain(">41 Larkspur</h2>");
    expect(inside).toContain("Put on Hold…");
  });

  it("closed, it sends nothing anywhere", () => {
    vi.stubGlobal("document", { body: { nodeType: 1 } });
    const html = renderToStaticMarkup(el(RowMoreSheetView, { open: false, title: "41 Larkspur", onClose: () => {} }, "rows"));
    expect(html).toBe("");
    expect(sentTo).toEqual([]);
  });

  it("with no page (the server's render, and every static test), it renders where it stands", () => {
    expect(typeof document).toBe("undefined");
    const html = sheet();
    expect(sentTo).toEqual([]);
    expect(html).not.toContain("data-drawn-into-body");
    expect(html).toContain(">41 Larkspur</h2>");
  });

  it("the ONE sheet says so, and every row sheet in the app is that one", () => {
    const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    const src = read("src/components/row-more-sheet.tsx");
    const view = src.slice(src.indexOf("export function RowMoreSheetView"), src.indexOf("export function RowMoreSheet("));
    expect(view).toContain('<Modal open={open} onClose={onClose} title={title} size="sm" portal>');
    // RowMoreSheet draws through the view: there is no second Modal in the file to forget.
    expect(src.match(/<Modal\b/g)).toHaveLength(1);
    // The waiting rail's cards (the place it showed) open this sheet and no other.
    const rail = read("src/app/(app)/schedule/place-rail.tsx");
    expect(rail).toContain("<RowMoreSheet title={i.name} subline={i.address ?? null}>");
    expect(rail).not.toMatch(/<Modal\b/);
    // Why a wrapper can trap an in-place sheet is written where the next person will look for it.
    expect(read("src/components/ui/modal.tsx")).toContain("`position: sticky` (always a stacking");
  });

  it("nothing in the sheet leans on being inside its row: no caller wraps it in a form", () => {
    const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
    for (const p of [
      "src/app/(app)/schedule/place-rail.tsx",
      "src/app/(app)/planner/agenda-move.tsx",
      "src/app/(app)/planner/your-list.tsx",
      "src/app/(app)/bills/bills-receipts.tsx",
      "src/components/action-items/action-list.tsx",
    ]) {
      const src = read(p);
      expect(src, p).toContain("RowMoreSheet");
      // A <form> around the sheet would lose its submit buttons to <body>; none of these has one.
      expect(src, p).not.toMatch(/<form\b/);
    }
  });
});
