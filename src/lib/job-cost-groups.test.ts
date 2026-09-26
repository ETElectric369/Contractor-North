import { describe, it, expect } from "vitest";
import { billedOnLabel, groupJobCosts, nothingToBillWhy, openOwnNote, pileCount } from "@/lib/job-cost-groups";
import type { CostRowVerdict } from "@/lib/unbilled-work";

/**
 * THE COSTS TAB, OPEN FIRST (Erik, 2026-09-25, 85 Whitney / INV-081). The piles are the Unbilled
 * card's own per-row verdicts; these pin how they are sorted and said.
 */

const INV61 = { id: "i61", invoice_number: "INV-061", status: "paid", created_at: "2026-08-29T05:03:05Z", job_id: "j28" };
const INV81 = { id: "i81", invoice_number: "INV-081", status: "draft", created_at: "2026-09-26T05:26:10Z", job_id: "j28" };
const INV58 = { id: "i58", invoice_number: "INV-058", status: "sent", created_at: "2026-07-01T00:00:00Z", job_id: "j21", job_number: "J-021" };

const billed = (id: string, invoice: typeof INV61 | typeof INV58): CostRowVerdict => ({ id, kind: "bill", state: "billed", invoice });

describe("groupJobCosts — 85 Whitney while INV-081 is a draft", () => {
  const rows = [
    { id: "a", kind: "bill" as const, amount: 3034.54 },
    { id: "b", kind: "bill" as const, amount: 95.27 },
    { id: "c", kind: "bill" as const, amount: 376.86 },
    { id: "d", kind: "bill" as const, amount: 467.37 },
    { id: "e", kind: "bill" as const, amount: 1062.18 },
  ];
  const verdicts = [billed("a", INV61), billed("b", INV61), billed("c", INV61), billed("d", INV81), billed("e", INV81)];

  it("every bill is on an invoice: Not Billed Yet is empty and Billed folds by invoice, newest first", () => {
    const g = groupJobCosts(rows, verdicts, "j28");
    expect(g.open).toEqual({ ids: [], bills: 0, pos: 0, takes: 0, total: 0 });
    expect(g.billed.map((b) => [b.invoice.invoice_number, b.ids, b.total, b.draft])).toEqual([
      ["INV-081", ["d", "e"], 1529.55, true],
      ["INV-061", ["a", "b", "c"], 3506.67, false],
    ]);
    expect(g.nothing).toEqual([]);
  });

  it("says a draft is a draft, so Billed never reads as sent", () => {
    const [draft, paid] = groupJobCosts(rows, verdicts, "j28").billed;
    expect(`On ${billedOnLabel(draft)} · ${pileCount(draft)}`).toBe("On INV-081 (draft) · 2 bills");
    expect(`On ${billedOnLabel(paid)} · ${pileCount(paid)}`).toBe("On INV-061 · 3 bills");
  });

  it("the $187.64 paper, once recorded, is the one row Not Billed Yet holds", () => {
    const g = groupJobCosts(
      [...rows, { id: "f", kind: "bill", amount: 187.64 }],
      [...verdicts, { id: "f", kind: "bill", state: "open", cost: 187.64 }],
      "j28",
    );
    expect(g.open).toEqual({ ids: ["f"], bills: 1, pos: 0, takes: 0, total: 187.64 });
    expect(g.openOwn).toEqual({});
  });

  it("J-046's OSH run: the pile adds up what the next bill picks up, and the row says the rest is his own", () => {
    // $16.28 on the receipt; $9.17 of it chips and an ice cream bar, switched off. $7.11 bills.
    const g = groupJobCosts([{ id: "osh", kind: "bill", amount: 16.28 }], [{ id: "osh", kind: "bill", state: "open", cost: 7.11 }]);
    expect(g.open.total).toBe(7.11);
    expect(g.openOwn).toEqual({ osh: 9.17 });
    expect(openOwnNote(g.openOwn.osh)).toBe("$9.17 of it is your own");
    expect(openOwnNote(undefined)).toBeUndefined();
  });

  it("an open return counts only its credit", () => {
    const g = groupJobCosts(
      [{ id: "buy", kind: "bill", amount: 400 }, { id: "ret", kind: "bill", amount: -51.58 }],
      [{ id: "buy", kind: "bill", state: "open", cost: 400 }, { id: "ret", kind: "bill", state: "open", cost: -47.32 }],
    );
    expect(g.open.total).toBe(352.68);
    expect(g.openOwn).toEqual({ ret: 4.26 });
  });

  it("a bill newer than the verdicts is open (no invoice can hold it yet); an order with no verdict is not a live cost", () => {
    const g = groupJobCosts(
      [
        { id: "new", kind: "bill", amount: 12.5 },
        { id: "po-draft", kind: "po", amount: 900 },
      ],
      [],
    );
    expect(g.open.ids).toEqual(["new"]);
    expect(g.billed).toEqual([]);
    expect(g.nothing).toEqual([]);
  });

  it("names a claimant on another job with its job, and lists what never bills with why", () => {
    const g = groupJobCosts(
      [
        { id: "moved", kind: "bill", amount: 40 },
        { id: "snacks", kind: "bill", amount: 4.18 },
        { id: "po-2", kind: "po", amount: 200 },
      ],
      [billed("moved", INV58), { id: "snacks", kind: "bill", state: "nothing", why: "own_cost" }, { id: "po-2", kind: "po", state: "open", cost: 200 }],
      "j28",
    );
    expect(billedOnLabel(g.billed[0])).toBe("INV-058 (J-021)");
    expect(g.nothing).toEqual([{ id: "snacks", why: "own_cost" }]);
    expect(nothingToBillWhy("own_cost")).toBe("All of it is your own cost");
    expect(pileCount(g.open)).toBe("1 PO");
    expect(pileCount({ bills: 2, pos: 1 })).toBe("2 bills · 1 PO");
  });
});

