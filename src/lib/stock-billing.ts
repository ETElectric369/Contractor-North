/**
 * BILLING THE PIECES TAKEN FROM STOCK (Shop Stock, Phase 3: items 4, 5 and 6 of the plan).
 *
 * A take (stock_draw, 0303) writes one `draw` move per roll it touched, all under one draw_group,
 * each carrying the cost the database stamped from its roll (FIFO, never an average). Once the
 * take is on a job it is the job's cost (job_shelf_net). This file is what the CUSTOMER sees of it:
 *
 *   · ONE invoice line per take (draw_group), never merged into another line and never merging
 *     two takes (the invoice-line law: materials stay itemized). "12/2 NM-B, 40 ft".
 *   · The words come from the item and the take, nothing else: never the shelf, a roll, a lot, a
 *     supplier or a ticket (a customer document never says where the piece sat).
 *   · Priced with the importer's own mark(): the invoice's markup (the customer's level, or the %
 *     already on the invoice) on the pieces' stamped cost, rounded once, like a bill row.
 *   · Claimed by the move ids (source_ids), keyed 'stock:<draw_group>'. 0343 makes a move id
 *     claimable by exactly one live invoice line, so the same piece is never billed twice.
 *   · A SHORT (pieces taken past the shelf, $0 until a roll is filed and the short is settled) is
 *     NEVER imported. It is said, in one sentence, wherever an invoice is built.
 *   · Pieces carried back to the shelf (job_return) come off the take before it is billed; a take
 *     brought back whole bills nothing.
 *
 * Pure half (the planner, the words) plus one thin reader. No server-only imports: the importer,
 * the Unbilled card, the work-to-date panel, the portal and the tests all load the same file, so
 * the figure the card promises is the figure the button writes.
 */

import { isMissingShelf } from "@/lib/job-cost";

const cents = (n: number) => Math.round(n * 100) / 100;
const qty3 = (n: number) => Math.round(n * 1000) / 1000;
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** A move as the reader hands it over (numeric columns may arrive as strings). */
export type StockMoveRow = {
  id: string;
  item_id: string;
  draw_group: string | null;
  kind: string;
  qty: unknown;
  cost: unknown;
  created_at: string;
  returns_move_id?: string | null;
  settled_by?: string | null;
};
export type StockItemRow = { id: string; name: string | null; unit: string | null };

/** One take on a job, net of anything carried back: what one invoice line would bill. */
export type StockTake = {
  group: string;
  itemId: string;
  item: string;
  unit: string;
  /** Pieces still on the job (the take less any carried back). */
  qty: number;
  /** What those pieces cost the company, as the database stamped them. */
  cost: number;
  /** The draw moves of the take: the claim. A returned piece's draw stays in it (the draw is what
   *  was taken; the return only lowers what is billed). */
  moveIds: string[];
  takenAt: string;
};

/** Pieces taken past the shelf that no roll has settled yet. */
export type StockShort = { id: string; item: string; unit: string; qty: number; takenAt: string };

