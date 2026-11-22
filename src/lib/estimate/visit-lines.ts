import type { SupabaseClient } from "@supabase/supabase-js";
import type { Answers, Playbook } from "@/lib/playbook/types";
import { applicableNeeds, clearInapplicable } from "@/lib/playbook/resolve";
import { scopeWord } from "@/lib/playbook/scope";
import { coerceScopes, ownScopes, scopeLines, type ScopePick } from "@/lib/playbook/scopes";
import { coerceTasks, type TaskValue } from "@/lib/playbook/tasks";
import { playbookForForm } from "@/lib/playbook/parse";
import { parseInspectorCapture, seedLinesFromCapture, type CaptureItem } from "@/lib/inspection/capture";
import { readViaView } from "@/lib/inspection/inspection-access";
import { tolerateMissingColumns } from "@/lib/inspection/schema";
import type { DraftLineItem } from "@/lib/estimate/line-map";
import { taskLines, type TaskBookRow, type TaskKit } from "@/lib/estimate/task-lines";
import { laborRateFor } from "@/lib/pricing/labor-rate";
import { ITEM_OPTIONS_EMBED } from "@/lib/pricing/item-options";
import { lineAmount } from "@/lib/appointments/won-sheet";

/**
 * THE LINES A VISIT BECOMES (cn-v1176, M1). ONE builder for the two doors that turn an inspection into
 * estimate lines: Start the Estimate (quotes/new, the editor's seed) and the Inspector's Won sheet
 * (appointments/won-actions, which shows the lines and approves them). Before this release the builder
 * lived inside the estimate page; it moved here unchanged, so the editor is seeded with exactly the
 * lines it was seeded with, in the same order: the scope picks first, then HIS TASKS (one line per
 * task, lib/estimate/task-lines), then the rows typed on site, unpriced (lib/inspection/capture).
 *
 * ONE DELIBERATE CHANGE: the customer whose pricing level prices the lines is the visit's customer,
 * else the customer its lead is tied to (pricingCustomerId). Before, only the visit's own was read, so
 * a lead already tied to a customer was priced at the company's default level.
 *
 * Pure, except the readers at the bottom (readVisitEstimateSeed, readPriceBook, readPricingLevel),
 * which name every column they read (the projection law). Imports no catalog.
 */

/** One scopes question's picks, under its own label and key. */
export type ScopeGroup = { key: string; label: string; picks: ScopePick[] };
/** One tasks question's tasks, under its own label and key. */
export type TaskGroup = { key: string; label: string; tasks: TaskValue[] };

/**
 * THE PICKS THAT STILL APPLY (the read the estimate page has always made): the answers cleared to a
 * fixed point, then every applicable need, a tasks question's tasks and a scopes question's picks. A
 * crew lead's save (0356) keeps the office's priced picks under a scopes question his answers have
 * since turned off; the Inspector hides that question, so its picks never become lines.
 */
export function visitPicks(pb: Playbook, answers: Answers): { scopes: ScopeGroup[]; tasks: TaskGroup[]; scopeWord: string | null } {
  const scopes: ScopeGroup[] = [];
  const tasks: TaskGroup[] = [];
  const liveAnswers = clearInapplicable(pb, answers);
  for (const n of applicableNeeds(pb, liveAnswers)) {
    if (n.slot?.type === "tasks") {
      const t = coerceTasks((liveAnswers as Record<string, unknown>)[n.key]);
      if (t?.length) tasks.push({ key: n.key, label: n.label, tasks: t });
      continue;
    }
    if (n.slot?.type !== "scopes") continue;
    const picks = coerceScopes((liveAnswers as Record<string, unknown>)[n.key]);
    if (picks?.length) scopes.push({ key: n.key, label: n.label, picks });
  }
  return { scopes, tasks, scopeWord: scopeWord(pb, liveAnswers as Answers) };
}

/** The customer whose pricing level prices a visit's lines: the visit's own, else its lead's. */
export function pricingCustomerId(visitCustomerId: string | null | undefined, leadCustomerId: string | null | undefined): string | null {
  return visitCustomerId || leadCustomerId || null;
}

/** A price-book row as the seed reads it (code, words, unit, cost, markup, makers). */
export type VisitBookRow = TaskBookRow & { description?: string | null; unit?: string | null };

/** Everything the builder reads, already read. */
export interface VisitLineSeed {
  scopes: ScopeGroup[];
  tasks: TaskGroup[];
  /** The rows typed on site (capture.items), as parseInspectorCapture read them. */
  typedItems: CaptureItem[] | undefined;
  /** The company's price book (readPriceBook's rows). */
  priceItems: ReadonlyArray<{ code?: string | null; description?: string | null; unit?: string | null } & Record<string, unknown>>;
  /** His task kits (readTaskKits(...).kits). */
  kits: TaskKit[];
  /** The pricing customer's level (null = none, or no customer). */
  level: { markup_pct?: number | string | null; labor_rate?: number | string | null } | null;
  settings: { default_markup_pct: number | null; default_labor_rate: number | null };
}

