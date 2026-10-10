import { describe, it, expect } from "vitest";
import type { TaskValue } from "@/lib/playbook/tasks";
import type { TaskDetail } from "./line-map";
import {
  buildTaskDetail,
  coerceTaskDetail,
  detailExplains,
  expandTaskKit,
  lineFromDetail,
  repriceTaskLine,
  taskFlags,
  taskLines,
  taskMoney,
  type TaskBookRow,
  type TaskKit,
  type TaskLineContext,
} from "./task-lines";

/**
 * THE LAW UNDER TEST: a task is one line, priced from HIS hours and HIS parts, and a hole asks
 * instead of guessing ([[no-speculation]]). A $0 here is never a price — it is a question, and the
 * flag names it. Nothing in this file lets a typical figure in.
 */

const book = (...rows: TaskBookRow[]): Map<string, TaskBookRow> => new Map(rows.map((r) => [r.code, r]));

const BOOK = book(
  { code: "R1", description: "Transfer switch, 200A", unit: "ea", buy_price: 400, markup_pct: 0 },
  { code: "W142", description: "14/2 romex", unit: "roll", buy_price: 90, markup_pct: 15 },
);

const ctx = (over: Partial<TaskLineContext> = {}): TaskLineContext => ({
  book: BOOK,
  rate: 145,
  pricing: { levelPct: null, orgDefaultPct: 20 },
  ...over,
});

const task = (over: Partial<TaskValue> = {}): TaskValue => ({
  id: "t1",
  name: "Install transfer switch",
  hours: 3,
  units: null,
  kit_id: null,
  materials: [],
  ...over,
});

describe("taskLines: one task, one line, his numbers", () => {
  it("prices hours × rate plus the parts at book cost through the markup rule", () => {
    const [line] = taskLines([task({ materials: [{ code: "R1", words: null, qty: 1 }] })], ctx());
    // 3 h × $145 = $435; R1 costs $400, no item markup, org default 20% → $480.
    expect(line.description).toBe("Install transfer switch");
    expect(line.quantity).toBe(1);
    expect(line.unit).toBe("ea");
    expect(line.unit_price).toBe(915);
    expect(line.flag).toBeUndefined();
    expect(line.detail).toMatchObject({ task_id: "t1", hours: 3, rate: 145, units: null, kit_id: null });
    expect(line.detail?.materials).toEqual([{ code: "R1", name: "Transfer switch, 200A", qty: 1, cost: 400, sell: 480 }]);
  });

  it("the item's own markup wins over the org default; a customer level wins over both", () => {
    const parts = [{ code: "W142", words: null, qty: 2 }];
    const [byItem] = taskLines([task({ hours: null, materials: parts })], ctx());
    expect(byItem.detail?.materials[0].sell).toBe(103.5); // $90 × 1.15
    expect(byItem.unit_price).toBe(207);
    const [byLevel] = taskLines([task({ hours: null, materials: parts })], ctx({ pricing: { levelPct: 10, orgDefaultPct: 20 } }));
    expect(byLevel.detail?.materials[0].sell).toBe(99); // $90 × 1.10
  });

  it("a task without hours prices its labor at nothing and ASKS — never a typical figure", () => {
    const [line] = taskLines([task({ hours: null, materials: [{ code: "R1", words: null, qty: 1 }] })], ctx());
    expect(line.unit_price).toBe(480); // the parts only
    expect(line.flag).toBe("hours?");
    expect(line.detail?.hours).toBeNull();
  });

  it("a part in his words, uncounted, or off the book is named and asks, at $0", () => {
    const [line] = taskLines(
      [
        task({
          materials: [
            { code: null, words: "a 50 amp breaker", qty: 1 },
            { code: "W142", words: null, qty: null },
            { code: "ZZZ9", words: null, qty: 2 },
          ],
        }),
      ],
      ctx(),
    );
    expect(line.unit_price).toBe(435); // the hours only; no part is priced
    expect(line.flag).toBe("price? a 50 amp breaker · how many? 14/2 romex · not in the price book: ZZZ9");
    expect(line.detail?.materials).toEqual([
      { code: null, name: "a 50 amp breaker", qty: 1, cost: null, sell: null },
      { code: "W142", name: "14/2 romex", qty: null, cost: 90, sell: 103.5 },
      { code: "ZZZ9", name: "ZZZ9", qty: 2, cost: null, sell: null },
    ]);
  });

  it("with no company labor rate the hours price nothing and say so", () => {
    const [line] = taskLines([task()], ctx({ rate: 0 }));
    expect(line.unit_price).toBe(0);
    expect(line.flag).toBe("no company labor rate set");
  });

  it("keeps his order, lands under the question's label, and a lowercase code still finds the book", () => {
    const lines = taskLines(
      [task({ id: "a", name: "Hot tub wires", hours: null }), task({ id: "b", name: "Range circuit", hours: 2, materials: [{ code: "r1", words: null, qty: 1 }] })],
      ctx({ group: "Tasks" }),
    );
    expect(lines.map((l) => l.description)).toEqual(["Hot tub wires", "Range circuit"]);
    expect(lines.every((l) => l.group === "Tasks")).toBe(true);
    expect(lines[1].detail?.materials[0].code).toBe("R1");
  });
});

