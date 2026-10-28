import type { DraftLineItem, TaskDetail, TaskDetailMaterial, TaskLabor } from "./line-map";
import type { TaskMaterial, TaskValue } from "@/lib/playbook/tasks";
import { describeChoice, priceBookLine, type BookPricing, type OptionedPriceItem } from "@/lib/pricing/item-options";
import { kitLineView, type KitLineRaw, type KitPricing } from "@/lib/kit-line";
import { joinLineNote, splitLineNote } from "./line-note";

/**
 * A TASK BECOMES ONE LINE ON THE ESTIMATE.
 *
 * Erik (2026-10-09): "each task carries its own labor and materials and is really how we ultimately
 * have to separate it to estimate it properly." So the estimate is ONE LINE PER TASK: the task's
 * name is the description, and its price is HIS hours × the labor rate plus his parts at the book's
 * cost through THE markup rule. The breakdown rides the line as `detail` (0386), so the document
 * can print labor and parts beneath the task when the company's format says so, and the builder can
 * re-price the line when he types the hours.
 *
 * ── ONE OR MORE LABOR ROWS (cn-v1131) ───────────────────────────────────────────────────────
 *
 * A task used to hold ONE hours figure at ONE rate. Two people at two rates could not be on it, and
 * the owner's own hour quoted at the Settings default while his Team rate billed it. Now a task holds
 * `labor: TaskLabor[]` — one row per rate (a person, or a label in his words, hours, the rate it was
 * priced at, and whose figure that rate is). The line's labor money is the rows' sum. The pre-1131
 * shape {hours, rate, hours_from_kit} is READ by coerceTaskDetail into one "legacy" row and never
 * written again, so nothing stored needs a data step.
 *
 * ── NO SPECULATION ([[no-speculation]]) ──────────────────────────────────────────────────────
 *
 * A row without hours prices at $0 and carries the flag "hours?". A part without a count prices at
 * $0 and asks "how many?". A part the book cannot price (his words only, or a code the book no
 * longer carries) prices at $0 and asks "price?". Nothing here ever fills a hole with a typical
 * figure: the line is a zero that ASKS, never a number that looks right.
 *
 * ── THE QTY BOX IS "THIS MANY OF THE TASK" (cn-v1133) ───────────────────────────────────────
 *
 * The breakdown is PER UNIT: lineFromDetail writes its total as the line's unit_price, and the Qty
 * box multiplies it on the paper (line_total = qty × unit_price). So the breakdown explains the line
 * while it equals the UNIT price (detailExplains), and the job reads the same multiplier: a task at
 * qty 2 is twice the minutes and twice each part (taskMinutesFor, born-with-tasks). A kit's `units`
 * is a DIFFERENT multiplier, already inside the breakdown (expandTaskKit): qty 2 of a ×7 kit is 14.
 *
 * Pure. The page that calls it has already resolved the rate (laborRateFor) and the customer's
 * markup; the same function serves the inspection seed, the estimator's task mode and the builder.
 */

/** A price-book row as the seed selects it, keyed by code. */
export type TaskBookRow = OptionedPriceItem & { code: string };

/** A kit that is a TASK PER UNIT (0386: kits.labor_minutes + kits.unit), with its lines. */
export interface TaskKit {
  id: string;
  name: string;
  /** His labor minutes for ONE unit. Null = an ordinary parts kit (no hours of its own). */
  labor_minutes: number | null;
  unit: string | null;
  /** The scope it is filed under (kits.category, Price List › Kits): "Deck" lights "Add The Deck
   *  Tasks" on a visit whose scope says deck (lib/playbook/scope). Null = offered by name only. */
  category?: string | null;
  items: KitLineRaw[];
}

