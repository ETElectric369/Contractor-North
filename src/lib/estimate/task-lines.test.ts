import { describe, it, expect } from "vitest";
import type { TaskValue } from "@/lib/playbook/tasks";
import type { TaskDetail, TaskLabor } from "./line-map";
import {
  MAX_LABOR_ROWS,
  buildTaskDetail,
  coerceDraftLine,
  coerceTaskDetail,
  detailExplains,
  emptyTaskDetail,
  expandTaskKit,
  laborMinutes,
  laborMoney,
  lineNameWithUnits,
  reexpandTaskDetail,
  stripUnits,
  lineFromDetail,
  repriceTaskLine,
  taskFlags,
  taskFromLine,
  taskLines,
  taskMoney,
  partMoney,
  type TaskBookRow,
  type TaskKit,
  type TaskLineContext,
} from "./task-lines";

/**
 * THE LAW UNDER TEST: a task is one line, priced from HIS hours — one or more labor rows, each at
 * its own rate — and HIS parts, and a hole asks instead of guessing ([[no-speculation]]). A $0 here
 * is never a price — it is a question, and the flag names it. Nothing in this file lets a typical
 * figure in. The pre-1131 one-figure shape still reads, as one legacy row, and prices as it did.
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

/** One labor row, the rule's figure unless said otherwise. */
const row = (over: Partial<TaskLabor> = {}): TaskLabor => ({ label: null, person_id: null, hours: 3, rate: 145, rate_from: "rule", ...over });

