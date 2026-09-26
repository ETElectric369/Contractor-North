import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * WHAT'S ON IT, THE SERVER READ (Erik, 2026-09-26: "i need to open the bill to see whats on it to be
 * able to approve or deny"). Pinned: staff only, every read names the org and the paper, the lines
 * come back as CED printed them, the extension is the price (never unit price × quantity), a $0.00
 * line is Not Shipped, a paper with no lines still says its total, and the PDF door.
 *
 * The fixture is 8802-1107139, his real $59.17 CED paper for 13683 HILLSIDE, plus the real
 * back-ordered track light (H8010CSWT, quantity 0, $38.98 printed, $0.00 extension) and a real
 * per-hundred plate price to prove the unit price is decoration.
 */

const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => state.client) }));

import { supplierPaperContents } from "./paper-contents-action";
import { lineWords, offLinesWords, paperContents, paperContentsLines } from "@/lib/supplier-paper-contents";

type Call = { table: string; filters: [string, string, unknown][]; order?: [string, unknown] };

function fakeSupabase(script: Record<string, any[]>, calls: Call[], opts: { role?: string; signed?: Record<string, string> } = {}) {
  const next = (key: string) => {
    const q = script[key];
    if (!q || q.length === 0) throw new Error(`unscripted call: ${key}`);
    return q.shift();
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    storage: {
      from: () => ({
        createSignedUrls: async (paths: string[]) => ({
          data: paths.map((p) => ({ path: p, signedUrl: opts.signed?.[p] ?? null })),
          error: null,
        }),
      }),
    },
    from(table: string) {
      if (table === "profiles") {
        const p: any = {
          select: () => p,
          eq: () => p,
          maybeSingle: async () => ({ data: { role: opts.role ?? "owner", org_id: "org-1", active: true }, error: null }),
        };
        return p;
      }
      const call: Call = { table, filters: [] };
      calls.push(call);
      const chain: any = {
        select: () => chain,
        eq: (col: string, v: unknown) => (call.filters.push(["eq", col, v]), chain),
        contains: (col: string, v: unknown) => (call.filters.push(["contains", col, v]), chain),
        not: (col: string, op: string, v: unknown) => (call.filters.push(["not", col, [op, v]]), chain),
        order: (col: string, o: unknown) => ((call.order = [col, o]), chain),
        limit: () => chain,
        maybeSingle: () => Promise.resolve(next(table)),
        then(resolve: any, reject: any) {
          try {
            resolve(next(table));
          } catch (e) {
            reject?.(e);
          }
        },
      };
      return chain;
    },
  };
}

const HILLSIDE = {
  id: "43cf4f98-7660-4214-9dc0-b797edeaab25",
  invoice_number: "8802-1107139",
  tax: "4.89",
  shipping: "0.00",
  total: "59.17",
  source_file: "invoice_8802-1107139.pdf",
};
// Out of order on purpose: CED's order is sort_order, not the order rows happen to arrive in.
const HILLSIDE_LINES = [
  { description: "1/2 FILLER PLATE", part_number: "TFH", quantity: "4.000", unit_price: "4.5700", extension: "18.28", sort_order: 1 },
  { description: "20A 120/277VAC SW", part_number: "PS20AC2RPL", quantity: "1.000", unit_price: "36.0000", extension: "36.00", sort_order: 0 },
];

let calls: Call[];
beforeEach(() => {
  calls = [];
});