export interface TaskLineContext {
  /** The org's price book by code (as stored; an UPPERCASE lookup is tried second). */
  book: Map<string, TaskBookRow>;
  /** The labor rate for this customer, already resolved by laborRateFor. 0 = none set. */
  rate: number;
  /** Whose figure `rate` is on the row it seeds: laborRateFor's answer ("rule", the default), or
   *  one he DICTATED in the scope ("stated" — the estimator's task mode). A stated rate stands
   *  when the rule's answer changes; a rule rate follows it (repriceTaskLine). */
  rateFrom?: "rule" | "stated";
  /** The customer's level markup (null = none) and the org default, for the parts. */
  pricing: BookPricing;
  /** Task kits by id, when the caller loaded them. Absent = a task's kit_id prices nothing extra. */
  kits?: Map<string, TaskKit>;
  /** The collapsible group the lines land under (the playbook question's label, like scopes). */
  group?: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const positive = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? round2(n) : null;
};
const nonNegative = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n >= 0 ? round2(n) : null;
};
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

const RATE_FROM: ReadonlySet<string> = new Set(["rule", "hand", "stated", "legacy"]);

/** The longest label a labor row carries ("Helper", "2-man crew"). */
export const MAX_LABOR_LABEL = 80;
/** The most labor rows a task carries (the playbook caps a task's parts the same way, MAX_TASK_MATERIALS):
 *  a hand edit of the JSON, or a runaway Add Labor, never grows a line past what a screen can hold. */
export const MAX_LABOR_ROWS = 20;

/** A random id for a task the builder starts from a line (no Inspector task behind it). */
function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** ONE LABOR ROW, READ BACK (the stored shape, the builder's edit, or the public page's redacted
 *  {label, hours, rate}). Nothing here crashes a document: a junk field reads as the hole it is. */
function coerceLaborRow(raw: unknown): TaskLabor | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const x = raw as Record<string, unknown>;
  const from = typeof x.rate_from === "string" && RATE_FROM.has(x.rate_from) ? (x.rate_from as TaskLabor["rate_from"]) : "legacy";
  return {
    label: str(x.label, MAX_LABOR_LABEL) || null,
    person_id: typeof x.person_id === "string" && x.person_id.trim() ? x.person_id.trim() : null,
    hours: positive(x.hours),
    rate: nonNegative(x.rate) ?? 0,
    rate_from: from,
    ...(x.from_kit === true ? { from_kit: true as const } : {}),
  };
}

/**
 * READ A STORED BREAKDOWN BACK. Tolerant: the public page receives the REDACTED shape (no task_id,
 * no kit_id, no cost — public_quote strips them), an older row may carry nothing at all, and a hand
 * edit of the JSON must never crash a document. Null when it is not a breakdown.
 *
 * TWO SHAPES, ONE READER (cn-v1131). A row with a `labor` array is the new shape, row by row. A row
 * without one — every line saved before cn-v1131 — is the old {hours, rate, hours_from_kit}, read as
 * ONE "legacy" row so it prices exactly as it did (20 h × $145 is still 20 × 145). The public wire
 * ships BOTH sets of keys (0395 keeps hours/rate beside the labor array so an old line still reads
 * on the customer's page): an EMPTY labor array beside a legacy hours or rate is the old shape, not
 * an empty new one. A new-shape row with no rows at all stays that way — it prices nothing and asks.
 */
export function coerceTaskDetail(raw: unknown): TaskDetail | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const materials: TaskDetailMaterial[] = [];
  for (const m of Array.isArray(o.materials) ? (o.materials as unknown[]) : []) {
    if (!m || typeof m !== "object") continue;
    const x = m as Record<string, unknown>;
    const code = str(x.code, 64) || null;
    const name = str(x.name, 300) || str(x.words, 300) || code || "";
    if (!name) continue;
    materials.push({
      code,
      name,
      qty: positive(x.qty),
      cost: nonNegative(x.cost),
      sell: nonNegative(x.sell),
      ...(x.from_kit === true ? { from_kit: true as const } : {}),
    });
  }
  const rows = Array.isArray(o.labor) ? (o.labor as unknown[]) : null;
  const legacyFigure = num(o.hours) !== null || (o.rate !== undefined && o.rate !== null);
  let labor: TaskLabor[];
  if (rows && (rows.length > 0 || !legacyFigure)) {
    labor = rows.map(coerceLaborRow).filter((r): r is TaskLabor => r !== null).slice(0, MAX_LABOR_ROWS);
  } else {
    const hours = positive(o.hours);
    labor = [
      {
        label: null,
        person_id: null,
        hours,
        rate: nonNegative(o.rate) ?? 0,
        rate_from: "legacy",
        ...(hours !== null && o.hours_from_kit === true ? { from_kit: true as const } : {}),
      },
    ];
  }
  return {
    task_id: str(o.task_id, 80),
    labor,
    units: positive(o.units),
    kit_id: str(o.kit_id, 64) || null,
    materials,
  };
}

