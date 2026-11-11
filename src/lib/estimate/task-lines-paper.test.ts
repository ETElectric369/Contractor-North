import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ESTIMATE_FORMATS, type EstimateFormat } from "@/lib/doc-style";
import type { TaskDetail, TaskDetailMaterial, TaskLabor } from "./line-map";
import {
  coerceDraftLine,
  coerceTaskDetail,
  laborMoney,
  lineFromDetail,
  normalizeTaskDetail,
  paperBreakdown,
  partMoney,
  taskMoney,
  type PaperBreakdown,
} from "./task-lines";

/**
 * WHAT PRINTS UNDER A TASK LINE IS ONE DECISION (cn-v1158, 0408). Erik, 2026-11-10: "an option to list
 * out all the materials shown as it is now and an option to group the materials into one materials
 * line as im finding that different people require different solutions." paperBreakdown answers for
 * all three formats and for both shapes a line's detail arrives in — the office's own row, and what
 * public_quote ships to the customer's page — and this file holds it to four things:
 *
 *   1. "grouped" is "detailed" with the parts folded into ONE figure: the same gate, the same labor
 *      rows, the same "For each one:", and never a part's name.
 *   2. The figure is taskMoney's parts, so a grouped paper adds up to the same cents a detailed one does.
 *   3. The gate holds on the customer's shape too: the wire's one number stands in for the parts it
 *      replaced, and one that does not add up prints nothing.
 *   4. That number is the wire's alone. No reader a save goes through carries it.
 */

const row = (over: Partial<TaskLabor> = {}): TaskLabor => ({ label: null, person_id: null, hours: 4, rate: 125, rate_from: "rule", ...over });
const part = (name: string, qty: number | null, sell: number | null): TaskDetailMaterial => ({ code: null, name, qty, cost: null, sell });
const detail = (labor: TaskLabor[], materials: TaskDetailMaterial[] = []): TaskDetail => ({ task_id: "t1", labor, units: null, kit_id: null, materials });
const line = (d: unknown, unit_price: number, quantity: unknown = 1) => ({ description: "Panel work", quantity, unit: "ea", unit_price, detail: d });

/** 4 h × $125 + a helper's 4 h × $85 + two breakers at $20 = $880 for one of the task. */
const PANEL = detail([row(), row({ label: "Helper", rate: 85, rate_from: "hand" })], [part("Tandem breaker, 20A", 2, 20)]);
/** 2 h × $100 + four parts whose products carry three decimals: $10.38 as printed, $10.37 rounded once. */
const FAN = detail(
  [row({ hours: 2, rate: 100 })],
  [part("Wire nut", 7, 0.13), part("Strap", 2.5, 1.99), part("Tape", 1.5, 0.33), part("Anchor", 3, 1.33)],
);

const cents = (n: number | null): number => Math.round((n ?? 0) * 100);

/**
 * WHAT public_quote SHIPS FOR ONE LINE'S DETAIL — the contract this lane is coded to (0395's keys; the
 * "grouped" arm since 0408). Never a cost, a code, the task or kit id or a person's id. Under
 * "grouped" the parts do not travel at all: `materials` is empty and `materials_total` is their sum
 * for one of the task — each part rounded to cents, then added (SQL's round(qty × sell, 2), summed),
 * null when no part is priced. Written here in whole cents and on purpose NOT through partMoney: the
 * server's sum and the paper's have to agree without sharing a line of code.
 */
function wire(d: TaskDetail, format: "detailed" | "grouped"): Record<string, unknown> {
  const head = { hours: null, rate: null, units: d.units, labor: d.labor.map(({ label, hours, rate }) => ({ label, hours, rate })) };
  if (format === "detailed") return { ...head, materials: d.materials.map(({ name, qty, sell }) => ({ name, qty, sell })) };
  const total = d.materials.reduce((t, m) => t + Math.round((cents(m.qty) * cents(m.sell)) / 100), 0);
  return { ...head, materials: [], materials_total: total > 0 ? total / 100 : null };
}