describe("supplierPaperContents: who may read it", () => {
  it("a tech is refused before any paper is read (these are supplier costs)", async () => {
    state.client = fakeSupabase({}, calls, { role: "tech" });
    const res = await supplierPaperContents(HILLSIDE.id);
    expect(res.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it("a paper in another company is 'not here', never read by id alone", async () => {
    state.client = fakeSupabase({ supplier_invoices: [{ data: null, error: null }] }, calls);
    const res = await supplierPaperContents(HILLSIDE.id);
    expect(res).toEqual({ ok: false, error: "That paper isn't here anymore. Reload the page." });
    expect(calls[0].filters).toEqual([
      ["eq", "org_id", "org-1"],
      ["eq", "id", HILLSIDE.id],
    ]);
  });
});

describe("supplierPaperContents: 8802-1107139, $59.17, 13683 HILLSIDE", () => {
  const script = (over: Record<string, any[]> = {}) => ({
    supplier_invoices: [{ data: HILLSIDE, error: null }],
    supplier_invoice_lines: [{ data: HILLSIDE_LINES, error: null }],
    documents: [{ data: [], error: null }],
    organized_items: [{ data: [], error: null }],
    ...over,
  });

  it("reads the lines org-filtered, by this paper, in CED's order, and adds up to the card's $59.17", async () => {
    state.client = fakeSupabase(script(), calls);
    const res = await supplierPaperContents(HILLSIDE.id);
    if (!res.ok) throw new Error(res.error);
    const lines = calls.find((c) => c.table === "supplier_invoice_lines")!;
    expect(lines.filters).toEqual([
      ["eq", "org_id", "org-1"],
      ["eq", "supplier_invoice_id", HILLSIDE.id],
    ]);
    expect(lines.order).toEqual(["sort_order", { ascending: true }]);
    // Every other read names the org too.
    for (const c of calls) expect(c.filters[0]).toEqual(["eq", "org_id", "org-1"]);

    expect(res.contents.lines.map(lineWords)).toEqual(["1 × 20A 120/277VAC SW (PS20AC2RPL) · $36.00", "4 × 1/2 FILLER PLATE (TFH) · $18.28"]);
    expect(res.contents.tax).toBe(4.89);
    expect(res.contents.total).toBe(59.17);
    expect(res.contents.offLines).toBe(0);
    expect(offLinesWords(res.contents)).toBeNull();
    // Only its name was kept: the card says so rather than showing a dead link.
    expect(res.contents.pdfUrl).toBeNull();
    expect(res.contents.pdfNote).toBe("The PDF itself isn't kept here, only what was read from invoice_8802-1107139.pdf.");
  });

  it("opens the PDF Drop Paperwork stored for it, found by the invoice number it landed", async () => {
    const path = "org-1/organize/1727-ced.pdf";
    state.client = fakeSupabase(script({ organized_items: [{ data: [{ file_url: path }], error: null }] }), calls, {
      signed: { [path]: "https://signed.example/ced.pdf" },
    });
    const res = await supplierPaperContents(HILLSIDE.id);
    if (!res.ok) throw new Error(res.error);
    expect(res.contents.pdfUrl).toBe("https://signed.example/ced.pdf");
    expect(res.contents.pdfNote).toBeNull();
    const drop = calls.find((c) => c.table === "organized_items")!;
    expect(drop.filters).toContainEqual(["contains", "proposal", { filed: { landed: ["8802-1107139"] } }]);
    const doc = calls.find((c) => c.table === "documents")!;
    expect(doc.filters).toContainEqual(["eq", "file_url", "invoice_8802-1107139.pdf"]);
  });

  it("a stored PDF that can't be signed is said, not dropped", async () => {
    state.client = fakeSupabase(script({ documents: [{ data: [{ file_url: "org-1/x.pdf" }], error: null }] }), calls);
    const res = await supplierPaperContents(HILLSIDE.id);
    if (!res.ok) throw new Error(res.error);
    expect(res.contents.pdfUrl).toBeNull();
    expect(res.contents.pdfNote).toBe("Its PDF is on file but couldn't be opened just now.");
  });

  it("a failed line read is a failed read (the card offers Try Again), never an empty paper", async () => {
    state.client = fakeSupabase(script({ supplier_invoice_lines: [{ data: null, error: { message: "timeout" } }] }), calls);
    const res = await supplierPaperContents(HILLSIDE.id);
    expect(res.ok).toBe(false);
  });

  it("a paper with no lines on file still says its tax and total, and how much is on no line", async () => {
    state.client = fakeSupabase(script({ supplier_invoice_lines: [{ data: [], error: null }] }), calls);
    const res = await supplierPaperContents(HILLSIDE.id);
    if (!res.ok) throw new Error(res.error);
    expect(res.contents.lines).toEqual([]);
    expect(res.contents.total).toBe(59.17);
    expect(offLinesWords(res.contents)).toBe("$54.28 of the total isn't on any line.");
  });
});

describe("the extension is the price", () => {
  it("a per-hundred price is never multiplied out, and a $0.00 extension is Not Shipped", () => {
    const lines = paperContentsLines([
      // 50 plates at "50.00 C" is $25.00. 50 × 50.00 would be $2,500.
      { description: "1G DECORA PLATE WHT", part_number: "PJ26W", quantity: "50", unit_price: "50.00", extension: "25.00", sort_order: 0 },
      // His real back order: CED printed the price and shipped none.
      { description: "CHARGE 8010  5CCT 10W H/J/L TRACK LUMINAI", part_number: "H8010CSWT", quantity: "0", unit_price: "38.98", extension: "0.00", sort_order: 1 },
      // Nothing on it at all: not a line.
      { description: "", part_number: null, quantity: "0", unit_price: "0", extension: "0", sort_order: 2 },
    ]);
    expect(lines.map(lineWords)).toEqual([
      "50 × 1G DECORA PLATE WHT (PJ26W) · $25.00",
      "CHARGE 8010  5CCT 10W H/J/L TRACK LUMINAI (H8010CSWT) · Not Shipped",
    ]);
    expect(lines[1].notShipped).toBe(true);
  });

  it("says when the lines come to more than the supplier's total", () => {
    const c = paperContents({
      invoice: { invoice_number: "X", tax: 0, shipping: 0, total: 10 },
      lines: [{ description: "A", quantity: 1, extension: 12.5, sort_order: 0 }],
    });
    expect(offLinesWords(c)).toBe("The lines come to $2.50 more than the total.");
  });
});