/** A line with the key it keeps for one read of one visit. */
export type KeyedLine = { key: string; line: DraftLineItem };

/** Unique keys: a repeat (never expected) takes "#2", "#3"…, so an override can never land on two lines. */
function uniqueKeys(keys: string[]): string[] {
  const seen = new Map<string, number>();
  return keys.map((k) => {
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    return n === 1 ? k : `${k}#${n}`;
  });
}

/**
 * THE BUILDER, each line with its key: "scope:<question>:<code>", "task:<question>:<task id>",
 * "typed:<row id>" (the row's place when it has no id). Same lines, same order, same values as
 * visitEstimateLines.
 */
export function visitEstimateRows(seed: VisitLineSeed): KeyedLine[] {
  const priceItems = seed.priceItems ?? [];
  // The inspection's picks, as real lines: descriptions and units come from the company's own book
  // (the answer stores codes, never prose), and a code that has since left the book is dropped.
  const book = new Map(priceItems.map((p) => [p.code as string, { description: p.description, unit: p.unit }]));
  const bookCodes = new Set(book.keys());
  // HIS TASKS, AS LINES: one per task, priced from his hours at THE labor rate (the pricing customer's
  // level rate, else the company default: laborRateFor) and his parts at the book's cost through THE
  // markup rule for that customer. A task without hours is a $0 line that asks.
  const taskBook = new Map<string, TaskBookRow>(priceItems.filter((p) => p.code).map((p) => [String(p.code), p as unknown as TaskBookRow]));
  const pricing = { levelPct: (seed.level?.markup_pct ?? null) as number | null, orgDefaultPct: seed.settings.default_markup_pct };
  // The rule's answer for the pricing customer (no person on a seeded task: the Inspector's hours are
  // the task's, whoever works them), through the one laborRateFor every door prices with.
  const rate = laborRateFor({ levelRate: seed.level?.labor_rate as number | null | undefined, orgDefault: seed.settings.default_labor_rate }).rate;
  const taskKitMap = new Map(seed.kits.map((k) => [k.id, k]));

  const scopeRows: KeyedLine[] = seed.scopes.flatMap((g) => {
    const own = ownScopes(g.picks, bookCodes);
    const lines = scopeLines(own, book, g.label);
    return lines.map((line, i) => ({ key: `scope:${g.key}:${own[i].code}`, line }));
  });
  const taskRows: KeyedLine[] = seed.tasks.flatMap((g) => {
    const lines = taskLines(g.tasks, { book: taskBook, rate, pricing, kits: taskKitMap, group: g.label });
    return lines.map((line, i) => ({ key: `task:${g.key}:${g.tasks[i].id}`, line }));
  });
  // …THEN THE ROWS TYPED ON SITE, unpriced (lib/inspection/capture seedLinesFromCapture): the same
  // filter captureItemsToDraftLines applies, so each key sits beside its own line.
  const typed = (seed.typedItems ?? []).filter((i) => i.description.trim());
  const all = seedLinesFromCapture([...scopeRows.map((r) => r.line), ...taskRows.map((r) => r.line)], seed.typedItems);
  const keys = uniqueKeys([
    ...scopeRows.map((r) => r.key),
    ...taskRows.map((r) => r.key),
    ...typed.map((i, n) => `typed:${i.id || n}`),
  ]);
  return all.map((line, i) => ({ key: keys[i], line }));
}

/** THE BUILDER: the visit's estimate lines, in order (scope picks, tasks, typed rows). */
export function visitEstimateLines(seed: VisitLineSeed): DraftLineItem[] {
  return visitEstimateRows(seed).map((r) => r.line);
}

/** What a line still asks, if anything (M2, the ONE hole rule): a line is a hole when it carries a
 *  flag (a task's "hours?", "price? …", a typed row the capture flagged) OR its unit price is 0 or
 *  less (a $0 typed row, a $0 price-list pick) OR its quantity or amount is 0 or less. The builder emits no discount, heading or note lines,
 *  so no line is exempt. */