/** What a breakdown puts on the paper and nothing it does not: each labor bullet's word, hours, rate
 *  and money; each part's name, count and money; the one figure; the sub-heading. (The wire's rows come
 *  back without a person or a rate_from, and its parts without a code or a cost: none of that prints.) */
const printed = (b: PaperBreakdown | null) =>
  b && {
    perUnit: b.perUnit,
    labor: b.labor.map((r) => [r.label ?? "Labor", r.hours, r.rate, laborMoney(r)]),
    parts: b.parts.map((m) => [m.name, m.qty, m.qty !== null && m.sell !== null ? partMoney(m) : null]),
    materials: b.materials,
  };

/** The bullets' money, added the way a customer adds them: each figure as printed, in whole cents. */
const bulletCents = (b: PaperBreakdown): number =>
  b.labor.reduce((t, r) => t + cents(laborMoney(r)), 0) + b.parts.reduce((t, m) => t + cents(partMoney(m)), 0) + cents(b.materials);

describe("paperBreakdown: the three formats", () => {
  it("tasks: the line alone, whatever is behind it", () => {
    expect(paperBreakdown(line(PANEL, 880), "tasks")).toBeNull();
    expect(paperBreakdown(line(PANEL, 880, 2), "tasks")).toBeNull();
    expect(paperBreakdown(line(wire(PANEL, "grouped"), 880), "tasks")).toBeNull();
  });

  it("detailed: the labor rows he gave hours to and every part; no Materials figure", () => {
    expect(paperBreakdown(line(PANEL, 880), "detailed")).toEqual({ perUnit: false, labor: PANEL.labor, parts: PANEL.materials, materials: null });
  });

  it("grouped: the same labor rows, NO part, and the parts as one figure — taskMoney's own", () => {
    const b = paperBreakdown(line(PANEL, 880), "grouped");
    expect(b).toEqual({ perUnit: false, labor: PANEL.labor, parts: [], materials: 40 });
    expect(b!.materials).toBe(taskMoney(PANEL).parts);
    // The two papers are the same breakdown: only the parts are folded.
    const d = paperBreakdown(line(PANEL, 880), "detailed")!;
    expect(b!.labor).toEqual(d.labor);
    expect(b!.perUnit).toBe(d.perUnit);
    expect(bulletCents(b!)).toBe(bulletCents(d));
    expect(bulletCents(b!)).toBe(88_000);
  });

  it("the three words are the whole list, and anything else prints nothing", () => {
    expect([...ESTIMATE_FORMATS]).toEqual(["tasks", "detailed", "grouped"]);
    for (const junk of ["itemized", "GROUPED", "", null, undefined, 1, true]) {
      expect(paperBreakdown(line(PANEL, 880), junk as never), String(junk)).toBeNull();
    }
  });

  it("a line with no breakdown, or junk where one should be, prints nothing under any format", () => {
    for (const format of ESTIMATE_FORMATS) {
      expect(paperBreakdown({ unit_price: 640 }, format)).toBeNull();
      for (const junk of [null, undefined, "x", 7, [1], true]) expect(paperBreakdown(line(junk, 640), format)).toBeNull();
    }
  });

  it("'For each one:' rides the line's count, read the way the job reads it (lineQty)", () => {
    for (const format of ["detailed", "grouped"] as const) {
      expect(paperBreakdown(line(PANEL, 880, 2), format)!.perUnit).toBe(true);
      expect(paperBreakdown(line(PANEL, 880, 1.5), format)!.perUnit).toBe(true);
      expect(paperBreakdown(line(PANEL, 880, "3"), format)!.perUnit).toBe(true);
      // One of it — and a blank, a 0 or junk is one of it too.
      for (const one of [1, "1", 0, null, undefined, "lots", -2]) expect(paperBreakdown(line(PANEL, 880, one), format)!.perUnit, String(one)).toBe(false);
      expect(paperBreakdown({ unit_price: 880, detail: PANEL }, format)!.perUnit).toBe(false);
    }
  });

  it("a row with no hours yet is left out; with no row that has hours and no parts, nothing prints", () => {
    const asking = detail([row({ label: "Helper", hours: null, rate: 85 }), row({ hours: 2, rate: 100 })]);
    for (const format of ["detailed", "grouped"] as const) {
      expect(printed(paperBreakdown(line(asking, 200), format))).toEqual({ perUnit: false, labor: [["Labor", 2, 100, 200]], parts: [], materials: null });
      expect(paperBreakdown(line(detail([row({ hours: null })]), 0), format)).toBeNull();
      expect(paperBreakdown(line(detail([]), 0), format)).toBeNull();
    }
  });

  it("an old line's {hours, rate} is one Labor row under either format", () => {
    const old = { task_id: "t-old", hours: 2, rate: 125, units: null, kit_id: null, materials: [part("Tandem breaker, 20A", 2, 20)] };
    expect(printed(paperBreakdown(line(old, 290), "detailed"))).toEqual({ perUnit: false, labor: [["Labor", 2, 125, 250]], parts: [["Tandem breaker, 20A", 2, 40]], materials: null });
    expect(printed(paperBreakdown(line(old, 290), "grouped"))).toEqual({ perUnit: false, labor: [["Labor", 2, 125, 250]], parts: [], materials: 40 });
  });
});

