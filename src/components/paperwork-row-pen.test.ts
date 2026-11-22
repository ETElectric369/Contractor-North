import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * THE TRAY ROW'S PEN MARKS AND ITS CREDIT MEMO DOOR (cn-v1181, lane T1 + T2), as static renders.
 * Stand-ins: supplier Northline Supply, ticket INV-900.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));
vi.mock("@/lib/actions/execute", () => ({ executeAction: vi.fn() }));
vi.mock("@/app/(app)/organize/actions", () => ({
  archiveItem: vi.fn(),
  deleteOrganizedItem: vi.fn(),
  fileItem: vi.fn(),
  keepAsNote: vi.fn(),
  makeTaskFromPaper: vi.fn(),
  readAsCost: vi.fn(),
  readPaperworkItem: vi.fn(),
  tiePaperwork: vi.fn(),
  undoPaperwork: vi.fn(),
}));
vi.mock("@/app/(app)/organize/paperwork-actions", () => ({ addSupplierDocuments: vi.fn(), keepPaperwork: vi.fn(), updatePaperwork: vi.fn() }));
vi.mock("@/app/(app)/organize/pen-line-actions", () => ({ setPaperLineReturned: vi.fn() }));
// Lane M fills the door; mounted here as it is typed. The stand-in shows WHERE it is mounted.
vi.mock("@/components/credit-memo-door", () => ({
  CreditMemoDoor: ({ itemId }: { itemId: string }) => createElement("div", { "data-door": `credit-memo:${itemId}` }),
}));

import { PaperworkRow, penViewOf, type PaperRowItem } from "./paperwork-row";
import { PEN_WORDS } from "@/lib/pen-marks";
import { NOT_FILED_YET } from "@/lib/paperwork";

const LINES = [
  { description: "12-2 NM-B WIRE 250FT", quantity: 2, unit_price: 120, amount: 240, category: "Materials", billable: false, pen: "struck", returned: true },
  { description: "SINGLE POLE BREAKER", quantity: 4, unit_price: 10, amount: 40, category: "Materials", billable: false, pen: "unclear" },
  { description: "WIRE NUTS", quantity: 1, unit_price: 9, amount: 9, category: "Materials", billable: true },
];
const base: PaperRowItem = {
  id: "p1",
  kind: "receipt",
  status: "needs_review",
  doc_type: "bill",
  vendor: "Northline Supply",
  amount: 289,
  payment: "on_account",
  doc_number: "INV-900",
  title: "ticket.jpg",
  created_at: "2026-11-20T12:00:00Z",
  signedUrl: null,
  line_items: LINES,
};
const render = (item: Partial<PaperRowItem>) =>
  renderToStaticMarkup(createElement(PaperworkRow, { item: { ...base, ...item }, jobs: [], matches: [], onFiled: () => {} }));
const words = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();
const buttonTags = (html: string) => Array.from(html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)).map((m) => ({ attrs: m[1], label: words(m[2]) }));

describe("penViewOf: the paper's own stored lines, by their place", () => {
  it("only marked lines, each with its face and its place in line_items", () => {
    const v = penViewOf(base)!;
    expect(v.creditExpected).toBe(true);
    expect(v.lines.map((l) => [l.index, l.state, l.face])).toEqual([
      [0, "returned", PEN_WORDS.creditExpected],
      [1, "open", PEN_WORDS.needsAnswer],
    ]);
  });
  it("a receipt paid at the counter: crossed out, no credit tracked", () => {
    const v = penViewOf({ ...base, payment: "paid_at_purchase" })!;
    expect(v.creditExpected).toBe(false);
    expect(v.lines[0].face).toBe(PEN_WORDS.crossedOut);
  });
  it("no ink, nothing to say", () => {
    expect(penViewOf({ ...base, line_items: [LINES[2]] })).toBeNull();
  });
});

