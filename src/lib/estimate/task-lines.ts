import type { DraftLineItem, TaskDetail, TaskDetailMaterial } from "./line-map";
import type { TaskMaterial, TaskValue } from "@/lib/playbook/tasks";
import { describeChoice, priceBookLine, type BookPricing, type OptionedPriceItem } from "@/lib/pricing/item-options";
import { kitLineView, type KitLineRaw, type KitPricing } from "@/lib/kit-line";

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
 * ── NO SPECULATION ([[no-speculation]]) ──────────────────────────────────────────────────────
 *
 * A task without hours prices its labor at $0 and carries the flag "hours?". A part without a
 * count prices at $0 and asks "how many?". A part the book cannot price (his words only, or a code
 * the book no longer carries) prices at $0 and asks "price?". Nothing here ever fills a hole with a
 * typical figure: the line is a zero that ASKS, never a number that looks right.
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
  items: KitLineRaw[];
}

export interface TaskLineContext {
  /** The org's price book by code (as stored; an UPPERCASE lookup is tried second). */
  book: Map<string, TaskBookRow>;
  /** The labor rate for this customer, already resolved by laborRateFor. 0 = none set. */
  rate: number;
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

/**
 * READ A STORED BREAKDOWN BACK. Tolerant: the public page receives the REDACTED shape (no task_id,
 * no kit_id, no cost — public_quote strips them), an older row may carry nothing at all, and a hand
 * edit of the JSON must never crash a document. Null when it is not a breakdown.
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
  const hours = positive(o.hours);
  return {
    task_id: str(o.task_id, 80),
    hours,
    rate: nonNegative(o.rate) ?? 0,
    units: positive(o.units),
    kit_id: str(o.kit_id, 64) || null,
    materials,
    ...(hours !== null && o.hours_from_kit === true ? { hours_from_kit: true as const } : {}),
  };
}

/** A line's task name without the units it carries ("Footings ×7" → "Footings"). */
export function stripUnits(description: string): string {
  return description.replace(/\s*×\s*\d+(?:[.,]\d+)?\s*$/u, "").trim();
}

/** The suffix a count writes on a line's name: " ×N" when N is not one (taskLine's rule). */
const unitsSuffix = (units: number | null): string => (units !== null && units !== 1 ? ` ×${units}` : "");

/** The line's name for another count: ONLY the suffix the previous count wrote is replaced, so a
 *  name that ends in his own "4×4" (or one he edited by hand) is never rewritten under him. */
export function lineNameWithUnits(description: string, prevUnits: number | null, units: number | null): string {
  const prev = unitsSuffix(prevUnits);
  const base = prev && description.endsWith(prev) ? description.slice(0, -prev.length) : description;
  return `${base}${unitsSuffix(units)}`;
}

/** A part the builder added and nobody named yet is not a part: it prices nothing and asks nothing
 *  (coerceTaskDetail drops it on save, so what the screen sums is what the row will hold). */
const named = (m: TaskDetailMaterial): boolean => m.name.trim().length > 0;

/**
 * THE SAME NUMBERS THE SAVE WILL KEEP. coerceTaskDetail rounds to cents on the way back in; if the
 * builder priced raw "1.333" hours the reloaded breakdown would no longer explain the line and the
 * paper would drop it as "set by hand". So every edit is rounded here first, the one way.
 */
export function normalizeTaskDetail(d: TaskDetail): TaskDetail {
  return {
    ...d,
    hours: positive(d.hours),
    rate: nonNegative(d.rate) ?? 0,
    units: positive(d.units),
    materials: d.materials.map((m) => ({ ...m, qty: positive(m.qty), cost: nonNegative(m.cost), sell: nonNegative(m.sell) })),
  };
}

/** The arithmetic behind a task line, in cents: labor = hours × rate, parts = Σ qty × sell. */
export function taskMoney(d: TaskDetail): { labor: number; parts: number; total: number } {
  const labor = d.hours === null ? 0 : round2(d.hours * d.rate);
  const parts = round2(d.materials.filter(named).reduce((t, m) => t + (m.qty ?? 0) * (m.sell ?? 0), 0));
  return { labor, parts, total: round2(labor + parts) };
}

/**
 * WHAT THE LINE IS STILL ASKING. Build-time only (DraftLineItem.flag): the office reads it in the
 * builder; the customer never does. Each hole is named, so a $0 is never mistaken for a price.
 */
export function taskFlags(d: TaskDetail): string | undefined {
  const flags: string[] = [];
  if (d.hours === null) flags.push("hours?");
  else if (d.rate <= 0) flags.push("no company labor rate set");
  for (const m of d.materials.filter(named)) {
    if (m.qty === null) flags.push(`how many? ${m.name}`);
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
 * the hours and parts from it).
 */
export function detailExplains(d: TaskDetail, line: { quantity: number; unit_price: number }): boolean {
  return Math.abs(taskMoney(d).total - round2((Number(line.quantity) || 0) * (Number(line.unit_price) || 0))) < 0.005;
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
    const lead = view.code ? `${view.code} — ` : "";
    const name = (lead && view.description.startsWith(lead) ? view.description.slice(lead.length) : view.description).trim();
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

/** The breakdown for one task. HIS hours win over a kit's (fill holes, never overwrite a hand). */
export function buildTaskDetail(task: TaskValue, ctx: TaskLineContext): TaskDetail {
  const kit = task.kit_id ? ctx.kits?.get(task.kit_id) ?? null : null;
  const fromKit = kit ? expandTaskKit(task, kit, { orgDefaultPct: ctx.pricing.orgDefaultPct ?? 0, levelPct: ctx.pricing.levelPct }) : null;
  const kitHours = task.hours === null && fromKit?.hours !== null && fromKit?.hours !== undefined;
  return {
    task_id: task.id,
    hours: task.hours ?? fromKit?.hours ?? null,
    rate: ctx.rate,
    units: task.units,
    kit_id: kit ? kit.id : null,
    // The kit's parts are marked as the kit's, so a change of units re-derives them and leaves
    // his own alone (reexpandTaskDetail).
    materials: [...(fromKit?.materials ?? []).map((m) => ({ ...m, from_kit: true as const })), ...task.materials.map((m) => materialDetail(m, ctx))],
    ...(kitHours ? { hours_from_kit: true as const } : {}),
  };
}

/**
 * THE SAME TASK, FOR OTHER UNITS (W4, the builder's units box). The kit's own figures — the hours
 * it gave and the parts it put there — are derived again for the new count through THE one
 * expandTaskKit; his typed hours and every part he added or edited by hand stand as they are. With
 * no kit to expand, only the count changes (it rides the name).
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

  // A LINE SAVED BEFORE THE MARKS (cn-v1076), or one he has edited all over: nothing on it is
  // flagged. The kit's parts are then recognised only where they still read EXACTLY as the kit put
  // them for the old count (same code or words, same count), and its hours only when they equal
  // what the kit gave — anything else on such a line is his and stands.
  const legacy = !d.materials.some((m) => m.from_kit === true) && d.hours_from_kit !== true;
  const asWas = legacy ? expandTaskKit(probe(d.units), kit, pricing) : null;
  const kitHours = d.hours_from_kit === true || (asWas !== null && d.hours !== null && d.hours === asWas.hours);
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
  const { hours_from_kit: _h, ...rest } = d;
  return {
    ...rest,
    units: next,
    kit_id: kit.id,
    hours: kitHours ? fromKit.hours : d.hours,
    materials,
    ...(kitHours && fromKit.hours !== null ? { hours_from_kit: true as const } : {}),
  };
}

/** The line a breakdown prices to: the customer's numbers follow the arithmetic, the flag says what
 *  is still asking. The builder calls this after every edit to the hours or a count. */
export function lineFromDetail(line: DraftLineItem, raw: TaskDetail): DraftLineItem {
  const d = normalizeTaskDetail(raw);
  return { ...line, unit_price: taskMoney(d).total, flag: taskFlags(d), detail: d };
}

/** Re-price a task line's LABOR at another rate (the customer changed). The parts keep the sell they
 *  were built with: the item's own markup is not in the breakdown, so re-marking them would guess. */
export function repriceTaskLine(line: DraftLineItem, rate: number): DraftLineItem {
  if (!line.detail) return line;
  return lineFromDetail(line, { ...line.detail, rate: round2(Math.max(0, rate)) });
}

/** One task → one line. Quantity is always 1: the units of a per-unit task ride the breakdown and
 *  the name ("Footings ×7"), so labor + parts always equal the line to the cent. */
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