/**
 * A LINE READ BACK FROM A STORED DRAFT — the session draft the builder restores, the draft row the
 * page adopts. The breakdown comes through coerceTaskDetail (so a line saved by an older build, the
 * one-figure {hours, rate} shape with no `labor` rows, is one legacy row and not a TypeError at the
 * first `labor.map`), and the flag is rebuilt from it: the flag is build-time only, so an adopted
 * "hours?" line still says so instead of reading as a $0 somebody chose. A line with no breakdown
 * (none, or junk that is not one) keeps its words, its numbers and whatever flag it carried.
 */
export function coerceDraftLine<T extends DraftLineItem>(line: T): T {
  const d = line.detail ? coerceTaskDetail(line.detail) : null;
  return { ...line, detail: d ?? undefined, ...(d ? { flag: taskFlags(d) } : {}) };
}

/** A line's task name without the units it carries ("Footings ×7" → "Footings") — the HEAD alone:
 *  a note under the line (line-note) is never part of the name. */
export function stripUnits(description: string): string {
  return splitLineNote(description).head.replace(/\s*×\s*\d+(?:[.,]\d+)?\s*$/u, "").trim();
}

/** The suffix a count writes on a line's name: " ×N" when N is not one (taskLine's rule). */
const unitsSuffix = (units: number | null): string => (units !== null && units !== 1 ? ` ×${units}` : "");

/** The line's name for another count: ONLY the suffix the previous count wrote is replaced, so a
 *  name that ends in his own "4×4" (or one he edited by hand) is never rewritten under him. The
 *  count lands on the HEAD; a note under the line rides along untouched (skeptic #43, S6: it used
 *  to land after the note). */
export function lineNameWithUnits(description: string, prevUnits: number | null, units: number | null): string {
  const { head, note } = splitLineNote(description);
  const prev = unitsSuffix(prevUnits);
  const base = prev && head.endsWith(prev) ? head.slice(0, -prev.length) : head;
  return joinLineNote(`${base}${unitsSuffix(units)}`, note);
}

/** A part the builder added and nobody named yet is not a part: it prices nothing and asks nothing
 *  (coerceTaskDetail drops it on save, so what the screen sums is what the row will hold). */
const named = (m: TaskDetailMaterial): boolean => m.name.trim().length > 0;

/** One labor row with its figures rounded the one way (hours 2 dp, rate 2 dp, never negative). */
const normalizeLabor = (r: TaskLabor): TaskLabor => ({ ...r, hours: positive(r.hours), rate: nonNegative(r.rate) ?? 0 });

/**
 * THE SAME NUMBERS THE SAVE WILL KEEP. coerceTaskDetail rounds to cents on the way back in; if the
 * builder priced raw "1.333" hours the reloaded breakdown would no longer explain the line and the
 * paper would drop it as "set by hand". So every edit is rounded here first, the one way — every row.
 */
export function normalizeTaskDetail(d: TaskDetail): TaskDetail {
  return {
    ...d,
    labor: d.labor.map(normalizeLabor),
    units: positive(d.units),
    materials: d.materials.map((m) => ({ ...m, qty: positive(m.qty), cost: nonNegative(m.cost), sell: nonNegative(m.sell) })),
  };
}

/** ONE PART'S MONEY, IN CENTS — the figure the paper prints beside it (item 4, 2026-10-10). A count can
 *  carry two decimals and a price two, so the raw product can carry four; rounding each part first and
 *  summing those is what makes the bullets the customer adds up equal the line to the cent. Every
 *  surface that shows a part's money (the document, the builder, the sum) goes through here. */
export function partMoney(m: Pick<TaskDetailMaterial, "qty" | "sell">): number {
  // Both carry at most two decimals (normalizeTaskDetail), so whole cents make this EXACT decimal
  // arithmetic: 2.5 × $1.99 = $4.975 → $4.98, where the float product (4.97499…) rounds down to $4.97.
  const q = Math.round((m.qty ?? 0) * 100);
  const s = Math.round((m.sell ?? 0) * 100);
  return Math.round((q * s) / 100) / 100;
}