describe("the tray row says what the pen marks read, and asks", () => {
  it("the pen sentence, each marked line's face, Kept / Returned on each, and nothing amber", () => {
    const html = render({});
    const w = words(html);
    expect(w).toContain("Pen marks read: 1 line crossed out.");
    expect(w).toContain("held off the customer's bill until you answer Kept or Returned");
    expect(w).toContain(PEN_WORDS.creditExpected);
    expect(w).toContain(PEN_WORDS.needsAnswer);
    const group = html.slice(html.indexOf('aria-label="Pen marks"'));
    const pens = buttonTags(group).filter((b) => b.label === PEN_WORDS.kept || b.label === PEN_WORDS.returned);
    expect(pens.map((b) => b.label)).toEqual(["Kept", "Returned", "Kept", "Returned"]);
    // The struck line is Returned already: that tap is shut; the open question has both open.
    expect(pens[1].attrs).toMatch(/\sdisabled=""/);
    expect(pens[0].attrs).not.toMatch(/\sdisabled=""/);
    expect(pens[2].attrs).not.toMatch(/\sdisabled=""/);
    expect(pens[3].attrs).not.toMatch(/\sdisabled=""/);
    expect(pens.every((b) => /min-h-11/.test(b.attrs))).toBe(true);
    const box = html.slice(html.indexOf('aria-label="Pen marks"') - 200, html.indexOf("</ul>", html.indexOf('aria-label="Pen marks"')));
    expect(box).not.toMatch(/amber/);
  });

  it("a receipt paid at the counter says Crossed Out, and offers no Returned", () => {
    const html = render({ payment: "paid_at_purchase", doc_type: "receipt" });
    const group = html.slice(html.indexOf('aria-label="Pen marks"'));
    const labels = buttonTags(group).map((b) => b.label);
    expect(labels).toContain(PEN_WORDS.crossedOut);
    expect(labels).not.toContain(PEN_WORDS.returned);
    expect(words(html)).toContain("comes off the customer's bill.");
  });

  it("a paper with no ink shows no pen box", () => {
    expect(render({ line_items: [LINES[2]] })).not.toContain('aria-label="Pen marks"');
  });
});

describe("a credit memo waiting in the tray", () => {
  it("mounts the credit memo door, with today's sentence under it", () => {
    const html = render({ doc_type: "credit_memo", amount: -40, line_items: [] });
    const door = html.indexOf('data-door="credit-memo:p1"');
    expect(door).toBeGreaterThan(-1);
    expect(html.indexOf(NOT_FILED_YET)).toBeGreaterThan(door);
  });
  it("a statement (also later paper) does not get the door", () => {
    expect(render({ doc_type: "statement", line_items: [] })).not.toContain("data-door");
  });
});

describe("cn-v1181 fixer: the tray's stock sheet lists no line that went back (skeptic #84, S1)", () => {
  it("a returned line and an unclear one are left out; each remaining row keeps its own index", async () => {
    const { stockSheetRows } = await import("./paperwork-row");
    const rows = stockSheetRows({ ...base, line_items: LINES } as any);
    expect(rows.map((r) => r.description)).toEqual(["WIRE NUTS"]);
    expect(rows.map((r) => r.index)).toEqual([2]);
  });
  it("a paper with no pen marks lists every line, indexes 0..n", async () => {
    const { stockSheetRows } = await import("./paperwork-row");
    const plain = LINES.map(({ pen: _p, returned: _r, ...l }) => ({ ...l, billable: true }));
    expect(stockSheetRows({ ...base, line_items: plain } as any).map((r) => r.index)).toEqual([0, 1, 2]);
  });
  it("the sheet is fed by that filter, never by the raw rows", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${process.cwd()}/src/components/paperwork-row.tsx`, "utf8");
    expect(src).toContain("lines={stockSheetRows(item).map(");
    expect(src).not.toContain("lines={shelfRowsOf(item).map(");
  });
});