describe("expandTaskKit: a task per unit", () => {
  const kit: TaskKit = {
    id: "k1",
    name: "Footing",
    labor_minutes: 90,
    unit: "footing",
    items: [
      { id: "i2", description: "Rebar, #4", quantity: 2, unit: "ea", unit_price: 5, sort_order: 2 },
      { id: "i1", description: "Concrete, 60 lb", quantity: 0.3, unit: "bag", unit_price: 8, sort_order: 1, qty_round: "up" },
      { id: "i3", description: "Not in this task", quantity: 0, unit: "ea", unit_price: 99, sort_order: 3 },
    ],
  };

  it("multiplies his minutes and every kit line by the units, through the kit's rounding", () => {
    const out = expandTaskKit(task({ units: 7, kit_id: "k1" }), kit, { orgDefaultPct: 20, levelPct: null });
    expect(out.hours).toBe(10.5); // 90 min × 7 / 60
    // Authored order (sort_order), a 0-quantity line left out, 0.3 × 7 = 2.1 rounded up to 3.
    expect(out.materials).toEqual([
      { code: null, name: "Concrete, 60 lb", qty: 3, cost: null, sell: 8 },
      { code: null, name: "Rebar, #4", qty: 14, cost: null, sell: 5 },
    ]);
  });

  it("honours a kit line's minimum", () => {
    const out = expandTaskKit(
      task({ units: 2 }),
      { ...kit, items: [{ description: "Ties", quantity: 1, unit: "ea", unit_price: 1, qty_min: 5 }] },
      { orgDefaultPct: 0, levelPct: null },
    );
    expect(out.materials[0].qty).toBe(5);
  });

  it("a kit with no minutes gives no hours — the task still asks", () => {
    expect(expandTaskKit(task({ units: 3, hours: null }), { ...kit, labor_minutes: null }, { orgDefaultPct: 0 }).hours).toBeNull();
  });

  it("the line: HIS hours win over the kit's, the units ride the name and the breakdown, quantity stays 1", () => {
    const [line] = taskLines([task({ name: "Footings", hours: 8, units: 7, kit_id: "k1" })], ctx({ kits: new Map([["k1", kit]]) }));
    expect(line.description).toBe("Footings ×7");
    expect(line.quantity).toBe(1);
    expect(line.detail).toMatchObject({ hours: 8, units: 7, kit_id: "k1" });
    // 8 h × $145 = $1,160; concrete 3 × $8 = $24; rebar 14 × $5 = $70.
    expect(line.unit_price).toBe(1254);
    const [fromKit] = taskLines([task({ name: "Footings", hours: null, units: 7, kit_id: "k1" })], ctx({ kits: new Map([["k1", kit]]) }));
    expect(fromKit.detail?.hours).toBe(10.5);
    expect(fromKit.flag).toBeUndefined();
  });

  it("a kit id the caller did not load prices nothing extra and is not kept", () => {
    const d = buildTaskDetail(task({ kit_id: "gone" }), ctx());
    expect(d.kit_id).toBeNull();
    expect(d.materials).toEqual([]);
  });
});

describe("the breakdown, read back and kept honest", () => {
  const stored: TaskDetail = {
    task_id: "t1",
    hours: 3,
    rate: 145,
    units: null,
    kit_id: null,
    materials: [{ code: "R1", name: "Transfer switch, 200A", qty: 1, cost: 400, sell: 480 }],
  };

  it("round-trips a stored breakdown and accepts the public, redacted shape", () => {
    expect(coerceTaskDetail(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    expect(coerceTaskDetail({ hours: 3, rate: 145, units: null, materials: [{ name: "Transfer switch, 200A", qty: 1, sell: 480 }] })).toEqual({
      task_id: "",
      hours: 3,
      rate: 145,
      units: null,
      kit_id: null,
      materials: [{ code: null, name: "Transfer switch, 200A", qty: 1, cost: null, sell: 480 }],
    });
  });

  it("refuses what is not a breakdown, and drops a part with no name", () => {
    expect(coerceTaskDetail(null)).toBeNull();
    expect(coerceTaskDetail("x")).toBeNull();
    expect(coerceTaskDetail([1])).toBeNull();
    expect(coerceTaskDetail({ hours: -2, rate: "abc", materials: [{ qty: 3 }, 7] })).toEqual({
      task_id: "",
      hours: null,
      rate: 0,
      units: null,
      kit_id: null,
      materials: [],
    });
  });

  it("adds up in cents, and explains the line only while the sums match", () => {
    expect(taskMoney(stored)).toEqual({ labor: 435, parts: 480, total: 915 });
    expect(detailExplains(stored, { quantity: 1, unit_price: 915 })).toBe(true);
    expect(detailExplains(stored, { quantity: 1, unit_price: 900 })).toBe(false); // a hand edit
    expect(detailExplains(stored, { quantity: 2, unit_price: 915 })).toBe(false);
    expect(taskFlags(stored)).toBeUndefined();
  });

  it("lineFromDetail re-prices after he types the hours; repriceTaskLine follows the customer's rate", () => {
    const asking = lineFromDetail({ description: "Install transfer switch", quantity: 1, unit: "ea", unit_price: 0 }, { ...stored, hours: null });
    expect(asking.unit_price).toBe(480);
    expect(asking.flag).toBe("hours?");
    const answered = lineFromDetail(asking, { ...asking.detail!, hours: 2.5 });
    expect(answered.unit_price).toBe(842.5);
    expect(answered.flag).toBeUndefined();
    const local = repriceTaskLine(answered, 125);
    expect(local.detail?.rate).toBe(125);
    expect(local.unit_price).toBe(792.5);
    // A line with no breakdown is left exactly as it is.
    const plain = { description: "Permit", quantity: 1, unit: "ea", unit_price: 250 };
    expect(repriceTaskLine(plain, 125)).toBe(plain);
  });
});
