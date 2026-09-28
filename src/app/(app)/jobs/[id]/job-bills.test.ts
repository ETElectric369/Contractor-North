import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * THE COSTS TAB'S BILL ROW USES THE /bills ROW'S DOORS (audit v1018, class 13).
 *
 * It had kept the old ones: a 16px pencil and a 16px trash icon (the trash a one-tap hard delete,
 * no question, no Undo) and a badge reading the raw "paid"/"unpaid", the word /bills retired
 * because a bill ticked paid that a cheque already covered takes the same dollar off twice. Both
 * screens now draw BillRowDoors: Settled / On Account · Switch, Edit, Delete, each 44px, and
 * Delete asks first.
 */

const acts = vi.hoisted(() => ({ deleteBill: vi.fn(async () => ({ ok: true })), setBillStatus: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/app/(app)/jobs/actions", () => ({ ...acts, createBill: vi.fn() }));
vi.mock("@/lib/actions/execute", () => ({ executeAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {}, push: () => {} }) }));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));
// A press made after the static render runs its transition straight through (there is no DOM here).
vi.mock("react", async (orig) => {
  const real = (await orig()) as typeof import("react");
  return { ...real, useTransition: () => [false, (fn: () => unknown) => void fn()] };
});

/** Every Button the doors draw, with the props it was handed, so a press can be made off the page. */
const pressed = vi.hoisted(() => ({ buttons: [] as { label: string; onClick?: () => void }[] }));
vi.mock("@/components/ui/button", async (orig) => {
  const real = (await orig()) as typeof import("@/components/ui/button");
  const { createElement: h, forwardRef } = await import("react");
  const Button = forwardRef<HTMLButtonElement, any>((props, ref) => {
    const label = [props.children].flat().filter((c: unknown) => typeof c === "string").join("").trim();
    pressed.buttons.push({ label, onClick: props.onClick });
    return h(real.Button, { ...props, ref });
  });
  return { ...real, Button };
});

import { JobBills } from "./job-bills";

const BILLS = [
  { id: "b1", supplier: "CED", bill_number: "8802-1106969", amount: 301.81, status: "unpaid", bill_date: "2026-09-04" },
  { id: "b2", supplier: "OSH", bill_number: null, amount: 16.28, status: "paid", bill_date: "2026-09-18" },
];
const render = () => renderToStaticMarkup(createElement(JobBills, { jobId: "j11", bills: BILLS as any, pos: [] }));

beforeEach(() => {
  pressed.buttons = [];
  acts.deleteBill.mockClear();
});

/**
 * ONE WAY TO ADD A COST (W1-23). The list has no Add Bill of its own: a cost goes in at the top of
 * the tab (Snap The Bill, or its ⋯: Upload and Type It In, the one typed sheet). The Not Billed Yet
 * row keeps its label, its count and its figure.
 */
describe("the Costs tab's bills list adds nothing itself", () => {
  const html = render();
  const words = Array.from(html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)).map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

  it("no Add Bill button, no Add Bill sheet, and no createBill behind the list", () => {
    expect(words).not.toContain("Add Bill");
    expect(html).not.toContain("Add Bill");
    const src = readFileSync(join(process.cwd(), "src/app/(app)/jobs/[id]/job-bills.tsx"), "utf8");
    expect(src).not.toMatch(/\bcreateBill\b/);
    expect(src).not.toContain('title="Add Bill"');
  });

  it("the plain list still says how many bills and what they cost", () => {
    expect(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ")).toContain("2 bills · $318.09");
  });

  it("Not Billed Yet keeps its label, count and figure", () => {
    const groups = {
      open: { ids: ["b1"], bills: 1, pos: 0, takes: 0, total: 301.81 },
      openOwn: {},
      billed: [],
      nothing: [],
      stock: {},
    };
    const piles = renderToStaticMarkup(createElement(JobBills, { jobId: "j11", bills: BILLS as any, pos: [], groups: groups as any }));
    const text = piles.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    expect(text).toContain("Not Billed Yet · 1 bill · $301.81");
    expect(text).not.toContain("Add Bill");
  });
});