describe("paperBreakdown: the ONE Materials figure", () => {
  it("each part is rounded as it prints and THEN added: 2.5 × $1.99 counts as $4.98 inside the figure", () => {
    const b = paperBreakdown(line(FAN, 210.38), "grouped")!;
    expect(b.materials).toBe(10.38); // 0.91 + 4.98 + 0.50 + 3.99; the raw products rounded once say 10.37
    expect(b.materials).toBe(FAN.materials.reduce((t, m) => t + cents(partMoney(m)), 0) / 100);
    expect(bulletCents(b)).toBe(21_038);
    // The once-rounded sum is a hand price to both papers: nothing prints.
    expect(paperBreakdown(line(FAN, 210.37), "grouped")).toBeNull();
    expect(paperBreakdown(line(FAN, 210.37), "detailed")).toBeNull();
    // One part alone, where the float product (4.97499…) would have said $4.97.
    expect(paperBreakdown(line(detail([], [part("Strap", 2.5, 1.99)]), 4.98), "grouped")).toEqual({ perUnit: false, labor: [], parts: [], materials: 4.98 });
  });

  it("no parts: no figure — the labor bullets and nothing after them", () => {
    const b = paperBreakdown(line(detail([row({ hours: 3, rate: 145 })]), 435), "grouped");
    expect(b).toEqual({ perUnit: false, labor: [row({ hours: 3, rate: 145 })], parts: [], materials: null });
  });

  it("parts with no price or no count: no figure, never a $0.00 — while detailed still names them", () => {
    const unpriced = detail([row({ hours: 1.5, rate: 90 })], [part("Fixture, supplied by owner", 1, null), part("Mounting block", null, 12)]);
    expect(taskMoney(unpriced).parts).toBe(0);
    const grouped = paperBreakdown(line(unpriced, 135), "grouped")!;
    expect(grouped.materials).toBeNull();
    expect(grouped.parts).toEqual([]);
    expect(printed(grouped)!.labor).toEqual([["Labor", 1.5, 90, 135]]);
    expect(printed(paperBreakdown(line(unpriced, 135), "detailed"))!.parts).toEqual([["Fixture, supplied by owner", 1, null], ["Mounting block", null, null]]);
    // A part priced at $0 on purpose adds nothing either: the figure is money, and there is none.
    expect(paperBreakdown(line(detail([row({ hours: 1, rate: 90 })], [part("Blank plate", 2, 0)]), 90), "grouped")!.materials).toBeNull();
  });

  it("one priced part among unpriced ones: the figure is the priced money", () => {
    const mixed = detail([row({ hours: 1, rate: 100 })], [part("Fixture, supplied by owner", 1, null), part("Old-work box", 2, 4.25)]);
    expect(paperBreakdown(line(mixed, 108.5), "grouped")).toEqual({ perUnit: false, labor: mixed.labor, parts: [], materials: 8.5 });
  });

  it("parts and no labor hours: the figure alone; unpriced parts and no labor hours: nothing to say, so nothing prints", () => {
    const partsOnly = detail([], [part("Smoke alarm", 1, 38.5)]);
    expect(paperBreakdown(line(partsOnly, 38.5, 3), "grouped")).toEqual({ perUnit: true, labor: [], parts: [], materials: 38.5 });
    const names = detail([row({ hours: null })], [part("Fixture, supplied by owner", 1, null)]);
    // Detailed has the part's name to print under a $0 line; grouped has no bullet at all, and a
    // sub-heading over nothing would be worse than the line alone.
    expect(paperBreakdown(line(names, 0, 2), "detailed")).not.toBeNull();
    expect(paperBreakdown(line(names, 0, 2), "grouped")).toBeNull();
  });
});

