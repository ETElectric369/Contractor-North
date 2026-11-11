import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QuoteDocument, type QuoteDocItem } from "@/components/quote-document";
import { ESTIMATE_FORMATS, type EstimateFormat } from "@/lib/doc-style";
import { formatCurrency } from "@/lib/utils";

/**
 * ONE ESTIMATE, THREE PAPERS (cn-v1158, 0408). Erik, 2026-11-10: "on the estimate we now have a [show]
 * labor and materials on estimate and its either all the materials listed out or none and i think we
 * should have an option to list out all the materials shown as it is now and an option to group the
 * materials into one materials line as im finding that different people require different solutions."
 * His call: ONE "Materials" line UNDER EACH TASK, never one for the whole estimate.
 *
 * So the same estimate is rendered here as "tasks", "detailed" and "grouped", through the one renderer
 * every paper uses (the print page, the PDF, the studio's sample and the customer's /q page), and the
 * table below says what each line prints under each. What the three may differ in is the bullets
 * under a task and nothing else: the Qty, the unit price, the line totals and the document's totals
 * are the same paper to the cent, because the format is only read — it never changes a price.
 */

const row = (hours: number | null, rate: number, label: string | null = null) => ({ label, person_id: label ? null : "person-uuid-1", hours, rate, rate_from: "rule" });
/** A part as the OFFICE's row holds it: with the book's code and the company's cost, which no paper prints. */
const part = (name: string, qty: number | null, sell: number | null, code: string | null = null) => ({ code, name, qty, cost: sell === null ? null : 1.11, sell });
const task = (labor: ReturnType<typeof row>[], materials: ReturnType<typeof part>[] = []) => ({ task_id: "task-uuid-1", labor, units: null, kit_id: null, materials });

type Detail = ReturnType<typeof task>;
type Line = {
  /** What this line is in the table for. */
  why: string;
  item: QuoteDocItem & { detail?: Detail };
  /** Does the breakdown still explain the unit price (so bullets print under detailed and grouped)? */
  explained: boolean;
  /** Every bullet in the line's cell, per format — a note under the line first, then the breakdown. */
  bullets: Record<EstimateFormat, string[]>;
};

const item = (id: string, description: string, quantity: number, unit: string, unit_price: number, detail?: Detail): Line["item"] => ({
  id,
  description,
  quantity,
  unit,
  unit_price,
  line_total: Math.round(quantity * unit_price * 100) / 100,
  ...(detail ? { detail } : {}),
});

/** 4 h × $125 + a helper's 4 h × $85 + two breakers at $20 = $880 for one of the task. */
const PANEL = task([row(4, 125), row(4, 85, "Helper")], [part("Tandem breaker, 20A", 2, 20, "ZQ-TB20")]);