/** ONE LABOR ROW'S MONEY, IN CENTS — the figure the paper prints beside it: hours × rate, rounded as
 *  printed. A row without hours is nothing (it asks). The line's labor is the sum of these, so the
 *  rows the customer adds up equal the line to the cent, the same rule as the parts. */
export function laborMoney(r: Pick<TaskLabor, "hours" | "rate">): number {
  return r.hours === null ? 0 : round2(r.hours * r.rate);
}

/** The arithmetic behind a task line, in cents: labor = Σ laborMoney (each row rounded as printed,
 *  then summed), parts = Σ partMoney the same way — never the raw products summed and rounded once. */
export function taskMoney(d: TaskDetail): { labor: number; parts: number; total: number } {
  const labor = round2(d.labor.reduce((t, r) => t + laborMoney(r), 0));
  const parts = round2(d.materials.filter(named).reduce((t, m) => t + partMoney(m), 0));
  return { labor, parts, total: round2(labor + parts) };
}

/** What a row is called when a flag has to name it among others: his label, else "labor". (A row
 *  that names a person carries no name here — the breakdown screen prints the person; the flag
 *  does not reach into the Team list.) */
const rowWord = (r: TaskLabor): string => r.label?.trim() || "labor";

/**
 * WHAT THE LINE IS STILL ASKING. Build-time only (DraftLineItem.flag): the office reads it in the
 * builder; the customer never does. Each hole is named, so a $0 is never mistaken for a price.
 */
export function taskFlags(d: TaskDetail): string | undefined {
  const flags: string[] = [];
  // A KIT WITH NO COUNT (audit v1085, carried [5]; field feedback 10-13): the kit carries the hours
  // and parts PER UNIT, so the one thing the line asks is the count — "units?" — and until it is
  // given the line prices nothing (buildTaskDetail seeds it asking). Typing 1 answers it. The kit's
  // hours land on the FIRST row, so that row's hole is the count's, not its own.
  const uncounted = !!d.kit_id && d.units === null;
  const several = d.labor.length > 1;
  let noRate = false;
  if (d.labor.length === 0 && !uncounted) flags.push("hours?");
  d.labor.forEach((r, i) => {
    if (r.hours === null) {
      if (!(uncounted && i === 0)) flags.push(several ? `hours? ${rowWord(r)}` : "hours?");
    } else if (r.rate <= 0) noRate = true;
  });
  if (noRate) flags.push("no labor rate set");
  if (uncounted) flags.push("units?");
  for (const m of d.materials.filter(named)) {
    // A kit part with no count is the same one question ("units?"), not one per part.
    if (m.qty === null && !(uncounted && m.from_kit)) flags.push(`how many? ${m.name}`);
    // A coded part the book priced at $0 has a cost (0) and asks for a price; a code the book does
    // not carry has no cost at all and says so.
    if (m.sell === null) flags.push(m.code && m.cost === null ? `not in the price book: ${m.code}` : `price? ${m.name}`);
  }
  return flags.length ? flags.join(" · ") : undefined;
}

/**
 * DOES THE BREAKDOWN STILL EXPLAIN THE PRICE? A line's unit_price can be edited by hand on either
 * editor after it was built; the breakdown then describes a number the customer is not being
 * asked for. The document prints the breakdown only while it adds up to the line, so a stale one
 * disappears from the paper instead of contradicting it (nothing is deleted: the job still reads
 * the hours and parts from it). PER UNIT (cn-v1133): the breakdown is compared to the UNIT price
 * alone — the Qty box multiplies it on the paper, so a task at qty 2 still reads as explained.
 */
export function detailExplains(d: TaskDetail, line: { unit_price: number }): boolean {
  return Math.abs(taskMoney(d).total - round2(Number(line.unit_price) || 0)) < 0.005;
}

/** THE LINE'S COUNT — "this many of the task" (cn-v1133). A blank, a 0 or junk is one of it, never
 *  a zero that would empty the job's minutes and parts. The same reader for every job door. */