describe("groupJobCosts — takes from stock (Shop Stock, Phase 3)", () => {
  const take = (id: string, label: string, cost: number) => ({ id, kind: "stock" as const, label, cost, takenAt: "2026-09-24T16:00:00Z" });
  it("an open take is in Not Billed Yet with its own words; a billed one folds under its invoice; a no-cost one says why", () => {
    const g = groupJobCosts(
      [{ id: "f", kind: "bill", amount: 187.64 }],
      [
        { id: "f", kind: "bill", state: "open", cost: 187.64 },
        { ...take("stock:g1", "From Stock · 12/2 NM-B, 40 ft", 28.83), state: "open" },
        { ...take("stock:g2", "From Stock · 12/2 NM-B, 20 ft", 14.41), state: "billed", invoice: INV81 },
        { ...take("stock:g3", "From Stock · Twister wire nut, 12 ea", 0), state: "nothing", why: "stock_no_cost" },
      ],
      "j28",
    );
    expect(g.open).toEqual({ ids: ["f", "stock:g1"], bills: 1, pos: 0, takes: 1, total: 216.47 });
    expect(pileCount(g.open)).toBe("1 bill · 1 from stock");
    expect(g.billed.map((b) => [billedOnLabel(b), b.ids, pileCount(b), b.total])).toEqual([["INV-081 (draft)", ["stock:g2"], "1 from stock", 14.41]]);
    expect(g.nothing).toEqual([{ id: "stock:g3", why: "stock_no_cost" }]);
    expect(g.stock["stock:g1"]).toEqual({ label: "From Stock · 12/2 NM-B, 40 ft", cost: 28.83, takenAt: "2026-09-24T16:00:00Z" });
    expect(nothingToBillWhy("stock_no_cost")).toContain("no cost on it");
    expect(g.openOwn).toEqual({});
  });
});