describe("paperBreakdown: the gate — only while the breakdown still explains the UNIT price", () => {
  it("a price edited by hand prints nothing under either format; a cent off is a hand price", () => {
    for (const format of ["detailed", "grouped"] as const) {
      expect(paperBreakdown(line(PANEL, 880), format)).not.toBeNull();
      for (const hand of [900, 880.01, 879.99, 840, 0, 1760]) expect(paperBreakdown(line(PANEL, hand), format), `${format} ${hand}`).toBeNull();
      // Two of the task: the breakdown explains the unit price, never the line total typed in its place.
      expect(paperBreakdown(line(PANEL, 880, 2), format)).not.toBeNull();
      expect(paperBreakdown(line(PANEL, 1760, 2), format)).toBeNull();
    }
  });

  it("the format is only read: the line and its detail are handed back untouched", () => {
    const frozen = <T>(v: T): T => {
      if (v && typeof v === "object") {
        Object.values(v as object).forEach(frozen);
        Object.freeze(v);
      }
      return v;
    };
    for (const d of [PANEL, wire(PANEL, "detailed"), wire(PANEL, "grouped")]) {
      const l = frozen(line(JSON.parse(JSON.stringify(d)), 880, 2));
      const before = JSON.stringify(l);
      for (const format of ESTIMATE_FORMATS) expect(() => paperBreakdown(l, format)).not.toThrow(); // a write to a frozen line would throw
      expect(JSON.stringify(l)).toBe(before);
    }
  });
});