export function lineQty(line: { quantity?: unknown }): number {
  const n = Number(line.quantity);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** A kit line's count for `units` of the kit, through the kit's own minimum and rounding (0166). */
function kitQty(raw: number, item: KitLineRaw): number {
  const min = num(item.qty_min);
  const floored = min !== null && raw < min ? min : raw;
  const how = item.qty_round === "nearest" || item.qty_round === "none" ? item.qty_round : "up";
  if (how === "nearest") return Math.round(floored);
  if (how === "none") return round2(floored);
  return Math.ceil(Math.round(floored * 1e6) / 1e6);
}

/**
 * A TASK KIT, EXPANDED FOR THIS TASK: his minutes per unit × the units, and every kit line × the
 * units. ONE function, so the inspector's preview and the estimate's line can never disagree about
 * what "7 footings" costs. A kit line saved at quantity 0 is not part of the task (the kit author
 * zeroed it); a missing quantity is one of it.
 */
export function expandTaskKit(task: TaskValue, kit: TaskKit, pricing: KitPricing): { hours: number | null; materials: TaskDetailMaterial[] } {
  const units = task.units ?? 1;
  const minutes = num(kit.labor_minutes);
  const hours = minutes !== null && minutes > 0 ? round2((minutes / 60) * units) : null;
  const items = (kit.items ?? [])
    .map((it, i) => ({ it, i }))
    .sort((a, b) => (Number(a.it.sort_order) || 0) - (Number(b.it.sort_order) || 0) || a.i - b.i)
    .map(({ it }) => it);
  const materials: TaskDetailMaterial[] = [];
  for (const it of items) {
    const base = num(it.quantity);
    const each = base === null ? 1 : base;
    if (each <= 0) continue;
    const view = kitLineView(it, pricing);
    // The part's words without the code in front (a linked line reads "C80 — Concrete"): the code
    // rides in `code`, and the name may reach the customer's paper — never a book code (0387).
    // An UNLINKED line (the book row gone, or not readable by this viewer — a crew lead cannot read
    // price_list_items, audit v1085 carried [31]) keeps its frozen "C80 — Concrete": the lead is
    // dropped only on a line that WAS linked (price_list_item_id set — the words came from the book, so
    // what stands before the first " — " is its code, "RACO 936" and all), never on a hand-typed
    // "Rebar — #4".
    const lead = view.code ? `${view.code} — ` : "";
    const frozen = !view.code && it.price_list_item_id ? /^(.+?) — (.+)$/.exec(view.description) : null;
    const name = (lead && view.description.startsWith(lead) ? view.description.slice(lead.length) : frozen ? frozen[2] : view.description).trim();
    if (!name) continue;
    materials.push({
      code: view.code,
      name,
      qty: kitQty(each * units, it),
      cost: view.cost,
      // A $0 kit line is not a price, it is a line nobody priced: it asks ("price?").
      sell: view.unit_price > 0 ? round2(view.unit_price) : null,
    });
  }
  return { hours, materials };
}

/** One of HIS parts, priced from the book when it names a code the book carries. */
function materialDetail(m: TaskMaterial, ctx: TaskLineContext): TaskDetailMaterial {
  const row = m.code ? ctx.book.get(m.code) ?? ctx.book.get(m.code.toUpperCase()) : undefined;
  if (row) {
    // THE ONE PRICE (priceBookLine): the code's default vendor when the org made one, else the
    // item's own, through customer level → item markup → org default.
    const item = { ...row, description: String(row.description ?? "").trim() };
    const choice = priceBookLine(item, ctx.pricing);
    return {
      code: row.code,
      // The book's words with the vendor named when one was chosen (describeChoice) — never the
      // code in front: a customer reads "Transfer switch, 200A", not "R1 — Transfer switch, 200A".
      name: describeChoice(item.description, item, choice).trim() || m.words || row.code,
      qty: m.qty,
      cost: round2(choice.buyPrice),
      // A book code at $0 (an allowance nobody has filled in) is not a price: the part asks.
      sell: choice.unitPrice > 0 ? round2(choice.unitPrice) : null,
    };
  }
  // His words, or a code the book does not carry: named, counted if he counted it, unpriced.
  return { code: m.code, name: m.words || m.code || "", qty: m.qty, cost: null, sell: null };
}

/** The breakdown for one task: ONE labor row at the rate the caller resolved. HIS hours win over a
 *  kit's (fill holes, never overwrite a hand). */
export function buildTaskDetail(task: TaskValue, ctx: TaskLineContext): TaskDetail {
  const kit = task.kit_id ? ctx.kits?.get(task.kit_id) ?? null : null;
  const fromKit = kit ? expandTaskKit(task, kit, { orgDefaultPct: ctx.pricing.orgDefaultPct ?? 0, levelPct: ctx.pricing.levelPct }) : null;
  // A KIT TASK WITH NO COUNT IS ASKING ([[no-speculation]]): "Add The Deck Tasks" drops seven kit
  // tasks on a visit with no units on any of them; priced as one unit each they would be seven
  // dollar figures nobody gave. The kit's hours and parts are named and NOT counted until the
  // units are (the builder's units box re-derives them through reexpandTaskDetail). His own typed
  // hours still win.
  const uncounted = !!kit && task.units === null;
  const kitHours = task.hours === null && !uncounted && fromKit?.hours !== null && fromKit?.hours !== undefined;
  const row: TaskLabor = {
    label: null,
    person_id: null,
    hours: task.hours ?? (uncounted ? null : fromKit?.hours ?? null),
    rate: round2(Math.max(0, ctx.rate)),
    rate_from: ctx.rateFrom === "stated" ? "stated" : "rule",
    ...(kitHours ? { from_kit: true as const } : {}),
  };
  return {
    task_id: task.id,
    labor: [row],
    units: task.units,
    kit_id: kit ? kit.id : null,
    // The kit's parts are marked as the kit's, so a change of units re-derives them and leaves
    // his own alone (reexpandTaskDetail).
    materials: [
      ...(fromKit?.materials ?? []).map((m) => ({ ...m, ...(uncounted ? { qty: null } : {}), from_kit: true as const })),
      ...task.materials.map((m) => materialDetail(m, ctx)),
    ],
  };
}

/**
 * THE SAME TASK, FOR OTHER UNITS (W4, the builder's units box). The kit's own figures — the hours
 * it gave and the parts it put there — are derived again for the new count through THE one
 * expandTaskKit; his typed hours and every part he added or edited by hand stand as they are. With
 * no kit to expand, only the count changes (it rides the name).
 *
 * THE KIT'S HOURS LAND ON THE FIRST ROW (cn-v1131). A kit has one minutes figure, so it feeds one
 * row: the first. A first row he typed (no from_kit mark) stands, as his hours always have; every
 * other row is his and is not touched. A breakdown with no rows at all has nowhere for the kit's
 * hours to land — the line keeps asking ("hours?") rather than growing a row at a rate nobody gave.
 */
export const MAX_UNITS = 100_000;

/** A part's identity on the line: the code when it has one, else its words. */
const partKey = (m: { code: string | null; name: string }): string => (m.code ?? "").trim().toLowerCase() || m.name.trim().toLowerCase();

export function reexpandTaskDetail(d: TaskDetail, units: number | null, kit: TaskKit | null, pricing: KitPricing): TaskDetail {
  const raw = positive(units);
  const next = raw === null ? null : Math.min(raw, MAX_UNITS);
  if (!kit) return { ...d, units: next };
  const probe = (u: number | null): TaskValue => ({ id: d.task_id, name: "", hours: null, units: u, kit_id: kit.id, materials: [] });
  const fromKit = expandTaskKit(probe(next), kit, pricing);
  const first: TaskLabor | null = d.labor[0] ?? null;

  // A LINE SAVED BEFORE THE MARKS (cn-v1076), or one he has edited all over: nothing on it is
  // flagged. The kit's parts are then recognised only where they still read EXACTLY as the kit put
  // them for the old count (same code or words, same count), and its hours only when they equal
  // what the kit gave — anything else on such a line is his and stands.
  const legacy = !d.materials.some((m) => m.from_kit === true) && first?.from_kit !== true;
  const asWas = legacy ? expandTaskKit(probe(d.units), kit, pricing) : null;
  // A LINE SEEDED ASKING — the kit task named with no count and no hours (field-1014) — takes the
  // kit's hours with its first count: nothing on it was his to clear (audit v1120, class 1). A line
  // that had a count and whose hours he cleared stays the hole it is.
  const seededAsking = d.units === null && first !== null && first.hours === null;
  const kitHours = first !== null && (first.from_kit === true || seededAsking || (asWas !== null && first.hours !== null && first.hours === asWas.hours));
  const untouched = new Map<string, number[]>();
  for (const m of asWas?.materials ?? []) untouched.set(partKey(m), [...(untouched.get(partKey(m)) ?? []), m.qty ?? -1]);
  const stillTheKits = (m: TaskDetailMaterial): boolean => {
    const q = untouched.get(partKey(m));
    const at = q ? q.indexOf(m.qty ?? -1) : -1;
    if (at < 0) return false;
    q!.splice(at, 1);
    return true;
  };

  // THE KIT'S PARTS ARE REPLACED IN PLACE — never appended. A part he removed stays removed, a
  // part he edited by hand (the mark cleared) stays his and gets no twin, and a kit part keeps
  // the sell and cost it was built with (the rate rule: parts keep their price) — only the count
  // follows the units; a hole ("price?") takes the kit's price when the kit has one now.
  const fresh = new Map<string, TaskDetailMaterial[]>();
  for (const m of fromKit.materials) fresh.set(partKey(m), [...(fresh.get(partKey(m)) ?? []), m]);
  const materials: TaskDetailMaterial[] = [];
  for (const m of d.materials) {
    const kits = m.from_kit === true || (legacy && stillTheKits(m));
    if (!kits) {
      materials.push(m);
      continue;
    }
    const take = fresh.get(partKey(m))?.shift();
    if (!take) continue; // the kit no longer carries it: the kit's part follows the kit
    materials.push({ ...take, sell: m.sell ?? take.sell, cost: m.cost ?? take.cost, from_kit: true as const });
  }
  let labor = d.labor;
  if (first !== null && kitHours) {
    const { from_kit: _k, ...rest } = first;
    labor = [{ ...rest, hours: fromKit.hours, ...(fromKit.hours !== null ? { from_kit: true as const } : {}) }, ...d.labor.slice(1)];
  }
  return { ...d, units: next, kit_id: kit.id, labor, materials };
}

/** The line a breakdown prices to: the customer's numbers follow the arithmetic, the flag says what
 *  is still asking. The builder calls this after every edit to the hours or a count. */
export function lineFromDetail(line: DraftLineItem, raw: TaskDetail): DraftLineItem {
  const d = normalizeTaskDetail(raw);
  return { ...line, unit_price: taskMoney(d).total, flag: taskFlags(d), detail: d };
}

/**
 * THE RULE'S ANSWER CHANGED (the customer, their level, the company default): re-price the rows
 * that carry the rule's figure. A "rule" row follows to `rule`. A "legacy" row (read from the old
 * one-figure shape, which never said whose figure it was) follows only while its rate still equals
 * the rule's PREVIOUS answer — the old heuristic, never over a figure he typed. A "hand" or
 * "stated" row stands: he set it. The parts keep the sell they were built with: the item's own
 * markup is not in the breakdown, so re-marking them would guess.
 */
export function repriceTaskLine(line: DraftLineItem, rule: number, prevRule: number): DraftLineItem {
  if (!line.detail) return line;
  const to = round2(Math.max(0, Number(rule) || 0));
  const was = round2(Math.max(0, Number(prevRule) || 0));
  const labor = line.detail.labor.map((r) => {
    if (r.rate_from === "rule") return { ...r, rate: to };
    if (r.rate_from === "legacy" && round2(r.rate) === was) return { ...r, rate: to };
    return r;
  });
  return lineFromDetail(line, { ...line.detail, labor });
}

/** A breakdown with nothing in it but the question: one labor row at the rule's rate, no hours
 *  (the line asks "hours?"), no parts. What the builder starts from when he makes a task of a line. */
export function emptyTaskDetail(rule: { rate: number }): TaskDetail {
  return {
    task_id: randomId(),
    labor: [{ label: null, person_id: null, hours: null, rate: round2(Math.max(0, Number(rule.rate) || 0)), rate_from: "rule" }],
    units: null,
    kit_id: null,
    materials: [],
  };
}

/**
 * MAKE A TASK OF A LINE HE TYPED. The line keeps its words and its numbers — the price he typed is
 * a HAND price (detailExplains says no) until the breakdown adds up to it; it is never zeroed under
 * him. The breakdown starts empty and asking, and the line lands under "Tasks" unless it already
 * has a group.
 */
export function taskFromLine(line: DraftLineItem, rule: { rate: number }): DraftLineItem {
  const detail = emptyTaskDetail(rule);
  return { ...line, detail, group: line.group ?? "Tasks", flag: taskFlags(detail) };
}

/** One task → one line. Quantity starts at 1: the units of a per-unit task ride the breakdown and
 *  the name ("Footings ×7"), so labor + parts always equal the UNIT price to the cent. The Qty box
 *  is his to raise afterwards — "this many of the task" — and the job follows it (cn-v1133). */
export function taskLine(task: TaskValue, ctx: TaskLineContext): DraftLineItem {
  const d = buildTaskDetail(task, ctx);
  const units = task.units !== null && task.units !== 1 ? ` ×${task.units}` : "";
  return lineFromDetail(
    {
      description: `${task.name}${units}`,
      quantity: 1,
      unit: "ea",
      unit_price: 0,
      ...(ctx.group ? { group: ctx.group } : {}),
    },
    d,
  );
}

/** The whole answer, in his order. */
export function taskLines(tasks: TaskValue[], ctx: TaskLineContext): DraftLineItem[] {
  return tasks.map((t) => taskLine(t, ctx));
}

/** jobs.planned_minutes' own check (0229): null, or 0 < n ≤ 43200 (thirty working days). A task's own
 *  minutes (0395) keep to the same bound, so a task can never carry what the job could not. */
export const PLANNED_MINUTES_MAX = 43_200;

/** A TASK'S MINUTES FOR THIS MANY OF IT (cn-v1133) — what the job's task carries (tasks.planned_minutes,
 *  0395): Σ round(h × 60) over the rows he gave hours to, × the line's count, rounded. A row still asking
 *  adds nothing, and no hours at all is null (the task asks on the job as it did on the paper), never 0.
 *  A figure past the bound the column would refuse is null too, never clamped to a number he did not say. */
export function taskMinutesFor(labor: ReadonlyArray<Pick<TaskLabor, "hours">>, qty: number): number | null {
  const minutes = rawMinutes(labor, qty);
  return minutes !== null && minutes > 0 && minutes <= PLANNED_MINUTES_MAX ? minutes : null;
}

/** The figure BEFORE the column's bound: Σ round(h × 60) over the rows he gave hours to, × the count,
 *  rounded; null when no row has hours. */
function rawMinutes(labor: ReadonlyArray<Pick<TaskLabor, "hours">>, qty: number): number | null {
  let sum = 0;
  let any = false;
  for (const r of labor) {
    if (r.hours !== null && Number.isFinite(r.hours) && r.hours > 0) {
      sum += Math.round(r.hours * 60);
      any = true;
    }
  }
  if (!any) return null;
  return Math.round(sum * (Number.isFinite(qty) && qty > 0 ? qty : 1));
}

/** HE GAVE HOURS AND THE COLUMN CANNOT TAKE THEM: this many of the task is past the bound (more than
 *  thirty working days), so taskMinutesFor read null for a figure that exists. The job's whole must read
 *  null too (born-with-tasks tasksFromLines) — the sum of the OTHER tasks is not the job's length
 *  (skeptic #39, N1). A task with no hours at all is not this: it adds nothing, truthfully. */
export function minutesPastBound(labor: ReadonlyArray<Pick<TaskLabor, "hours">>, qty: number): boolean {
  const minutes = rawMinutes(labor, qty);
  return minutes !== null && minutes > PLANNED_MINUTES_MAX;
}

/** A task's labor in MINUTES for ONE of it: the visit's tasks and the kit rule read a task on its own. */
export function laborMinutes(labor: ReadonlyArray<Pick<TaskLabor, "hours">>): number | null {
  return taskMinutesFor(labor, 1);
}