const ESTIMATE: Line[] = [
  {
    why: "Qty 1: two labor rows and a part",
    item: item("l1", "Panel work: two tandem breakers, labeling, torque check", 1, "ea", 880, PANEL),
    explained: true,
    bullets: {
      tasks: [],
      detailed: ["Labor · 4 h × $125.00 = $500.00", "Helper · 4 h × $85.00 = $340.00", "Tandem breaker, 20A × 2 · $40.00"],
      grouped: ["Labor · 4 h × $125.00 = $500.00", "Helper · 4 h × $85.00 = $340.00", "Materials · $40.00"],
    },
  },
  {
    // 0.91 + 4.98 + 0.50 + 3.99 = $10.38 as printed. The raw products (0.91 + 4.975 + 0.495 + 3.99)
    // rounded once say $10.37, a cent the customer could not find on the paper.
    why: "Qty 2: 'For each one:', and a part 2.5 × $1.99 that counts as $4.98 inside the Materials figure",
    item: item(
      "l2",
      "Hang and wire a ceiling fan",
      2,
      "ea",
      210.38,
      task([row(2, 100)], [part("Wire nut", 7, 0.13, "ZQ-WN"), part("Strap", 2.5, 1.99), part("Tape", 1.5, 0.33), part("Anchor", 3, 1.33)]),
    ),
    explained: true,
    bullets: {
      tasks: [],
      detailed: ["Labor · 2 h × $100.00 = $200.00", "Wire nut × 7 · $0.91", "Strap × 2.5 · $4.98", "Tape × 1.5 · $0.50", "Anchor × 3 · $3.99"],
      grouped: ["Labor · 2 h × $100.00 = $200.00", "Materials · $10.38"],
    },
  },
  {
    why: "a task with no parts: no Materials bullet",
    item: item("l3", "Trace and label every circuit", 1, "ea", 435, task([row(3, 145)])),
    explained: true,
    bullets: { tasks: [], detailed: ["Labor · 3 h × $145.00 = $435.00"], grouped: ["Labor · 3 h × $145.00 = $435.00"] },
  },
  {
    why: "a task whose parts are all unpriced: no Materials bullet, never $0.00",
    item: item("l4", "Mount the fixture the owner bought", 1, "ea", 135, task([row(1.5, 90)], [part("Fixture, supplied by owner", 1, null), part("Mounting block", null, 12)])),
    explained: true,
    bullets: {
      tasks: [],
      detailed: ["Labor · 1.5 h × $90.00 = $135.00", "Fixture, supplied by owner × 1", "Mounting block"],
      grouped: ["Labor · 1.5 h × $90.00 = $135.00"],
    },
  },
  {
    why: "a unit price edited by hand ($900 over an $880 breakdown): no breakdown under either format",
    item: item("l5", "Service call", 1, "ea", 900, PANEL),
    explained: false,
    bullets: { tasks: [], detailed: [], grouped: [] },
  },
  {
    why: "a line he typed (no task behind it): the same under all three",
    item: item("l6", "Under-cabinet lighting run, kitchen", 1, "lot", 640),
    explained: false,
    bullets: { tasks: [], detailed: [], grouped: [] },
  },
  {
    why: "Qty 3, parts and no labor: the Materials bullet alone under the sub-heading",
    item: item("l7", "Smoke alarm, hardwired", 3, "ea", 38.5, task([], [part("Smoke alarm, 10-year", 1, 38.5, "ZQ-SA10")])),
    explained: true,
    bullets: { tasks: [], detailed: ["Smoke alarm, 10-year × 1 · $38.50"], grouped: ["Materials · $38.50"] },
  },
  {
    why: "a note under the line stays a bullet of its own, above the breakdown, under every format",
    item: item(
      "l8",
      "Bath fan replacement\nDuct to the existing roof jack",
      1,
      "ea",
      251.4,
      task([row(1.25, 120)], [part("Bath fan, 80 CFM", 1, 96.4, "ZQ-BF80"), part("Foil tape", 0.5, 9.99)]),
    ),
    explained: true,
    bullets: {
      tasks: ["Duct to the existing roof jack"],
      detailed: ["Duct to the existing roof jack", "Labor · 1.25 h × $120.00 = $150.00", "Bath fan, 80 CFM × 1 · $96.40", "Foil tape × 0.5 · $5.00"],
      grouped: ["Duct to the existing roof jack", "Labor · 1.25 h × $120.00 = $150.00", "Materials · $101.40"],
    },
  },
];

const ITEMS = ESTIMATE.map((l) => l.item);
/** Every part on the estimate, by name (the breaker is behind two lines: once is enough). */
const PART_NAMES = [...new Set(ITEMS.flatMap((it) => it.detail?.materials.map((m) => m.name) ?? []))];
const SECRETS = ["ZQ-", "person-uuid-1", "task-uuid-1", "1.11"];
const cents = (n: number | null | undefined): number => Math.round((n ?? 0) * 100);

// The document's own totals, as the estimate's row would hold them: the lines, 7.25% tax, the sum.
const SUBTOTAL = ITEMS.reduce((t, it) => t + cents(it.line_total), 0) / 100;
const TAX = Math.round(cents(SUBTOTAL) * 0.0725) / 100;
const TOTAL = (cents(SUBTOTAL) + cents(TAX)) / 100;

const paper = (items: QuoteDocItem[], estimateFormat: EstimateFormat): string =>
  renderToStaticMarkup(
    createElement(QuoteDocument, {
      co: { name: "Main Street Builders", brand: "#0f766e" },
      template: "classic",
      docLabel: "Estimate",
      number: "E-021",
      createdAt: "2026-11-10",
      customer: { name: "Sam Tillery" },
      items,
      subtotal: SUBTOTAL,
      taxRate: 0.0725,
      tax: TAX,
      total: TOTAL,
      estimateFormat,
    }),
  );

const plain = (html: string): string => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'");

/** The line-item table, row by row: the bullets in the description cell, whether the sub-heading
 *  stands over them, and the four figures beside it exactly as printed. */