describe("paperBreakdown: the customer's page — what public_quote ships answers as the office's row does", () => {
  it("detailed: the redacted rows and parts print the same bullets", () => {
    for (const [d, unit, qty] of [[PANEL, 880, 1], [FAN, 210.38, 2]] as const) {
      const office = paperBreakdown(line(d, unit, qty), "detailed");
      expect(office).not.toBeNull();
      expect(printed(paperBreakdown(line(wire(d, "detailed"), unit, qty), "detailed"))).toEqual(printed(office));
    }
  });

  it("grouped: no parts on the wire and materials_total in their place — the same bullets, the same figure", () => {
    const shipped = wire(PANEL, "grouped");
    expect(shipped).toEqual({
      hours: null,
      rate: null,
      units: null,
      labor: [{ label: null, hours: 4, rate: 125 }, { label: "Helper", hours: 4, rate: 85 }],
      materials: [],
      materials_total: 40,
    });
    const page = paperBreakdown(line(shipped, 880), "grouped");
    expect(printed(page)).toEqual({ perUnit: false, labor: [["Labor", 4, 125, 500], ["Helper", 4, 85, 340]], parts: [], materials: 40 });
    expect(printed(page)).toEqual(printed(paperBreakdown(line(PANEL, 880), "grouped")));
    // The server's whole-cents sum and the paper's agree on the three-decimal products too.
    expect(wire(FAN, "grouped").materials_total).toBe(10.38);
    expect(printed(paperBreakdown(line(wire(FAN, "grouped"), 210.38, 2), "grouped"))).toEqual(printed(paperBreakdown(line(FAN, 210.38, 2), "grouped")));
    expect(bulletCents(paperBreakdown(line(wire(FAN, "grouped"), 210.38, 2), "grouped")!)).toBe(21_038);
  });

  it("an old line on the wire (labor [], the old hours and rate beside it) is one Labor row and the figure", () => {
    const shipped = { hours: 2, rate: 125, units: null, labor: [], materials: [], materials_total: 40 };
    expect(printed(paperBreakdown(line(shipped, 290), "grouped"))).toEqual({ perUnit: false, labor: [["Labor", 2, 125, 250]], parts: [], materials: 40 });
  });

  it("THE GATE HOLDS ON THE WIRE: a materials_total that does not add up prints nothing", () => {
    const shipped = wire(PANEL, "grouped");
    for (const wrong of [40.01, 39.99, 4, 400, 880]) {
      expect(paperBreakdown(line({ ...shipped, materials_total: wrong }, 880), "grouped"), String(wrong)).toBeNull();
    }
    // The figure missing while the price has parts in it: the labor alone does not explain $880.
    const { materials_total: _gone, ...without } = shipped;
    expect(paperBreakdown(line(without, 880), "grouped")).toBeNull();
    expect(paperBreakdown(line({ ...shipped, materials_total: null }, 880), "grouped")).toBeNull();
    // And a hand-edited price is a hand price on the wire as it is in the office.
    expect(paperBreakdown(line(shipped, 900), "grouped")).toBeNull();
  });

  it("materials_total is money or it is nothing: a number above zero, or the same as a numeric string", () => {
    const shipped = wire(PANEL, "grouped");
    expect(paperBreakdown(line({ ...shipped, materials_total: "40" }, 880), "grouped")!.materials).toBe(40);
    expect(paperBreakdown(line({ ...shipped, materials_total: "40.00" }, 880), "grouped")!.materials).toBe(40);
    for (const junk of [0, -40, "", "forty", true, [40], { amount: 40 }, Number.NaN, Number.POSITIVE_INFINITY, null, undefined]) {
      // Not a figure: the line then stands or falls on its labor. $840 of labor explains $840 and not $880.
      expect(paperBreakdown(line({ ...shipped, materials_total: junk }, 880), "grouped"), String(junk)).toBeNull();
      expect(paperBreakdown(line({ ...shipped, materials_total: junk }, 840), "grouped"), String(junk)).toMatchObject({ parts: [], materials: null });
    }
  });

  it("under 'detailed' the wire's total is never read: a sum with no parts to show for it is not printed around", () => {
    const shipped = wire(PANEL, "grouped");
    expect(paperBreakdown(line(shipped, 880), "detailed")).toBeNull(); // $840 of bullets under an $880 line
    expect(printed(paperBreakdown(line(shipped, 840), "detailed"))).toEqual({ perUnit: false, labor: [["Labor", 4, 125, 500], ["Helper", 4, 85, 340]], parts: [], materials: null });
  });

  it("the parts in hand ARE the figure: a stray materials_total beside real parts is not read", () => {
    expect(paperBreakdown(line({ ...PANEL, materials_total: 999 }, 880), "grouped")!.materials).toBe(40);
    expect(paperBreakdown(line({ ...PANEL, materials_total: 999 }, 1839), "grouped")).toBeNull();
    // Parts in hand that price nothing say "nothing", whatever number sits beside them.
    const unpriced = { ...detail([row(), row({ label: "Helper", rate: 85 })], [part("Tandem breaker, 20A", 2, null)]), materials_total: 40 };
    expect(paperBreakdown(line(unpriced, 880), "grouped")).toBeNull();
    expect(paperBreakdown(line(unpriced, 840), "grouped")!.materials).toBeNull();
  });

  it("NO PART'S NAME LEAVES A GROUPED ANSWER — not the parts in hand, not the stand-in the wire's figure is added up as", () => {
    const names = [...PANEL.materials, ...FAN.materials].map((m) => m.name);
    const answers = [
      paperBreakdown(line(PANEL, 880), "grouped"),
      paperBreakdown(line(FAN, 210.38, 2), "grouped"),
      paperBreakdown(line(wire(PANEL, "grouped"), 880), "grouped"),
      paperBreakdown(line(wire(FAN, "grouped"), 210.38, 2), "grouped"),
      // A wire that carried the parts anyway (the detailed arm's payload under the grouped word).
      paperBreakdown(line(wire(PANEL, "detailed"), 880), "grouped"),
    ];
    for (const b of answers) {
      expect(b).not.toBeNull();
      expect(b!.parts).toEqual([]);
      const said = JSON.stringify(b);
      for (const name of names) expect(said).not.toContain(name);
      expect(said).not.toContain('"name"');
      expect(Object.keys(b!).sort()).toEqual(["labor", "materials", "parts", "perUnit"]);
    }
  });
});

