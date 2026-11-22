import { describe, it, expect } from "vitest";
import { lineHole, pricingCustomerId, visitEstimateLines, visitEstimateRows, visitPicks, type VisitLineSeed } from "./visit-lines";
import { ownScopes, scopeLines } from "@/lib/playbook/scopes";
import { coerceTasks } from "@/lib/playbook/tasks";
import { seedLinesFromCapture, type CaptureItem } from "@/lib/inspection/capture";
import { taskLines, type TaskBookRow } from "./task-lines";
import { laborRateFor } from "@/lib/pricing/labor-rate";
import type { Playbook } from "@/lib/playbook/types";

/**
 * THE ONE LINE BUILDER (cn-v1176, M1 + M2). The estimate page's seed moved here unchanged: this table
 * builds the same visit the way the page built it before the move (the composition written out by hand
 * below) and asks the builder for the same lines, in the same order, with the same values. Then the keys,
 * the hole rule, and the one deliberate change: the lead's customer prices the lines when the visit has none.
 */
const book = [
  { id: "b1", code: "S1", description: "Service upgrade, 200A", unit: "EA", buy_price: 100, markup_pct: null, price_list_item_options: [] },
  { id: "b2", code: "P1", description: "Breaker, 20A", unit: "ea", buy_price: 10, markup_pct: null, price_list_item_options: [] },
  { id: "b3", code: "Z0", description: "Allowance", unit: "EA", buy_price: 0, markup_pct: null, price_list_item_options: [] },
];
const tasks = coerceTasks([
  { id: "t1", name: "Hang the panel", hours: 3, materials: [{ code: "P1", words: "Breaker, 20A", qty: 2 }] },
  { id: "t2", name: "Trench to the shed", hours: null, materials: [] },
])!;
const typed: CaptureItem[] = [
  { id: "c1", description: "200 ft 12-2 romex", quantity: 200, unit: "ft" },
  { id: "c2", description: "   ", quantity: 1, unit: "ea" },
  { id: "c3", description: "Weatherhead", quantity: null, unit: "ea", flag: "heard, not confirmed" } as CaptureItem,
];
const seed = (over: Partial<VisitLineSeed> = {}): VisitLineSeed => ({
  scopes: [
    { key: "q_scopes", label: "Scopes", picks: [{ code: "S1", qty: 2, price: 150 }, { code: "GONE", qty: 1, price: 9 }, { code: "Z0", qty: 1, price: 0 }] },
  ],
  tasks: [{ key: "q_tasks", label: "Tasks", tasks }],
  typedItems: typed,
  priceItems: book,
  kits: [],
  level: null,
  settings: { default_markup_pct: 25, default_labor_rate: 100 },
  ...over,
});

/** The page's composition as it stood before the move (quotes/new/page.tsx 395-423 at 8f928031). */
function before(s: VisitLineSeed) {
  const bk = new Map(s.priceItems.map((p) => [p.code as string, { description: p.description, unit: p.unit }]));
  const codes = new Set(bk.keys());
  const taskBook = new Map<string, TaskBookRow>(s.priceItems.filter((p) => p.code).map((p) => [String(p.code), p as unknown as TaskBookRow]));
  const pricing = { levelPct: (s.level?.markup_pct ?? null) as number | null, orgDefaultPct: s.settings.default_markup_pct };
  const rate = laborRateFor({ levelRate: s.level?.labor_rate as number | null | undefined, orgDefault: s.settings.default_labor_rate }).rate;
  const taskSeed = s.tasks.flatMap((g) => taskLines(g.tasks, { book: taskBook, rate, pricing, kits: new Map(), group: g.label }));
  return seedLinesFromCapture([...s.scopes.flatMap((g) => scopeLines(ownScopes(g.picks, codes), bk, g.label)), ...taskSeed], s.typedItems);
}

describe("the builder seeds exactly what the estimate page seeded", () => {
  it("same lines, same order, same values (no level, and a level)", () => {
    expect(visitEstimateLines(seed())).toEqual(before(seed()));
    const lvl = seed({ level: { markup_pct: 40, labor_rate: 135 } });
    expect(visitEstimateLines(lvl)).toEqual(before(lvl));
  });

  it("the order: the scope picks (a code that left the book dropped), then the tasks, then the typed rows (a blank one dropped)", () => {
    const lines = visitEstimateLines(seed());
    expect(lines.map((l) => l.description)).toEqual([
      "Service upgrade, 200A",
      "Allowance",
      "Hang the panel",
      "Trench to the shed",
      "200 ft 12-2 romex",
      "Weatherhead",
    ]);
    expect(lines[0]).toMatchObject({ quantity: 2, unit_price: 150, group: "Scopes" });
    expect(lines[4]).toMatchObject({ quantity: 200, unit: "ft", unit_price: 0 });
  });

  it("each line keeps a key for one read: scope:<question>:<code>, task:<question>:<task>, typed:<row>", () => {
    expect(visitEstimateRows(seed()).map((r) => r.key)).toEqual([
      "scope:q_scopes:S1",
      "scope:q_scopes:Z0",
      "task:q_tasks:t1",
      "task:q_tasks:t2",
      "typed:c1",
      "typed:c3",
    ]);
  });
});