describe("the Costs tab's bill row", () => {
  it("says how the bill was bought, never 'paid', and the toggle is 44px", () => {
    const html = render();
    const toggles = Array.from(html.matchAll(/<button[^>]*aria-label="How this bill was bought[^"]*"[^>]*>([\s\S]*?)<\/button>/g));
    expect(toggles).toHaveLength(2);
    for (const t of toggles) expect(t[0]).toContain("min-h-11");
    const faces = toggles.map((t) => t[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    expect(faces).toEqual(["On Account Switch", "Settled Switch"]);
    expect(html).not.toMatch(/>\s*(paid|unpaid)\s*</);
    expect(html).not.toContain("Toggle paid/unpaid");
  });

  it("Edit and Delete are 44px buttons with their words, not bare 16px icons", () => {
    const html = render();
    const doors = Array.from(html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)).map((m) => ({
      tag: m[0],
      words: m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    }));
    for (const word of ["Edit", "Delete"]) {
      const found = doors.filter((d) => d.words === word);
      expect(found).toHaveLength(2);
      for (const d of found) expect(d.tag).toMatch(/\bh-11\b/);
    }
  });

  it("Delete asks first: a No writes nothing, a Yes deletes that bill", async () => {
    render();
    const del = pressed.buttons.find((b) => b.label === "Delete")!;
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    try {
      del.onClick?.();
      expect(confirm).toHaveBeenCalledWith('Delete bill from "CED"?');
      expect(acts.deleteBill).not.toHaveBeenCalled();
      confirm.mockReturnValue(true);
      del.onClick?.();
      await vi.waitFor(() => expect(acts.deleteBill).toHaveBeenCalledWith("b1", "j11"));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/**
 * ALREADY BILLED ON THE COSTS TAB (0357, Purple Sage). An open row gets Already Billed; a billed row
 * a person marked says so and gets Not Billed After All; an importer's claim gets neither. The page
 * hands these over only for staff on a job that bills its actuals: a fixed-price job has no piles,
 * and no doors.
 */
describe("the Costs tab's Already Billed doors", () => {
  const PS = [
    { id: "ps", supplier: "Consolidated Electrical Distributors", bill_number: "8802-1101475", amount: 186.93, status: "paid", bill_date: "2026-06-16" },
    { id: "osh", supplier: "OSH", bill_number: null, amount: 16.28, status: "paid", bill_date: "2026-09-18" },
    { id: "hd", supplier: "The Home Depot", bill_number: "HD-1", amount: 196.18, status: "paid", bill_date: "2026-08-12" },
  ];
  const invoice = { id: "inv-23", invoice_number: "INV-00023", status: "paid", created_at: "2026-06-22T04:57:19Z" };
  const groups = {
    open: { ids: ["osh"], bills: 1, pos: 0, takes: 0, total: 16.28 },
    openOwn: {},
    billed: [{ ids: ["ps", "hd"], bills: 2, pos: 0, takes: 0, total: 383.11, invoice, draft: false, offJobNumber: null }],
    nothing: [],
    stock: {},
  };
  const doors = {
    open: { osh: { kind: "bill" as const, ids: ["osh"], what: "OSH" } },
    hands: { ps: { lineId: "li-materials", ids: ["ps"], invoiceNumber: "INV-00023", what: "Consolidated Electrical Distributors 8802-1101475" } },
  };
  const words = (html: string) =>
    Array.from(html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)).map((m) => ({ attrs: m[1], words: m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() }));

  it("Already Billed on the open row, Billed By Hand On INV-00023 · Not Billed After All on the marked one, each 44px", () => {
    const html = renderToStaticMarkup(createElement(JobBills, { jobId: "j-010", bills: PS as any, pos: [], groups: groups as any, alreadyBilled: doors }));
    const b = words(html);
    expect(b.filter((x) => x.words === "Already Billed")).toHaveLength(1);
    expect(b.filter((x) => x.words === "Not Billed After All")).toHaveLength(1);
    for (const x of b.filter((y) => ["Already Billed", "Not Billed After All"].includes(y.words))) expect(x.attrs).toMatch(/\bh-11\b/);
    expect(html).toContain("Billed By Hand On INV-00023");
    // The Home Depot bill is on INV-00023 by an import: no Undo of anybody's hand there.
    expect(html.match(/Billed By Hand On/g)).toHaveLength(1);
  });

  it("hours a person marked sit in the Billed fold under their invoice, never under Not Billed Yet", () => {
    const hours = [
      { lineId: "li-brian", invoiceId: "inv-23", invoiceNumber: "INV-00023", ids: ["t1"], hours: 6, what: "6 h of Brian Taylor's time" },
      // INV-060 holds none of this job's bills: its own line under Billed.
      { lineId: "li-60", invoiceId: "inv-60", invoiceNumber: "INV-060", ids: ["t2"], hours: 10.5, what: "10.5 h of Brian Taylor's time" },
    ];
    const html = renderToStaticMarkup(createElement(JobBills, { jobId: "j-010", bills: PS as any, pos: [], groups: groups as any, alreadyBilled: doors, billedHours: hours }));
    const billedAt = html.indexOf(">Billed<");
    expect(billedAt).toBeGreaterThan(-1);
    const on23 = html.indexOf("Billed By Hand On INV-00023: 6h");
    const on60 = html.indexOf("Billed By Hand On INV-060: 10h 30m");
    expect(on23).toBeGreaterThan(billedAt);
    expect(on60).toBeGreaterThan(billedAt);
    // INV-00023's hours are inside its fold.
    const fold = html.slice(html.indexOf("<details"), html.indexOf("</details>"));
    expect(fold).toContain("Billed By Hand On INV-00023: 6h");
    expect(words(html).filter((x) => x.words === "Not Billed After All")).toHaveLength(3);
    // Only marked hours and no billed bills: the Billed section is still drawn.
    const only = renderToStaticMarkup(
      createElement(JobBills, { jobId: "j-010", bills: PS as any, pos: [], groups: { ...groups, billed: [] } as any, alreadyBilled: doors, billedHours: hours }),
    );
    expect(only).toContain(">Billed<");
    expect(only).toContain("Billed By Hand On INV-060: 10h 30m");
  });

  it("J-010, fixed price with no estimate (no piles): the marked receipt and marked hours still say so, with Not Billed After All", () => {
    const html = renderToStaticMarkup(
      createElement(JobBills, {
        jobId: "j-010",
        bills: PS as any,
        pos: [],
        groups: null,
        alreadyBilled: { open: {}, hands: doors.hands },
        billedHours: [{ lineId: "li-brian", invoiceId: "inv-23", invoiceNumber: "INV-00023", ids: ["t1"], hours: 6, what: "6 h of Brian Taylor's time" }],
      }),
    );
    expect(html).toContain("Billed By Hand On INV-00023");
    expect(html).toContain("Billed By Hand On INV-00023: 6h");
    expect(words(html).filter((x) => x.words === "Not Billed After All")).toHaveLength(2);
    expect(words(html).filter((x) => x.words === "Already Billed")).toHaveLength(0);
  });

  it("a lost read of the marks is said under Billed, never a quiet loss of Not Billed After All", () => {
    const note = "Couldn't tell which rows were marked billed by hand just now, so Not Billed After All isn't shown. Reload to try again.";
    const text = (html: string) => html.replace(/&#x27;/g, "'");
    // Even with nothing else billed, the Billed heading carries the sentence.
    const piles = renderToStaticMarkup(createElement(JobBills, { jobId: "j-010", bills: PS as any, pos: [], groups: { ...groups, billed: [] } as any, alreadyBilled: null, handsNote: note }));
    expect(text(piles)).toContain(">Billed<");
    expect(text(piles)).toContain(note);
    const plain = renderToStaticMarkup(createElement(JobBills, { jobId: "j-010", bills: PS as any, pos: [], groups: null, handsNote: note }));
    expect(text(plain)).toContain(note);
  });

  it("no doors when the page offers none (a tech's view, a fixed-price job's plain list, or no sent bill to hold it)", () => {
    for (const html of [
      renderToStaticMarkup(createElement(JobBills, { jobId: "j-010", bills: PS as any, pos: [], groups: groups as any, alreadyBilled: null })),
      renderToStaticMarkup(createElement(JobBills, { jobId: "j-003", bills: PS as any, pos: [] })),
    ]) {
      expect(html).not.toContain("Already Billed");
      expect(html).not.toContain("Not Billed After All");
    }
  });
});