export function lineHole(line: Pick<DraftLineItem, "flag" | "unit_price" | "quantity">): null | { kind: "flag" | "zero"; flag: string | null } {
  if (line.flag) return { kind: "flag", flag: line.flag };
  if (!(Number(line.unit_price) > 0)) return { kind: "zero", flag: null };
  // A QUANTITY OF 0 OR LESS, OR AN AMOUNT OF 0 OR LESS, IS A HOLE TOO (cn-v1176 fix F3): "0 × $50.00" or
  // a negative count never reaches an approved estimate; the sheet's Qty box asks for it. The amount is
  // rounded the way the stored line is (won-sheet lineAmount), the rule applyWonOverrides reads too.
  if (!(Number(line.quantity) > 0) || !(lineAmount(Number(line.quantity), Number(line.unit_price)) > 0)) return { kind: "zero", flag: null };
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE READERS (not pure). RLS scopes every read to the caller's company; the callers are office
// doors (the estimate page, the Won sheet's staff-only actions).
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** The visit's own row, as both doors read it. */
export type VisitRow = {
  id: string;
  title: string | null;
  location: string | null;
  inquiry_id: string | null;
  customer_id: string | null;
  job_id: string | null;
  capture: unknown;
  type: string | null;
  status: string | null;
  outcome: string | null;
};

/** The lead behind the visit, as the doors read it. */
export type VisitLead = { id: string; intake: unknown; customer_id: string | null; name: string | null; company_name: string | null };

export interface VisitEstimateSeedRead {
  visit: VisitRow;
  /** The playbook the inspector wrote through, and his answers as stored (prices included: office). */
  pb: Playbook;
  answers: Answers;
  lead: VisitLead | null;
  typed: ReturnType<typeof parseInspectorCapture>;
  scopes: ScopeGroup[];
  tasks: TaskGroup[];
  scopeWord: string | null;
  /** pricingCustomerId(visit, lead). */
  pricingCustomerId: string | null;
}

/**
 * THE VISIT-SIDE READS (moved from the estimate page): the visit, its answers THROUGH appointment_answers
 * (0366, LEAK-0227: the answers column is revoked from the signed-in role, and these are the office's
 * doors, so the view hands back the answers as stored, prices included), its sheet and its lead, each a
 * read of its own. Null when the visit is not this company's (or not there). A failed answers read
 * THROWS: an estimate is never seeded from an inspection that could not be read. Pre-0165 (no such
 * column) is no answers.
 */
export async function readVisitEstimateSeed(supabase: SupabaseClient, visitId: string): Promise<VisitEstimateSeedRead | null> {
  const { data: appt, error: apptErr } = await supabase
    .from("appointments")
    .select("id, title, location, inquiry_id, capture, customer_id, job_id, type, status, outcome")
    .eq("id", visitId)
    .maybeSingle();
  if (apptErr) throw apptErr;
  if (!appt) return null;
  const visit = appt as unknown as VisitRow;
  const ans = await readViaView<{ inspection_answers: unknown; inspection_template_id: string | null; inquiry_id: string | null }>(
    supabase,
    "answers",
    (from) => from.select("inspection_answers, inspection_template_id, inquiry_id").eq("id", visitId).maybeSingle(),
  );
  if (ans.error && !(ans.via === "table" && String((ans.error as { code?: string }).code ?? "") === "42703")) throw ans.error;
  const leadId = ans.data?.inquiry_id ?? visit.inquiry_id ?? null;
  const [sheetRel, leadRel] = await Promise.all([
    ans.data?.inspection_template_id
      ? tolerateMissingColumns<{ schema: unknown; playbook: unknown }>(() =>
          supabase.from("forms").select("schema, playbook").eq("id", ans.data!.inspection_template_id!).maybeSingle(),
        )
      : Promise.resolve(null),
    leadId
      ? tolerateMissingColumns<VisitLead>(() =>
          supabase.from("inquiries").select("id, intake, customer_id, name, company_name").eq("id", leadId).maybeSingle(),
        )
      : Promise.resolve(null),
  ]);
  const pb = playbookForForm(sheetRel);
  const answers = ((ans.data?.inspection_answers ?? {}) as Answers) ?? {};
  const picks = ans.data ? visitPicks(pb, answers) : { scopes: [], tasks: [], scopeWord: null };
  const lead = (leadRel as VisitLead | null) ?? null;
  return {
    visit,
    pb,
    answers,
    lead,
    typed: parseInspectorCapture(visit.capture),
    scopes: picks.scopes,
    tasks: picks.tasks,
    scopeWord: picks.scopeWord,
    pricingCustomerId: pricingCustomerId(visit.customer_id, lead?.customer_id),
  };
}

/** THE PRICE BOOK as the estimate seeds from it: its makers ride with each code (0282), archived ones
 *  left out (the embed's own filter). The same read the estimate page hands its editor. */
export function readPriceBook(supabase: SupabaseClient) {
  return supabase
    .from("price_list_items")
    .select(`id, code, description, category, unit, buy_price, markup_pct, updated_at, ${ITEM_OPTIONS_EMBED}`)
    .eq("archived", false)
    .eq("price_list_item_options.archived", false)
    .order("description")
    .limit(2000);
}

/** The pricing customer's level (markup and labor rate), or null (no customer, no level, not ours). */
export async function readPricingLevel(
  supabase: SupabaseClient,
  customerId: string | null,
): Promise<{ markup_pct: number | string | null; labor_rate: number | string | null } | null> {
  if (!customerId) return null;
  const { data, error } = await supabase.from("customers").select("id, pricing_levels(markup_pct, labor_rate)").eq("id", customerId).maybeSingle();
  if (error) throw error;
  const rel = (data as { pricing_levels?: unknown } | null)?.pricing_levels;
  const lvl = (Array.isArray(rel) ? rel[0] : rel) as { markup_pct?: number | string | null; labor_rate?: number | string | null } | null | undefined;
  return lvl ? { markup_pct: lvl.markup_pct ?? null, labor_rate: lvl.labor_rate ?? null } : null;
}