describe("the one hole rule (M2)", () => {
  it("a flag OR a unit price of 0 or less; a priced line is no hole", () => {
    const holes = visitEstimateRows(seed()).map((r) => lineHole(r.line));
    expect(holes[0]).toBeNull(); // the $150 pick
    expect(holes[1]).toEqual({ kind: "zero", flag: null }); // a $0 price-list pick
    expect(holes[2]).toBeNull(); // 3 h at the default rate + two breakers
    expect(holes[3]).toEqual({ kind: "flag", flag: "hours?" }); // a task with no hours
    expect(holes[4]).toEqual({ kind: "zero", flag: null }); // a typed row, unpriced
    expect(holes[5]).toEqual({ kind: "flag", flag: "heard, not confirmed" }); // a typed row the capture flagged
  });
  it("by hand: negative and zero ask, a flag asks even with a price", () => {
    // cn-v1176 fix F3: re-pinned with a quantity (the rule now reads it).
    expect(lineHole({ quantity: 1, unit_price: -5 })).toEqual({ kind: "zero", flag: null });
    expect(lineHole({ quantity: 1, unit_price: 0 })).toEqual({ kind: "zero", flag: null });
    expect(lineHole({ quantity: 1, unit_price: 40, flag: "price? clips" })).toEqual({ kind: "flag", flag: "price? clips" });
    expect(lineHole({ quantity: 1, unit_price: 40 })).toBeNull();
  });
  it("cn-v1176 fix F3: a quantity of 0 or less, or an amount of 0 or less, is a hole even with a price", () => {
    expect(lineHole({ quantity: 0, unit_price: 50 })).toEqual({ kind: "zero", flag: null });
    expect(lineHole({ quantity: -2, unit_price: 50 })).toEqual({ kind: "zero", flag: null });
    expect(lineHole({ quantity: 0.001, unit_price: 1 })).toEqual({ kind: "zero", flag: null }); // rounds to $0.00
    expect(lineHole({ quantity: 0.25, unit_price: 4.02 })).toBeNull();
  });
});

describe("the pricing customer (the one deliberate change)", () => {
  it("the visit's customer, else its lead's, else none", () => {
    expect(pricingCustomerId("c-visit", "c-lead")).toBe("c-visit");
    expect(pricingCustomerId(null, "c-lead")).toBe("c-lead");
    expect(pricingCustomerId(undefined, null)).toBeNull();
  });
  it("the lead's customer's level prices the task: its labor rate, not the default", () => {
    const plain = visitEstimateRows(seed()).find((r) => r.key === "task:q_tasks:t1")!.line;
    const leveled = visitEstimateRows(seed({ level: { markup_pct: null, labor_rate: 200 } })).find((r) => r.key === "task:q_tasks:t1")!.line;
    expect(leveled.unit_price - plain.unit_price).toBeCloseTo(3 * (200 - 100), 2);
  });
  it("the page hands the builder the visit's customer, else its lead's (pinned at the source)", async () => {
    const { readFileSync } = await import("node:fs");
    const page = readFileSync("src/app/(app)/quotes/new/page.tsx", "utf8");
    expect(page).toContain("pricingCustomer = seedRead.pricingCustomerId;");
    // cn-v1176 fix U3 (re-pinned): the level is read by the customer's own id through the reader the
    // Won sheet uses (readPricingLevel), never found in the page's capped customer list.
    expect(page).toContain("readPricingLevel(supabase, pricingCustomer),");
    expect(page).toContain("level: seedLevel,");
    expect(page).not.toContain("seedCustomer");
    expect(readFileSync("src/app/(app)/appointments/won-actions.ts", "utf8")).toContain("readPricingLevel(sb, seed.pricingCustomerId),");
    const lib = readFileSync("src/lib/estimate/visit-lines.ts", "utf8");
    expect(lib).toContain("pricingCustomerId: pricingCustomerId(visit.customer_id, lead?.customer_id),");
    // The reads name their columns (projection law).
    expect(lib).toContain('.select("id, title, location, inquiry_id, capture, customer_id, job_id, type, status, outcome")');
    expect(lib).toContain('.select("id, intake, customer_id, name, company_name")');
    expect(lib).toContain('.select("id, pricing_levels(markup_pct, labor_rate)")');
  });
});

describe("the picks that still apply", () => {
  it("a scopes question the answers turned off seeds nothing; a tasks question seeds its tasks", () => {
    const pb: Playbook = {
      needs: [
        { key: "kind", label: "Kind", ask: "Which?", slot: { type: "select", options: ["Remodel", "Resurface"] } },
        { key: "remodel", label: "Remodel", ask: "Scopes?", slot: { type: "scopes" }, when: [{ key: "kind", in: ["Remodel"] }] },
        { key: "work", label: "Work", ask: "Tasks?", slot: { type: "tasks" } },
      ],
    } as unknown as Playbook;
    const out = visitPicks(pb, { kind: "Resurface", remodel: [{ code: "S1", qty: 1, price: 10 }], work: [{ id: "t1", name: "Hang the panel", hours: 2 }] } as never);
    expect(out.scopes).toEqual([]);
    expect(out.tasks.map((g) => [g.key, g.tasks.map((t) => t.id)])).toEqual([["work", ["t1"]]]);
  });
});