describe("taskLines: one task, one line, his numbers", () => {
  it("prices hours × rate plus the parts at book cost through the markup rule — ONE rule row", () => {
    const [line] = taskLines([task({ materials: [{ code: "R1", words: null, qty: 1 }] })], ctx());
    // 3 h × $145 = $435; R1 costs $400, no item markup, org default 20% → $480.
    expect(line.description).toBe("Install transfer switch");
    expect(line.quantity).toBe(1);
    expect(line.unit).toBe("ea");
    expect(line.unit_price).toBe(915);
    expect(line.flag).toBeUndefined();
    expect(line.detail).toMatchObject({ task_id: "t1", units: null, kit_id: null });
    expect(line.detail?.labor).toEqual([{ label: null, person_id: null, hours: 3, rate: 145, rate_from: "rule" }]);
    expect(line.detail?.materials).toEqual([{ code: "R1", name: "Transfer switch, 200A", qty: 1, cost: 400, sell: 480 }]);
  });

  it("a rate he dictated in the scope seeds a 'stated' row; the rule's seeds a 'rule' row", () => {
    expect(taskLines([task()], ctx({ rate: 200, rateFrom: "stated" }))[0].detail?.labor[0]).toMatchObject({ rate: 200, rate_from: "stated" });
    expect(taskLines([task()], ctx({ rate: 145, rateFrom: "rule" }))[0].detail?.labor[0]).toMatchObject({ rate: 145, rate_from: "rule" });
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
    expect(line.detail?.labor[0].hours).toBeNull();
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

  it("with no labor rate the hours price nothing and say so", () => {
    const [line] = taskLines([task()], ctx({ rate: 0 }));
    expect(line.unit_price).toBe(0);
    expect(line.flag).toBe("no labor rate set");
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

describe("labor rows: the line's labor is the rows' sum, each priced as printed", () => {
  const two: TaskDetail = {
    task_id: "t1",
    labor: [row({ hours: 4, rate: 145 }), row({ label: "Helper", hours: 4, rate: 65, rate_from: "hand" })],
    units: null,
    kit_id: null,
    materials: [],
  };

  it("two rows at two rates: Σ rows, rounded per row then summed", () => {
    expect(taskMoney(two)).toEqual({ labor: 840, parts: 0, total: 840 }); // 4 × 145 + 4 × 65
    expect(laborMoney({ hours: 1.33, rate: 145 })).toBe(192.85);
    expect(laborMoney({ hours: null, rate: 145 })).toBe(0);
    // Rounded as printed: 1.33 × 145 = 192.85 and 0.33 × 65 = 21.45 → 214.30, the two bullets' sum.
    expect(taskMoney({ ...two, labor: [row({ hours: 1.33, rate: 145 }), row({ hours: 0.33, rate: 65 })] }).labor).toBe(214.3);
    expect(detailExplains(two, { quantity: 1, unit_price: 840 })).toBe(true);
    expect(taskFlags(two)).toBeUndefined();
  });

  it("flags name the row that asks when there is more than one: his label, else 'labor'", () => {
    expect(taskFlags({ ...two, labor: [row({ hours: 4 }), row({ label: "Helper", hours: null, rate: 65 })] })).toBe("hours? Helper");
    expect(taskFlags({ ...two, labor: [row({ hours: null }), row({ label: "Helper", hours: 4, rate: 65 })] })).toBe("hours? labor");
    expect(taskFlags({ ...two, labor: [row({ hours: null }), row({ person_id: "p-1", hours: null, rate: 65 })] })).toBe("hours? labor · hours? labor");
    // One row asks the plain way, as it always has.
    expect(taskFlags({ ...two, labor: [row({ hours: null })] })).toBe("hours?");
    // A row with hours and no rate says so — once, however many rows have none.
    expect(taskFlags({ ...two, labor: [row({ hours: 2, rate: 0 }), row({ label: "Helper", hours: 2, rate: 0 })] })).toBe("no labor rate set");
    // A breakdown with no rows at all is a task with no hours: it asks.
    expect(taskFlags({ ...two, labor: [] })).toBe("hours?");
    expect(taskMoney({ ...two, labor: [] }).labor).toBe(0);
  });

  it("the job's minutes are the rows' hours, summed; a row asking adds nothing; none → null", () => {
    expect(laborMinutes(two.labor)).toBe(480);
    expect(laborMinutes([row({ hours: 1.25 }), row({ hours: null })])).toBe(75);
    expect(laborMinutes([row({ hours: null })])).toBeNull();
    expect(laborMinutes([])).toBeNull();
  });

  it("repriceTaskLine: a rule row follows the new rule; a legacy row only while it still equals the old one; hand and stated stand", () => {
    const line = lineFromDetail(
      { description: "Panel", quantity: 1, unit: "ea", unit_price: 0 },
      {
        ...two,
        labor: [
          row({ hours: 1, rate: 145, rate_from: "rule" }),
          row({ label: "Old", hours: 1, rate: 145, rate_from: "legacy" }),
          row({ label: "Old typed", hours: 1, rate: 150, rate_from: "legacy" }),
          row({ label: "Helper", hours: 1, rate: 65, rate_from: "hand" }),
          row({ label: "Crew", hours: 1, rate: 200, rate_from: "stated" }),
        ],
      },
    );
    expect(line.unit_price).toBe(705);
    const local = repriceTaskLine(line, 125, 145);
    expect(local.detail?.labor.map((r) => r.rate)).toEqual([125, 125, 150, 65, 200]);
    expect(local.unit_price).toBe(665);
    expect(local.detail?.labor.map((r) => r.rate_from)).toEqual(["rule", "legacy", "legacy", "hand", "stated"]);
    // A line with no breakdown is left exactly as it is.
    const plain = { description: "Permit", quantity: 1, unit: "ea", unit_price: 250 };
    expect(repriceTaskLine(plain, 125, 145)).toBe(plain);
  });

  it("emptyTaskDetail: one rule row, no hours, nothing else — a fresh id each time", () => {
    const a = emptyTaskDetail({ rate: 145 });
    const b = emptyTaskDetail({ rate: 145 });
    expect(a).toEqual({ task_id: a.task_id, labor: [{ label: null, person_id: null, hours: null, rate: 145, rate_from: "rule" }], units: null, kit_id: null, materials: [] });
    expect(a.task_id).toBeTruthy();
    expect(a.task_id).not.toBe(b.task_id);
    expect(emptyTaskDetail({ rate: -3 }).labor[0].rate).toBe(0);
    expect(taskFlags(a)).toBe("hours?");
  });

  it("taskFromLine keeps his words and his typed price (a hand price until the breakdown explains it), lands under Tasks", () => {
    const typed = { description: "Hang the fan", quantity: 1, unit: "ea", unit_price: 300 };
    const made = taskFromLine(typed, { rate: 145 });
    expect(made).toMatchObject({ description: "Hang the fan", quantity: 1, unit: "ea", unit_price: 300, group: "Tasks", flag: "hours?" });
    expect(made.detail?.labor).toEqual([{ label: null, person_id: null, hours: null, rate: 145, rate_from: "rule" }]);
    expect(detailExplains(made.detail!, made)).toBe(false); // $300 is his, not the breakdown's
    expect(taskFromLine({ ...typed, group: "Electrical" }, { rate: 145 }).group).toBe("Electrical");
    // Typing the hours makes it the breakdown's: 2 h × $145 = $290 replaces the hand price.
    const answered = lineFromDetail(made, { ...made.detail!, labor: [{ ...made.detail!.labor[0], hours: 2 }] });
    expect(answered.unit_price).toBe(290);
    expect(answered.flag).toBeUndefined();
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

  it("a LINKED kit line is named without its code in front — the code rides in `code`, the name may reach the paper", () => {
    const linked = {
      id: "k2", name: "Footing", labor_minutes: 60, unit: "footing",
      items: [{ description: "C80 — Concrete (snapshot)", quantity: 2, unit: "ea", unit_price: 0, price_list_item_id: "pli-1",
        price_list_items: { id: "pli-1", code: "C80", description: "Concrete, 80 lb", unit: "ea", buy_price: 6, markup_pct: 0 } }],
    };
    const out = expandTaskKit(task({ units: 3, kit_id: "k2" }), linked, { orgDefaultPct: 0 });
    expect(out.materials).toEqual([{ code: "C80", name: "Concrete, 80 lb", qty: 6, cost: 6, sell: 6 }]);
  });

  it("a kit with no minutes gives no hours — the task still asks", () => {
    expect(expandTaskKit(task({ units: 3, hours: null }), { ...kit, labor_minutes: null }, { orgDefaultPct: 0 }).hours).toBeNull();
  });

  it("the line: HIS hours win over the kit's, the units ride the name and the breakdown, quantity stays 1", () => {
    const [line] = taskLines([task({ name: "Footings", hours: 8, units: 7, kit_id: "k1" })], ctx({ kits: new Map([["k1", kit]]) }));
    expect(line.description).toBe("Footings ×7");
    expect(line.quantity).toBe(1);
    expect(line.detail).toMatchObject({ units: 7, kit_id: "k1" });
    expect(line.detail?.labor[0]).toEqual({ label: null, person_id: null, hours: 8, rate: 145, rate_from: "rule" });
    // 8 h × $145 = $1,160; concrete 3 × $8 = $24; rebar 14 × $5 = $70.
    expect(line.unit_price).toBe(1254);
    const [fromKit] = taskLines([task({ name: "Footings", hours: null, units: 7, kit_id: "k1" })], ctx({ kits: new Map([["k1", kit]]) }));
    expect(fromKit.detail?.labor[0]).toMatchObject({ hours: 10.5, from_kit: true });
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
    labor: [row()],
    units: null,
    kit_id: null,
    materials: [{ code: "R1", name: "Transfer switch, 200A", qty: 1, cost: 400, sell: 480 }],
  };

  it("round-trips a stored breakdown and accepts the public, redacted shape (labor rows without person_id)", () => {
    expect(coerceTaskDetail(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
    expect(coerceTaskDetail({ labor: [{ label: "Helper", hours: 3, rate: 145 }], hours: null, rate: null, units: null, materials: [{ name: "Transfer switch, 200A", qty: 1, sell: 480 }] })).toEqual({
      task_id: "",
      labor: [{ label: "Helper", person_id: null, hours: 3, rate: 145, rate_from: "legacy" }],
      units: null,
      kit_id: null,
      materials: [{ code: null, name: "Transfer switch, 200A", qty: 1, cost: null, sell: 480 }],
    });
  });

  it("A LINE SAVED BEFORE cn-v1131 reads as ONE legacy row and prices exactly as it did: 20 h × $145 + the parts", () => {
    const legacy = {
      task_id: "t-old",
      hours: 20,
      rate: 145,
      hours_from_kit: false,
      units: null,
      kit_id: null,
      materials: [
        { code: "R1", name: "Transfer switch, 200A", qty: 1, cost: 400, sell: 480 },
        { code: null, name: "Bayberry clips", qty: 10, cost: null, sell: 1.5 },
      ],
    };
    const d = coerceTaskDetail(legacy)!;
    expect(d.labor).toEqual([{ label: null, person_id: null, hours: 20, rate: 145, rate_from: "legacy" }]);
    expect(d).not.toHaveProperty("hours");
    expect(d).not.toHaveProperty("rate");
    expect(taskMoney(d)).toEqual({ labor: 2900, parts: 495, total: 3395 });
    expect(taskFlags(d)).toBeUndefined();
    // The kit's mark carries onto the row; an old row with no hours is the hole it was.
    expect(coerceTaskDetail({ ...legacy, hours_from_kit: true })!.labor[0]).toMatchObject({ hours: 20, from_kit: true });
    expect(coerceTaskDetail({ ...legacy, hours: null })!.labor).toEqual([{ label: null, person_id: null, hours: null, rate: 145, rate_from: "legacy" }]);
    // The public wire ships BOTH sets of keys (0395): an empty labor array beside the old hours is the old shape.
    expect(coerceTaskDetail({ labor: [], hours: 20, rate: 145, units: null, materials: [] })!.labor).toEqual([
      { label: null, person_id: null, hours: 20, rate: 145, rate_from: "legacy" },
    ]);
    // A new-shape row with no rows stays that way: nothing is invented for it.
    expect(coerceTaskDetail({ labor: [], hours: null, rate: null, units: null, materials: [] })!.labor).toEqual([]);
    expect(coerceTaskDetail({ task_id: "t", labor: [], units: null, kit_id: null, materials: [] })!.labor).toEqual([]);
  });

  it("each labor row is read on its own terms: junk is the hole it is, never a crash", () => {
    const d = coerceTaskDetail({
      labor: [
        { label: "  Helper  ", person_id: " p-1 ", hours: "2.555", rate: "64.999", rate_from: "hand", from_kit: "yes" },
        { label: 7, person_id: 3, hours: -1, rate: -5, rate_from: "guess", from_kit: true },
        "not a row",
        null,
      ],
    })!;
    expect(d.labor).toEqual([
      { label: "Helper", person_id: "p-1", hours: 2.56, rate: 65, rate_from: "hand" },
      { label: null, person_id: null, hours: null, rate: 0, rate_from: "legacy", from_kit: true },
    ]);
  });

  it("refuses what is not a breakdown, and drops a part with no name", () => {
    expect(coerceTaskDetail(null)).toBeNull();
    expect(coerceTaskDetail("x")).toBeNull();
    expect(coerceTaskDetail([1])).toBeNull();
    expect(coerceTaskDetail({ hours: -2, rate: "abc", materials: [{ qty: 3 }, 7] })).toEqual({
      task_id: "",
      labor: [{ label: null, person_id: null, hours: null, rate: 0, rate_from: "legacy" }],
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
    const asking = lineFromDetail({ description: "Install transfer switch", quantity: 1, unit: "ea", unit_price: 0 }, { ...stored, labor: [row({ hours: null })] });
    expect(asking.unit_price).toBe(480);
    expect(asking.flag).toBe("hours?");
    const answered = lineFromDetail(asking, { ...asking.detail!, labor: [{ ...asking.detail!.labor[0], hours: 2.5 }] });
    expect(answered.unit_price).toBe(842.5);
    expect(answered.flag).toBeUndefined();
    const local = repriceTaskLine(answered, 125, 145);
    expect(local.detail?.labor[0].rate).toBe(125);
    expect(local.unit_price).toBe(792.5);
  });

  it("a book code at $0 and a $0 kit line are not prices: the part asks", () => {
    const [line] = taskLines([task({ hours: null, materials: [{ code: "ALLOW", words: null, qty: 1 }] })], ctx({ book: book({ code: "ALLOW", description: "Fixture allowance", unit: "ea", buy_price: 0, markup_pct: 0 }) }));
    expect(line.unit_price).toBe(0);
    expect(line.detail?.materials[0].sell).toBeNull();
    expect(line.flag).toBe("hours? · price? Fixture allowance");
    const out = expandTaskKit(task({ units: 2 }), { id: "k", name: "K", labor_minutes: null, unit: null, items: [{ description: "Unpriced thing", quantity: 1, unit: "ea", unit_price: 0 }] }, { orgDefaultPct: 0 });
    expect(out.materials[0].sell).toBeNull();
  });

  it("what the builder prices is what the save keeps: hours round the one way on every row, a nameless part counts for nothing", () => {
    const typed = lineFromDetail(
      { description: "Fan", quantity: 1, unit: "ea", unit_price: 0 },
      { ...stored, labor: [row({ hours: 1.333 }), row({ label: "Helper", hours: 0.5, rate: 64.999, rate_from: "hand" })], materials: [{ code: null, name: "", qty: 2, cost: null, sell: 50 }] },
    );
    expect(typed.detail?.labor.map((r) => [r.hours, r.rate])).toEqual([[1.33, 145], [0.5, 65]]);
    expect(typed.unit_price).toBe(225.35); // 1.33 × $145 + 0.5 × $65; the nameless part prices nothing
    expect(typed.flag).toBeUndefined(); // and asks nothing
    const back = coerceTaskDetail(JSON.parse(JSON.stringify(typed.detail)))!;
    expect(back.materials).toEqual([]);
    expect(detailExplains(back, typed)).toBe(true);
  });
});

describe("reexpandTaskDetail — the builder's units box on a kit-built line (W4): the kit's hours land on the FIRST row", () => {
  const kit = {
    id: "k1", name: "Footing", labor_minutes: 120, unit: "footing",
    items: [{ description: "Concrete, 80 lb", quantity: 4, unit: "ea", unit_price: 9.5, qty_round: "none", sort_order: 0 }],
  };
  const pricing = { orgDefaultPct: 0 };
  const built = buildTaskDetail({ id: "t1", name: "Footings", hours: null, units: 7, kit_id: "k1", materials: [{ code: null, words: "Rebar stake", qty: 14 }] }, {
    book: new Map(), rate: 100, pricing: { levelPct: null, orgDefaultPct: 0 }, kits: new Map([[kit.id, kit]]),
  });

  it("buildTaskDetail marks what the kit gave: its hours (on the one row) and its parts, never his", () => {
    expect(built.labor).toEqual([{ label: null, person_id: null, hours: 14, rate: 100, rate_from: "rule", from_kit: true }]);
    expect(built.materials.map((m) => [m.name, m.qty, m.from_kit ?? false])).toEqual([["Concrete, 80 lb", 28, true], ["Rebar stake", 14, false]]);
    const his = buildTaskDetail({ id: "t2", name: "Footings", hours: 3, units: 7, kit_id: "k1", materials: [] }, { book: new Map(), rate: 100, pricing: { levelPct: null, orgDefaultPct: 0 }, kits: new Map([[kit.id, kit]]) });
    expect(his.labor[0]).toEqual({ label: null, person_id: null, hours: 3, rate: 100, rate_from: "rule" });
  });

  it("another count re-derives the kit's hours and parts and leaves his own alone — other rows untouched", () => {
    const withHelper = { ...built, labor: [...built.labor, row({ label: "Helper", hours: 5, rate: 60, rate_from: "hand" })] };
    const eight = reexpandTaskDetail(withHelper, 8, kit, pricing);
    expect(eight.units).toBe(8);
    expect(eight.labor).toEqual([
      { label: null, person_id: null, hours: 16, rate: 100, rate_from: "rule", from_kit: true },
      { label: "Helper", person_id: null, hours: 5, rate: 60, rate_from: "hand" },
    ]);
    expect(eight.materials.map((m) => [m.name, m.qty])).toEqual([["Concrete, 80 lb", 32], ["Rebar stake", 14]]);
  });

  it("his typed hours on the first row and a kit part he edited by hand stand through a change of units — no twin, nothing appended", () => {
    const { from_kit: _h, ...typedRow } = built.labor[0];
    const typed = { ...built, labor: [{ ...typedRow, hours: 10 }] };
    const { from_kit: _k, ...edited } = typed.materials[0];
    const his = { ...typed, materials: [{ ...edited, qty: 30 }, typed.materials[1]] };
    const nine = reexpandTaskDetail(his, 9, kit, pricing);
    expect(nine.labor).toEqual([{ label: null, person_id: null, hours: 10, rate: 100, rate_from: "rule" }]);
    expect(nine.materials.map((m) => [m.name, m.qty, m.from_kit ?? false])).toEqual([["Concrete, 80 lb", 30, false], ["Rebar stake", 14, false]]);
  });

  it("a kit part he removed stays removed; a hole he left in the hours stays a hole", () => {
    const dropped = { ...built, materials: built.materials.slice(1) };
    expect(reexpandTaskDetail(dropped, 8, kit, pricing).materials.map((m) => m.name)).toEqual(["Rebar stake"]);
    expect(reexpandTaskDetail(dropped, 7, kit, pricing).materials.map((m) => m.name)).toEqual(["Rebar stake"]);
    const { from_kit: _h, ...clearedRow } = built.labor[0];
    const cleared = { ...built, labor: [{ ...clearedRow, hours: null }] };
    const eight = reexpandTaskDetail(cleared, 8, kit, pricing);
    expect(eight.labor).toEqual([{ label: null, person_id: null, hours: null, rate: 100, rate_from: "rule" }]);
  });

  it("a kit part keeps the price it was built with; only its count follows — a hole takes the kit's price", () => {
    const priced = { ...built, materials: [{ ...built.materials[0], sell: 9, cost: 7 }, built.materials[1]] };
    const eight = reexpandTaskDetail(priced, 8, kit, pricing);
    expect(eight.materials[0]).toEqual({ code: null, name: "Concrete, 80 lb", qty: 32, cost: 7, sell: 9, from_kit: true });
    const hole = { ...built, materials: [{ ...built.materials[0], sell: null, cost: null }, built.materials[1]] };
    expect(reexpandTaskDetail(hole, 8, kit, pricing).materials[0].sell).toBe(9.5);
  });

  it("a line saved before the marks (cn-v1076) is recognised by code or words, and its hours are the kit's only when they were", () => {
    const legacy = coerceTaskDetail(JSON.parse(JSON.stringify({ ...built, labor: [{ ...built.labor[0], from_kit: undefined }], materials: built.materials.map(({ from_kit: _f, ...m }) => m) })))!;
    const eight = reexpandTaskDetail(legacy, 8, kit, pricing);
    expect(eight.labor[0]).toMatchObject({ hours: 16, from_kit: true });
    expect(eight.materials.map((m) => [m.name, m.qty, m.from_kit ?? false])).toEqual([["Concrete, 80 lb", 32, true], ["Rebar stake", 14, false]]);
    const hisHours = reexpandTaskDetail({ ...legacy, labor: [{ ...legacy.labor[0], hours: 5 }] }, 8, kit, pricing);
    expect(hisHours.labor[0].hours).toBe(5);
    expect(hisHours.labor[0].from_kit).toBeUndefined();
  });

  it("a line seeded asking (no count, no hours) takes the kit's hours with its first count; a pre-1131 line does the same through its legacy row", () => {
    const seeded = buildTaskDetail({ id: "t3", name: "Footings", hours: null, units: null, kit_id: "k1", materials: [] }, { book: new Map(), rate: 100, pricing: { levelPct: null, orgDefaultPct: 0 }, kits: new Map([[kit.id, kit]]) });
    expect(taskFlags(seeded)).toBe("units?");
    expect(reexpandTaskDetail(seeded, 3, kit, pricing).labor[0]).toMatchObject({ hours: 6, from_kit: true });
    const old = coerceTaskDetail({ task_id: "t3", hours: null, rate: 100, units: null, kit_id: "k1", materials: [] })!;
    expect(reexpandTaskDetail(old, 3, kit, pricing).labor[0]).toMatchObject({ hours: 6, rate_from: "legacy", from_kit: true });
  });

  it("a breakdown with no rows has nowhere for the kit's hours to land: only the count and parts move, the line keeps asking", () => {
    const none = reexpandTaskDetail({ ...built, labor: [] }, 8, kit, pricing);
    expect(none.labor).toEqual([]);
    expect(none.units).toBe(8);
    expect(taskFlags(none)).toMatch(/^hours\?/);
  });

  it("the count is capped where the Inspector caps it", () => {
    expect(reexpandTaskDetail(built, 9_999_999, kit, pricing).units).toBe(100_000);
  });

  it("with no kit to expand only the count changes; the flags survive a save round trip only when true", () => {
    expect(reexpandTaskDetail(built, 3, null, pricing)).toEqual({ ...built, units: 3 });
    const back = coerceTaskDetail(JSON.parse(JSON.stringify(built)))!;
    expect(back.labor[0].from_kit).toBe(true);
    expect(back.materials[0].from_kit).toBe(true);
    expect("from_kit" in back.materials[1]).toBe(false);
    expect("from_kit" in coerceTaskDetail({ ...built, labor: [{ ...built.labor[0], from_kit: false }] })!.labor[0]).toBe(false);
  });

  it("the line's name carries the count: only the suffix the last count wrote is replaced", () => {
    expect(stripUnits("Footings ×7")).toBe("Footings");
    expect(lineNameWithUnits("Footings ×7", 7, 8)).toBe("Footings ×8");
    expect(lineNameWithUnits("Footings ×7", 7, 1)).toBe("Footings");
    expect(lineNameWithUnits("Footings", null, 3)).toBe("Footings ×3");
    // His own "4×4" and a hand-edited name are never rewritten under him.
    expect(lineNameWithUnits("Install 4×4", null, 8)).toBe("Install 4×4 ×8");
    expect(lineNameWithUnits("Footings ×7 (north)", 7, 8)).toBe("Footings ×7 (north) ×8");
  });
});

describe("a part's money is the figure the paper prints (item 4): rounded per part, then summed", () => {
  const part = (name: string, qty: number, sell: number) => ({ code: null, name, qty, cost: null, sell });
  const d: TaskDetail = {
    task_id: "t1",
    labor: [row({ hours: 2, rate: 100 })],
    units: null,
    kit_id: null,
    // Counts and prices carry two decimals; the products carry three: 0.91 + 4.975 + 0.495 + 3.99 = 10.37
    // rounded once, but as printed (0.91 + 4.98 + 0.50 + 3.99) = 10.38. The paper's sum is the rule.
    materials: [part("Wire nut", 7, 0.13), part("Strap", 2.5, 1.99), part("Tape", 1.5, 0.33), part("Anchor", 3, 1.33)],
  };
  it("partMoney rounds one part to cents in exact decimal arithmetic (half up, not the float's), and a hole counts as nothing", () => {
    expect(partMoney({ qty: 2.5, sell: 1.99 })).toBe(4.98); // the float product 4.97499… would say 4.97
    expect(partMoney({ qty: 1.5, sell: 0.33 })).toBe(0.5);
    expect(partMoney({ qty: 7, sell: 0.13 })).toBe(0.91);
    expect(partMoney({ qty: null, sell: 9 })).toBe(0);
    expect(partMoney({ qty: 3, sell: null })).toBe(0);
  });
  it("the line's parts figure is the sum of the printed parts, so labor + the bullets = the line to the cent", () => {
    const money = taskMoney(d);
    const printed = d.materials.reduce((t, m) => t + partMoney(m), 0);
    expect(money.parts).toBe(10.38);
    expect(money.parts).toBe(Math.round(printed * 100) / 100);
    expect(money.total).toBe(210.38);
    expect(money.labor + money.parts).toBeCloseTo(money.total, 10);
    expect(detailExplains(d, { quantity: 1, unit_price: 210.38 })).toBe(true);
    expect(detailExplains(d, { quantity: 1, unit_price: 210.37 })).toBe(false); // the old once-rounded sum no longer explains
  });
});

describe("the rows are capped, and a stored draft's line comes back through one reader (cn-v1131)", () => {
  it("coerceTaskDetail keeps at most MAX_LABOR_ROWS labor rows, the way the playbook caps a task's parts", () => {
    const rows = Array.from({ length: MAX_LABOR_ROWS + 5 }, (_, i) => ({ label: `Row ${i}`, person_id: null, hours: 1, rate: 100, rate_from: "hand" }));
    const d = coerceTaskDetail({ task_id: "t", labor: rows, units: null, kit_id: null, materials: [] })!;
    expect(MAX_LABOR_ROWS).toBe(20);
    expect(d.labor.length).toBe(MAX_LABOR_ROWS);
    expect(d.labor[0].label).toBe("Row 0");
    expect(d.labor[MAX_LABOR_ROWS - 1].label).toBe(`Row ${MAX_LABOR_ROWS - 1}`);
    // Junk rows are dropped BEFORE the cap counts, so the cap never costs a real row to a bad one.
    const mixed = coerceTaskDetail({ task_id: "t", labor: ["junk", null, ...rows], units: null, kit_id: null, materials: [] })!;
    expect(mixed.labor.length).toBe(MAX_LABOR_ROWS);
    expect(mixed.labor[0].label).toBe("Row 0");
  });

  it("coerceDraftLine: a line saved by an older build (the one-figure shape, no `labor`) restores as ONE legacy row with its flag rebuilt; a plain line is untouched; junk is no breakdown", () => {
    const old = {
      description: "Install transfer switch",
      quantity: 1,
      unit: "ea",
      unit_price: 3380,
      flag: "price? a 50 amp breaker",
      detail: { task_id: "t-old", hours: 20, rate: 145, units: null, kit_id: null, materials: [{ code: "R1", name: "Transfer switch, 200A", qty: 1, cost: 400, sell: 480 }] },
    } as const;
    const back = coerceDraftLine(old as unknown as Parameters<typeof coerceDraftLine>[0]);
    expect(back.detail!.labor).toEqual([{ label: null, person_id: null, hours: 20, rate: 145, rate_from: "legacy" }]);
    expect(back.detail).not.toHaveProperty("hours");
    // The flag is build-time only: rebuilt from the breakdown (nothing asks here), never the stale stored one.
    expect(back.flag).toBeUndefined();
    expect(back.unit_price).toBe(3380); // his numbers stand; the price is not re-derived on a restore
    // A hole in the old shape still asks after the restore.
    expect(coerceDraftLine({ ...old, detail: { ...old.detail, hours: null } } as unknown as Parameters<typeof coerceDraftLine>[0]).flag).toBe("hours?");
    // A new-shape line round-trips as itself; a proposal's own fields (pid, keep) ride through.
    const fresh = { description: "Trench", quantity: 1, unit: "ea", unit_price: 290, pid: 3, keep: true, detail: { task_id: "t", labor: [{ label: null, person_id: null, hours: 2, rate: 145, rate_from: "rule" as const }], units: null, kit_id: null, materials: [] } };
    expect(coerceDraftLine(fresh)).toEqual({ ...fresh, flag: undefined });
    // No breakdown, or junk where one should be: the line's words, numbers and flag as stored.
    const plain = { description: "Permit", quantity: 1, unit: "ea", unit_price: 250, flag: "Home Depot estimate" };
    expect(coerceDraftLine(plain)).toEqual({ ...plain, detail: undefined });
    expect(coerceDraftLine({ ...plain, detail: null })).toEqual({ ...plain, detail: undefined });
    expect(coerceDraftLine({ ...plain, detail: "junk" } as unknown as Parameters<typeof coerceDraftLine>[0])).toEqual({ ...plain, detail: undefined });
  });
});