describe("the wire-only figure cannot ride a save", () => {
  it("coerceTaskDetail builds its answer key by key, and materials_total is not one of the keys", () => {
    const shipped = wire(PANEL, "grouped");
    expect(shipped.materials_total).toBe(40);
    const read = coerceTaskDetail(shipped)!;
    expect(read).not.toHaveProperty("materials_total");
    expect(Object.keys(read).sort()).toEqual(["kit_id", "labor", "materials", "task_id", "units"]);
    // The office's own row with the figure put on it reads back as the row, without it.
    expect(coerceTaskDetail({ ...PANEL, materials_total: 40 })).toEqual(PANEL);
    expect(JSON.stringify(coerceTaskDetail({ ...PANEL, materials_total: 40 }))).not.toContain("materials_total");
  });

  it("the readers a draft is restored and re-priced through do not carry it either", () => {
    const restored = coerceDraftLine({ description: "Panel work", quantity: 1, unit: "ea", unit_price: 880, detail: { ...PANEL, materials_total: 40 } as TaskDetail });
    expect(restored.detail).toEqual(PANEL);
    const repriced = lineFromDetail(restored, normalizeTaskDetail(restored.detail!));
    expect(repriced.unit_price).toBe(880);
    expect(JSON.stringify(repriced)).not.toContain("materials_total");
  });

  it("TaskDetail has no such field: writing one on a typed breakdown is a type error", () => {
    // @ts-expect-error materials_total is the public wire's alone (public_quote, 0408) — never a stored field.
    const typed: TaskDetail = { task_id: "t", labor: [], units: null, kit_id: null, materials: [], materials_total: 40 };
    expect(coerceTaskDetail(typed)).not.toHaveProperty("materials_total");
  });

  it("every detail the estimate's save doors write is coerceTaskDetail's answer (the actions, read as source)", () => {
    const actions = readFileSync(join(process.cwd(), "src/app/(app)/quotes/actions.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/[^\n]*$/gm, "");
    // Every `detail:` key built from a line's own detail…
    const written = [...actions.matchAll(/\bdetail: ([^\n]*\.detail\b[^\n]*)/g)].map((m) => m[1].trim());
    expect(written.length).toBeGreaterThanOrEqual(4);
    for (const w of written) expect(w, w).toMatch(/^coerceTaskDetail\(/);
    // …and the one-line update, which keeps the answer in a const so a breakdown that does not read is refused.
    expect(actions).toMatch(/const d = coerceTaskDetail\(item\.detail\);[\s\S]{0,300}clean\.detail = d;/);
    expect(actions).not.toMatch(/clean\.detail = item\.detail/);
  });
});

describe("the bullets add up on every answer, from either shape — a generated table", () => {
  // A small fixed-seed generator: the same 400 lines on every run, stored-shape numbers (two decimals).
  let seed = 1158;
  const rnd = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const two = (max: number): number => Math.max(0.01, Math.round(rnd() * max * 100) / 100);
  const NAMES = ["Tandem breaker, 20A", "Strap", "Wire nut", "Old-work box", "14/2 NM-B", "Blank plate"];

  const generated = (): TaskDetail =>
    detail(
      Array.from({ length: Math.floor(rnd() * 4) }, () =>
        row({ label: pick([null, null, "Helper", "2-man crew"]), hours: pick([null, 2, 1.33, 0.25, two(40)]), rate: pick([0, 85, 125, 145, two(250)]), rate_from: pick(["rule", "hand", "stated", "legacy"] as const) }),
      ),
      Array.from({ length: Math.floor(rnd() * 5) }, () => part(pick(NAMES), pick([null, 1, 2, 2.5, 1.5, two(20)]), pick([null, 0, 1.99, 0.13, 0.33, two(300)]))),
    );

  it("400 lines × 2 formats: labor bullets + parts (or the one figure) = the unit price to the cent, and the wire answers the same", () => {
    const seen = { detailed: 0, grouped: 0, figure: 0, noFigure: 0, nothing: 0 };
    for (let n = 0; n < 400; n++) {
      // Through the one reader first, as a stored row always has been.
      const d = coerceTaskDetail(JSON.parse(JSON.stringify(generated())))!;
      const unit = taskMoney(d).total;
      const qty = pick([1, 1, 2, 3, 1.5]);
      for (const format of ["detailed", "grouped"] as const) {
        const office = paperBreakdown(line(d, unit, qty), format);
        const page = paperBreakdown(line(wire(d, format), unit, qty), format);
        expect(printed(page), `#${n} ${format}`).toEqual(printed(office));
        if (!office) {
          seen.nothing++;
          continue;
        }
        seen[format]++;
        expect(bulletCents(office), `#${n} ${format}`).toBe(cents(unit));
        expect(office.perUnit).toBe(qty !== 1);
        expect(office.labor).toEqual(d.labor.filter((r) => r.hours !== null));
        if (format === "detailed") {
          expect(office.parts).toEqual(d.materials);
          expect(office.materials).toBeNull();
        } else {
          expect(office.parts).toEqual([]);
          expect(office.materials).toBe(taskMoney(d).parts > 0 ? taskMoney(d).parts : null);
          if (office.materials === null) seen.noFigure++;
          else seen.figure++;
        }
        // A cent of hand edit, from either shape, and the paper says nothing.
        expect(paperBreakdown(line(d, unit + 0.01, qty), format)).toBeNull();
        expect(paperBreakdown(line(wire(d, format), unit + 0.01, qty), format)).toBeNull();
      }
    }
    // The table is not vacuous: each branch was walked many times.
    expect(seen.detailed).toBeGreaterThan(150);
    expect(seen.grouped).toBeGreaterThan(150);
    expect(seen.figure).toBeGreaterThan(80);
    expect(seen.noFigure).toBeGreaterThan(20);
    expect(seen.nothing).toBeGreaterThan(10);
  });

  it("the grouped paper and the detailed paper of one line add up to the same cents", () => {
    for (let n = 0; n < 200; n++) {
      const d = coerceTaskDetail(JSON.parse(JSON.stringify(generated())))!;
      const unit = taskMoney(d).total;
      const [a, b] = (["detailed", "grouped"] as EstimateFormat[]).map((f) => paperBreakdown(line(d, unit), f));
      if (a && b) expect(bulletCents(b)).toBe(bulletCents(a));
      // Grouped never prints where detailed would not; it may print nothing where detailed prints only
      // unpriced names (no figure, no labor hours).
      if (b) expect(a).not.toBeNull();
    }
  });
});