/** "40", "12.5", "0.125" - a count as a person writes it. */
export function qtyWords(n: number): string {
  const q = qty3(n);
  return Number.isInteger(q) ? String(q) : String(q).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/** The customer's words for a take: the item, then the count in its unit. Nothing about where it came from. */
export function stockLineWords(item: string, qty: number, unit: string): string {
  const name = String(item ?? "").replace(/\s+/g, " ").trim() || "Materials";
  const u = String(unit ?? "").trim();
  return `${name}, ${qtyWords(qty)}${u ? ` ${u}` : ""}`.slice(0, 300);
}

/** The office's words for a take on the Costs tab: "From Stock · 12/2 NM-B, 40 ft". Never a customer's. */
export function stockCostLabel(t: Pick<StockTake, "item" | "qty" | "unit">): string {
  return `From Stock · ${stockLineWords(t.item, t.qty, t.unit)}`;
}

/**
 * The job's live moves (draws, returns and shorts, undone ones already left out by the reader)
 * folded into takes and unsettled shorts. Pure.
 */
export function stockTakesOnJob(moves: readonly StockMoveRow[], items: readonly StockItemRow[]): { takes: StockTake[]; shorts: StockShort[] } {
  const itemById = new Map(items.map((i) => [String(i.id), i] as const));
  const nameOf = (id: string) => String(itemById.get(id)?.name ?? "").trim() || "Materials";
  const unitOf = (id: string) => String(itemById.get(id)?.unit ?? "").trim() || "ea";
  const back = new Map<string, { qty: number; cost: number }>();
  for (const m of moves) {
    if (m.kind !== "job_return" || !m.returns_move_id) continue;
    const k = String(m.returns_move_id);
    const prev = back.get(k) ?? { qty: 0, cost: 0 };
    back.set(k, { qty: qty3(prev.qty + num(m.qty)), cost: cents(prev.cost + num(m.cost)) });
  }
  const byGroup = new Map<string, StockTake>();
  for (const m of moves) {
    if (m.kind !== "draw" || !m.draw_group) continue;
    const g = String(m.draw_group);
    const r = back.get(String(m.id)) ?? { qty: 0, cost: 0 };
    const t = byGroup.get(g) ?? {
      group: g,
      itemId: String(m.item_id),
      item: nameOf(String(m.item_id)),
      unit: unitOf(String(m.item_id)),
      qty: 0,
      cost: 0,
      moveIds: [],
      takenAt: m.created_at,
    };
    t.qty = qty3(t.qty + num(m.qty) - r.qty);
    t.cost = cents(t.cost + num(m.cost) - r.cost);
    t.moveIds.push(String(m.id));
    if (m.created_at < t.takenAt) t.takenAt = m.created_at;
    byGroup.set(g, t);
  }
  const takes = [...byGroup.values()]
    .filter((t) => t.qty > 0)
    .sort((a, b) => a.takenAt.localeCompare(b.takenAt) || a.group.localeCompare(b.group));
  for (const t of takes) t.moveIds.sort();
  const shorts: StockShort[] = moves
    .filter((m) => m.kind === "short" && !m.settled_by)
    .map((m) => ({ id: String(m.id), item: nameOf(String(m.item_id)), unit: unitOf(String(m.item_id)), qty: qty3(num(m.qty)), takenAt: m.created_at }))
    .sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  return { takes, shorts };
}

/** Takes no other invoice holds: a take is billed whole or not at all (any of its moves claimed = claimed). */
export function unclaimedTakes(takes: readonly StockTake[], claimed: ReadonlySet<string> | { has: (id: string) => boolean }): { free: StockTake[]; held: StockTake[] } {
  const free: StockTake[] = [];
  const held: StockTake[] = [];
  for (const t of takes) (t.moveIds.some((id) => claimed.has(id)) ? held : free).push(t);
  return { free, held };
}

/** The importer's mark(): cost to sell, one rounding, exactly as billItemisation and the lump rows do. */
export function markStock(cost: number, markupPct: unknown): number {
  const rate = 1 + (Number(markupPct) || 0) / 100;
  return Math.round(cost * rate * 100) / 100;
}

export type StockImportRow = {
  import_key: string;
  description: string;
  quantity: number;
  unit: string;
  unit_price: number;
  source_ids: string[];
};

/** The import key of a take's line. One spelling, shared with every reader. */
export function stockKey(group: string): string {
  return `stock:${group}`;
}

/**
 * One invoice row per take, at the invoice's markup. The line bills EXACTLY mark(cost): there is no
 * "Supplies & tax" row behind a take to true up cents, so qty x unit price is shown only when it
 * lands on that figure to the cent (and the count fits the invoice's two decimals); otherwise the
 * row is 1 x the sell, and the count stays in the words ("12/2 NM-B, 60 ft"), never invented.
 * A take whose pieces cost nothing (a roll with no cost on it) bills nothing and is left off:
 * `zeroCost` says so, so the caller can name it.
 */
export function stockImportRows(takes: readonly StockTake[], markupPct: unknown): { rows: StockImportRow[]; zeroCost: StockTake[] } {
  const rows: StockImportRow[] = [];
  const zeroCost: StockTake[] = [];
  for (const t of takes) {
    const sell = markStock(t.cost, markupPct);
    if (!(sell > 0)) {
      zeroCost.push(t);
      continue;
    }
    const description = stockLineWords(t.item, t.qty, t.unit);
    const q2 = Math.round(t.qty * 100) / 100;
    const unitPrice = t.qty > 0 ? Math.round((sell / t.qty) * 100) / 100 : sell;
    const exact = q2 === qty3(t.qty) && unitPrice > 0 && Math.round(unitPrice * q2 * 100) / 100 === sell;
    rows.push(
      exact
        ? { import_key: stockKey(t.group), description, quantity: q2, unit: t.unit, unit_price: unitPrice, source_ids: [...t.moveIds] }
        : { import_key: stockKey(t.group), description, quantity: 1, unit: "ea", unit_price: sell, source_ids: [...t.moveIds] },
    );
  }
  return { rows, zeroCost };
}

/** What a set of takes bills and costs, for the Unbilled card and work to date. */
export function stockTotals(takes: readonly StockTake[], markupPct: unknown): { count: number; cost: number; billed: number } {
  let cost = 0;
  let billed = 0;
  let count = 0;
  for (const t of takes) {
    const sell = markStock(t.cost, markupPct);
    if (!(sell > 0)) continue;
    cost = cents(cost + t.cost);
    billed = cents(billed + sell);
    count += 1;
  }
  return { count, cost, billed };
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * THE ONE SENTENCE about pieces taken past the shelf, for the office (never a customer): they are
 * not on the bill, and what settles them. Null when there are none.
 */
export function stockShortsSentence(shorts: readonly StockShort[]): string | null {
  if (!shorts.length) return null;
  // Same item and unit counted once: "30 ft of 12/2 NM-B", not two 15 ft clauses.
  const byItem = new Map<string, { item: string; unit: string; qty: number }>();
  for (const s of shorts) {
    const k = `${s.item}\u0000${s.unit}`;
    const prev = byItem.get(k) ?? { item: s.item, unit: s.unit, qty: 0 };
    byItem.set(k, { ...prev, qty: qty3(prev.qty + s.qty) });
  }
  const what = joinAnd([...byItem.values()].map((x) => `${qtyWords(x.qty)} ${x.unit} of ${x.item}`));
  const one = shorts.length === 1;
  return `${what} ${one ? "was" : "were"} taken from stock with no roll behind ${one ? "it" : "them"} yet, so ${one ? "it isn't" : "they aren't"} on the bill: file the roll or count the shelf, then settle ${one ? "it" : "them"} on Shop Stock before billing.`;
}

/** The office's words for takes left off because their pieces cost nothing. Null when none. */
export function stockZeroCostSentence(takes: readonly StockTake[]): string | null {
  if (!takes.length) return null;
  const what = joinAnd(takes.map((t) => stockLineWords(t.item, t.qty, t.unit)));
  return `${what} came off a roll with no cost on it, so ${takes.length === 1 ? "it isn't" : "they aren't"} on the bill - put a cost on the roll, or add the line by hand`;
}

/** "a take from stock" / "3 takes from stock": the office's noun for what the importer pulled in. */
export function takesWords(n: number): string {
  return n === 1 ? "1 take from stock" : `${n} takes from stock`;
}

type Sb = { from: (t: string) => any };

/**
 * THE READ: a job's live takes, returns and unsettled shorts, with the items' names and units.
 *
 * Staff read it through RLS (stock_moves and inventory_items are staff-only, 0302/0303): a tech's
 * session reads nothing and bills nothing, and never sees a cost. The customer portal reads it as
 * the service role, so `scope` pins every read to the org by hand. A database without the shelf
 * (0303 not applied) reads as no takes, which is exactly true there; any other failure is thrown,
 * because "no pieces" is a money statement nobody made.
 */
export async function readJobStock(
  supabase: Sb,
  jobId: string,
  scope?: { orgId: string },
): Promise<{ takes: StockTake[]; shorts: StockShort[] }> {
  let q = supabase
    .from("stock_moves")
    .select("id, item_id, draw_group, kind, qty, cost, created_at, returns_move_id, settled_by")
    .eq("job_id", jobId)
    .is("undone_at", null)
    .in("kind", ["draw", "job_return", "short"]);
  if (scope?.orgId) q = q.eq("org_id", scope.orgId);
  const { data, error } = await q;
  if (error) {
    if (isMissingShelf(error)) return { takes: [], shorts: [] };
    throw error;
  }
  const moves = (data ?? []) as StockMoveRow[];
  if (!moves.length) return { takes: [], shorts: [] };
  const ids = [...new Set(moves.map((m) => String(m.item_id)))];
  let iq = supabase.from("inventory_items").select("id, name, unit").in("id", ids);
  if (scope?.orgId) iq = iq.eq("org_id", scope.orgId);
  const { data: items, error: itemsErr } = await iq;
  if (itemsErr) throw itemsErr;
  return stockTakesOnJob(moves, (items ?? []) as StockItemRow[]);
}