function rows(html: string) {
  const body = html.slice(html.indexOf("<tbody>") + "<tbody>".length, html.indexOf("</tbody>"));
  return [...body.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map(([, tr]) => {
    const [cell, qty, unit, price, amount] = [...tr.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map(([, td]) => td);
    return {
      bullets: [...cell.matchAll(/<li>(.*?)<\/li>/gs)].map(([, li]) => plain(li)),
      each: cell.includes("For each one:"),
      figures: [qty, unit, price, amount].map(plain),
    };
  });
}

/** The document's totals block as printed: Subtotal, Tax, Total. */
const totals = (html: string): string[] => {
  const m = /Subtotal(\$[\d,]+\.\d\d)Tax \(7\.25%\)(\$[\d,]+\.\d\d)Total(\$[\d,]+\.\d\d)/.exec(plain(html));
  return m ? m.slice(1) : [];
};

/** The money a bullet carries, in cents: its LAST dollar figure ("Labor · 4 h × $125.00 = $500.00" is
 *  $500.00). A bullet with none — a part nobody priced, a note — adds nothing. */
const bulletCents = (bullet: string): number => {
  const all = [...bullet.matchAll(/\$([\d,]+\.\d\d)/g)];
  return all.length ? cents(Number(all[all.length - 1][1].replace(/,/g, ""))) : 0;
};

/**
 * WHAT public_quote SHIPS FOR ONE LINE (0395's keys; the "grouped" arm since 0408): no id, and a
 * detail with no cost, code, task id, kit id or person. Under "tasks" no detail at all; under
 * "detailed" each part's name, count and sell; under "grouped" NO parts and `materials_total` in their
 * place — each part rounded to cents and then added, null when none is priced. Written in whole cents,
 * not through the app's own arithmetic: the server's sum and the paper's must agree on their own.
 */
function shipped(it: Line["item"], format: EstimateFormat): QuoteDocItem {
  const { id: _id, detail, ...line } = it;
  if (!detail || format === "tasks") return line;
  const head = { hours: null, rate: null, units: detail.units, labor: detail.labor.map(({ label, hours, rate }) => ({ label, hours, rate })) };
  if (format === "detailed") return { ...line, detail: { ...head, materials: detail.materials.map(({ name, qty, sell }) => ({ name, qty, sell })) } };
  const total = detail.materials.reduce((t, m) => t + Math.round((cents(m.qty) * cents(m.sell)) / 100), 0);
  return { ...line, detail: { ...head, materials: [], materials_total: total > 0 ? total / 100 : null } };
}

describe("one estimate under the three formats: the same paper, different bullets", () => {
  const html = Object.fromEntries(ESTIMATE_FORMATS.map((f) => [f, paper(ITEMS, f)])) as Record<EstimateFormat, string>;
  const table = Object.fromEntries(ESTIMATE_FORMATS.map((f) => [f, rows(html[f])])) as Record<EstimateFormat, ReturnType<typeof rows>>;

  it("the table is the whole estimate: one printed row per line, under every format", () => {
    expect([...ESTIMATE_FORMATS]).toEqual(["tasks", "detailed", "grouped"]);
    for (const f of ESTIMATE_FORMATS) expect(table[f]).toHaveLength(ESTIMATE.length);
  });

  it("the same Qty, unit, unit price and line total on every line, under every format", () => {
    const expected = ITEMS.map((it) => [String(it.quantity), it.unit, formatCurrency(it.unit_price), formatCurrency(it.line_total)]);
    expect(expected[1]).toEqual(["2", "ea", "$210.38", "$420.76"]);
    for (const f of ESTIMATE_FORMATS) expect(table[f].map((r) => r.figures), f).toEqual(expected);
  });

  it("the same document totals, under every format", () => {
    expect([SUBTOTAL, TAX, TOTAL]).toEqual([3777.66, 273.88, 4051.54]);
    for (const f of ESTIMATE_FORMATS) expect(totals(html[f]), f).toEqual(["$3,777.66", "$273.88", "$4,051.54"]);
  });

  it.each(ESTIMATE.map((l, i) => [l.why, l, i] as const))("%s", (_why, l, i) => {
    for (const f of ESTIMATE_FORMATS) expect(table[f][i].bullets, f).toEqual(l.bullets[f]);
  });

  it("under detailed and grouped the bullets of each task add up to its UNIT price, to the cent — parsed off the paper", () => {
    for (const f of ["detailed", "grouped"] as const) {
      ESTIMATE.forEach((l, i) => {
        const money = table[f][i].bullets.filter((b) => b.includes("$"));
        expect(money.length > 0, `${f}: ${l.why}`).toBe(l.explained);
        if (l.explained) expect(money.reduce((t, b) => t + bulletCents(b), 0), `${f}: ${l.why}`).toBe(cents(l.item.unit_price));
      });
    }
    // And "tasks" prints no figure under any line.
    for (const r of table.tasks) expect(r.bullets.filter((b) => b.includes("$"))).toEqual([]);
  });

  it("'For each one:' stands over the bullets only where the Qty is not 1 and a breakdown prints; never under tasks", () => {
    const expected = ESTIMATE.map((l) => l.explained && l.item.quantity !== 1);
    expect(expected).toEqual([false, true, false, false, false, false, true, false]);
    expect(table.detailed.map((r) => r.each)).toEqual(expected);
    expect(table.grouped.map((r) => r.each)).toEqual(expected);
    expect(table.tasks.map((r) => r.each)).toEqual(ESTIMATE.map(() => false));
    expect(plain(html.tasks)).not.toContain("For each one:");
  });

  it("grouped: ONE Materials bullet under each task that has priced parts, none where it has not — and never '$0.00'", () => {
    const count = (f: EstimateFormat) => table[f].map((r) => r.bullets.filter((b) => b.startsWith("Materials · ")).length);
    expect(count("grouped")).toEqual([1, 1, 0, 0, 0, 0, 1, 1]);
    expect(count("detailed")).toEqual(ESTIMATE.map(() => 0));
    expect(count("tasks")).toEqual(ESTIMATE.map(() => 0));
    expect(plain(html.grouped)).not.toContain("Materials · $0.00");
    // The Materials bullet is the LAST one under its task, after the labor.
    for (const r of table.grouped) {
      const at = r.bullets.findIndex((b) => b.startsWith("Materials · "));
      if (at >= 0) expect(at).toBe(r.bullets.length - 1);
    }
    // The fan's figure holds the part that rounds up: 2.5 × $1.99 is $4.98 on the detailed paper, and
    // the same cent is inside the one line here ($10.38, not the once-rounded $10.37).
    expect(table.detailed[1].bullets).toContain("Strap × 2.5 · $4.98");
    expect(table.grouped[1].bullets).toContain("Materials · $10.38");
    // The same part alone, where the float product (4.97499…) would have printed $4.97 on one paper
    // and left the other a cent short of its line.
    const strap = [item("s1", "Strap the conduit run", 1, "ea", 4.98, task([], [part("Strap", 2.5, 1.99)]))];
    expect(rows(paper(strap, "detailed"))[0].bullets).toEqual(["Strap × 2.5 · $4.98"]);
    expect(rows(paper(strap, "grouped"))[0].bullets).toEqual(["Materials · $4.98"]);
    expect(rows(paper([shipped(strap[0], "grouped")], "grouped"))[0].bullets).toEqual(["Materials · $4.98"]);
  });

  it("detailed names every part; grouped and tasks name none", () => {
    expect(PART_NAMES).toHaveLength(10);
    for (const name of PART_NAMES) {
      expect(plain(html.detailed), name).toContain(name);
      expect(plain(html.grouped), name).not.toContain(name);
      expect(plain(html.tasks), name).not.toContain(name);
    }
  });

  it("no paper prints what the office keeps: a book code, a cost, the task's id or a person's", () => {
    for (const f of ESTIMATE_FORMATS) for (const secret of SECRETS) expect(html[f], `${f} ${secret}`).not.toContain(secret);
  });
});

describe("the same task at Qty 1 and at Qty 2", () => {
  const one = ESTIMATE[0].item;
  const two = { ...one, quantity: 2, line_total: 1760 };

  it("the bullets are for ONE of the task either way; 'For each one:' appears only at Qty 2", () => {
    for (const f of ["detailed", "grouped"] as const) {
      const [a] = rows(paper([one], f));
      const [b] = rows(paper([two], f));
      expect(a.each, f).toBe(false);
      expect(b.each, f).toBe(true);
      expect(b.bullets, f).toEqual(a.bullets);
      expect(b.bullets, f).toEqual(ESTIMATE[0].bullets[f]);
      expect(b.figures, f).toEqual(["2", "ea", "$880.00", "$1,760.00"]);
      // The sub-heading stands above the first bullet, once.
      const text = plain(paper([two], f));
      expect(text.split("For each one:")).toHaveLength(2);
      expect(text.indexOf("For each one:")).toBeLessThan(text.indexOf("Labor · 4 h"));
      expect(text).not.toMatch(/\$[\d,.]+ each/);
    }
    expect(plain(paper([two], "tasks"))).not.toContain("For each one:");
  });
});

describe("a line he typed, and a price he set by hand", () => {
  it("a hand-typed line (no task behind it) is the same paper under all three", () => {
    const typed = [ESTIMATE[5].item];
    expect(paper(typed, "detailed")).toBe(paper(typed, "tasks"));
    expect(paper(typed, "grouped")).toBe(paper(typed, "tasks"));
  });

  it("a hand-edited unit price prints no breakdown under either format: the line alone, as under tasks", () => {
    for (const qty of [1, 2]) {
      const hand = [{ ...ESTIMATE[4].item, quantity: qty, line_total: 900 * qty }];
      expect(paper(hand, "detailed")).toBe(paper(hand, "tasks"));
      expect(paper(hand, "grouped")).toBe(paper(hand, "tasks"));
      expect(paper(hand, "grouped")).not.toContain("<li>");
    }
  });
});

describe("the customer's page: what public_quote ships prints what the office's paper prints", () => {
  it.each(ESTIMATE_FORMATS)("%s: the wire's lines render the same HTML as the office's rows, byte for byte", (f) => {
    expect(paper(ITEMS.map((it) => shipped(it, f)), f)).toBe(paper(ITEMS, f));
  });

  it("grouped on the wire carries no part at all — only the one figure — and prints the same bullets", () => {
    const wire = ITEMS.map((it) => shipped(it, "grouped"));
    expect(wire[0].detail).toEqual({
      hours: null,
      rate: null,
      units: null,
      labor: [{ label: null, hours: 4, rate: 125 }, { label: "Helper", hours: 4, rate: 85 }],
      materials: [],
      materials_total: 40,
    });
    expect((wire[1].detail as { materials_total: number }).materials_total).toBe(10.38);
    expect((wire[3].detail as { materials_total: number | null }).materials_total).toBeNull(); // nothing priced: no figure
    const sent = JSON.stringify(wire);
    for (const name of PART_NAMES) expect(sent, name).not.toContain(name);
    expect(rows(paper(wire, "grouped")).map((r) => r.bullets)).toEqual(ESTIMATE.map((l) => l.bullets.grouped));
  });

  it("a wire detail whose materials_total does not add up prints nothing: the line alone", () => {
    const good = shipped({ ...ESTIMATE[0].item, quantity: 2, line_total: 1760 }, "grouped");
    expect(rows(paper([good], "grouped"))[0]).toMatchObject({ each: true, bullets: ESTIMATE[0].bullets.grouped });
    for (const wrong of [40.01, 39.99, 0, null, 400]) {
      const bad = { ...good, detail: { ...(good.detail as object), materials_total: wrong } };
      const [r] = rows(paper([bad], "grouped"));
      expect(r.bullets, String(wrong)).toEqual([]);
      expect(r.each, String(wrong)).toBe(false);
      expect(r.figures).toEqual(["2", "ea", "$880.00", "$1,760.00"]); // the price is not the format's to change
      expect(paper([bad], "grouped")).toBe(paper([bad], "tasks"));
    }
  });

  it("no part NAME can appear under grouped from either shape — not even from a wire that carried the parts", () => {
    const office = plain(paper(ITEMS, "grouped"));
    const wire = plain(paper(ITEMS.map((it) => shipped(it, "grouped")), "grouped"));
    // The detailed arm's payload (names and all) arriving under the grouped word: still one figure.
    const leaky = ITEMS.map((it) => shipped(it, "detailed"));
    const leaked = paper(leaky, "grouped");
    for (const name of PART_NAMES) {
      expect(office, name).not.toContain(name);
      expect(wire, name).not.toContain(name);
      expect(plain(leaked), name).not.toContain(name);
    }
    expect(rows(leaked).map((r) => r.bullets)).toEqual(ESTIMATE.map((l) => l.bullets.grouped));
  });

  it("the wire's figure is read under grouped alone: the same payload under detailed prints no sum it has no parts for", () => {
    const wire = [shipped(ESTIMATE[0].item, "grouped")];
    const text = plain(paper(wire, "detailed"));
    expect(text).not.toContain("Materials");
    expect(text).not.toContain(" h × "); // $840 of labor bullets under an $880 line would not add up
  });
});
