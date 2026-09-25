import "server-only";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";
import { createClient } from "@/lib/supabase/server";
import { dbError } from "@/lib/db-error";
import { billLineCost, isTaxLine, shelfLotCost, type BillLine } from "@/lib/bill-itemisation";
import { isMissingShelf } from "@/lib/job-cost";

/**
 * THE SHOP SHELF, AS A LEDGER (Shop Stock, Phase 1; migrations 0303 + 0304).
 *
 * Erik, 2026-09-19, about the 500-count Twister box: "a whole container of wire nuts that we use
 * some of but is certainly stock". The first answer to that (stock-flow.ts, cn-v964) kept a COUNT
 * on inventory_items and nothing about how it got there, so the money could not follow the piece:
 * job cost read the whole receipt, and the next job that used the nuts paid nothing for them.
 *
 * This replaces it. A LOT is one purchase on the shelf; a MOVE is pieces leaving it (onto a job,
 * written off, back to the supplier) or coming back. The database stamps every move's cost from
 * its lot, oldest lot first (FIFO, never an average), and the move that empties a lot takes its
 * exact remaining dollars. The job that bought the roll stops carrying what went on the shelf; the
 * job that takes a piece carries exactly what that piece cost. src/lib/job-cost.ts reads both
 * halves through the job_shelf_net view.
 *
 * ── THE LAWS THIS FILE KEEPS ──────────────────────────────────────────────────────────────────
 *  · The paper is the ceiling. A lot's cost is shelfLotCost (bill-itemisation.ts): the line's
 *    not-billed dollars plus its share of the untouched tax, the SAME arithmetic the invoice uses,
 *    so the job's part plus its rolls is the receipt to the cent. The database caps it too.
 *  · Nothing is inferred. A unit or a count guessed from a description only fills a box a person
 *    confirms (guessUnit); a matched item is exact or it is a new item (matchItem, never fuzzy).
 *  · Only stock_draw takes pieces. A tech reaches it through takeFromStock and gets quantities
 *    back, never a cost.
 *
 * In Phase 1 NOTHING CALLS THE SERVER HALF YET: the doors that put a roll on the shelf (Phase 2)
 * and take a piece off it (Phase 3) arrive with their screens. It ships now, with zero lots, so
 * every job-cost reader could be switched and proven unchanged to the cent first.
 *
 * This is deliberately NOT a "use server" module (same reason as bill-itemisation.ts): the pure
 * half has to be importable by tests. Call the server functions from your own action.
 */

/* ════════════════════════════════════════════════════════════════════════════════════════════
   THE PURE PART. Nothing below this line touches Supabase until THE SERVER PART.
   ════════════════════════════════════════════════════════════════════════════════════════════ */

const cents = (n: number) => Math.round(n * 100) / 100;
const qty3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * A part number with its punctuation taken off: "30-641", "30 641" and "30641" are one part, and
 * every supply house writes it a different way. Letters are kept (a "4S-1/2" box is not a "4S"),
 * so this only ever collapses SEPARATORS, never content. (Moved from stock-flow.ts.)
 */
export function normalisePartNumber(raw: string | null | undefined): string | null {
  const key = String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return key.length ? key : null;
}

/**
 * A description reduced to its letters, digits and single spaces, for exact comparison only.
 * Digits are KEPT because they are the whole difference between a 341-Tan nut and a 342-Red one;
 * this is a case-and-punctuation fold, not a similarity score. (Moved from stock-flow.ts.)
 */
export function normaliseName(raw: string | null | undefined): string {
  return String(raw ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

/** A stock item, in the only shape the matcher needs to see it. */
export type ItemCandidate = {
  id: string;
  name: string;
  /** The normalised supplier part number or price-list code (0303). */
  key_part?: string | null;
  /** Legacy part number typed on the item; read as a key when key_part is empty. */
  part_number?: string | null;
  price_item_id?: string | null;
  created_at?: string | null;
};

export type ItemMatch = { kind: "match"; id: string; why: string } | { kind: "create"; why: string };

/**
 * WHICH ITEM ON THE SHELF THIS PURCHASE BELONGS TO, OR NONE.
 *
 * The second box of the same wire nuts must land on the SAME item, or the count is split across
 * twins. But merging two DIFFERENT parts into one item is the worse failure: a twin is visible on
 * the page, a bad merge is one row quietly holding the sum of two products. So:
 *   1. same part number (key_part, or the legacy part_number) -> that item;
 *   2. same price-list item -> that item;
 *   3. an item whose OWN part number disagrees is never matched on anything else: the part numbers
 *      disagreeing is the product telling us it is a different product;
 *   4. otherwise the exact normalised name;
 *   5. anything else -> create.
 * Several items sharing a key are already twins: the oldest wins, deterministically.
 */
export function matchItem(
  candidates: ItemCandidate[],
  key: { partNumber?: string | null; priceItemId?: string | null; description: string },
): ItemMatch {
  const wantPart = normalisePartNumber(key.partNumber);
  const wantName = normaliseName(key.description);
  const partOf = (c: ItemCandidate) => normalisePartNumber(c.key_part) ?? normalisePartNumber(c.part_number);
  const oldest = (rows: ItemCandidate[]) =>
    [...rows].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) || a.id.localeCompare(b.id))[0];

  if (wantPart) {
    const samePart = candidates.filter((c) => partOf(c) === wantPart);
    if (samePart.length) return { kind: "match", id: oldest(samePart).id, why: "same part number" };
  }
  if (key.priceItemId) {
    const samePrice = candidates.filter((c) => c.price_item_id && c.price_item_id === key.priceItemId);
    if (samePrice.length) return { kind: "match", id: oldest(samePrice).id, why: "same price-list item" };
  }
  if (wantName) {
    // A candidate carrying a DIFFERENT part number is a different product whatever it is called.
    const sameName = candidates.filter((c) => normaliseName(c.name) === wantName && (!wantPart || !partOf(c)));
    if (sameName.length) {
      return {
        kind: "match",
        id: oldest(sameName).id,
        why: wantPart ? "same name, and that item carries no part number to disagree with this one" : "same name",
      };
    }
  }
  return { kind: "create", why: wantPart ? "nothing on the shelf carries this part number" : "nothing on the shelf goes by this name" };
}

export type UnitGuess = {
  /** "ft" or "ea", or null when the description says nothing a person could not say better. */
  unit: "ft" | "ea" | null;
  /** Pieces in ONE of what the line bought (250 for a 250 ft coil), or null. */
  perContainer: number | null;
  why: string;
};

/**
 * WHAT A RECEIPT LINE IS COUNTED IN, AS A SUGGESTION ONLY.
 *
 * Order: the price list's own unit for this part (a person typed it once), then what the
 * description spells out - a length in feet (250 FT, 250', a COIL or REEL of so many feet), or a
 * pack count (PK100, 100PK). Anything else is null and the person says. It never reads the line's
 * quantity column: a scanner put 500 there out of the product NAME on the Twister line, and the
 * "1000' REEL, qty 55" counter cut is the trap splitContradictsReceipt exists for.
 */
export function guessUnit(description: string | null | undefined, priceListUnit?: string | null): UnitGuess {
  const pl = String(priceListUnit ?? "").trim().toLowerCase();
  if (pl === "ft" || pl === "feet" || pl === "foot") return { unit: "ft", perContainer: null, why: "the price list counts it in feet" };
  if (pl === "ea" || pl === "each") return { unit: "ea", perContainer: null, why: "the price list counts it each" };

  const d = String(description ?? "").toUpperCase();
  const feet =
    d.match(/(\d[\d,]*)\s*(?:FT\b|FEET\b|')/) ?? d.match(/\b(?:COIL|REEL)\s*(?:OF\s*)?(\d[\d,]*)\b/) ?? null;
  if (feet) {
    const n = Number(feet[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) return { unit: "ft", perContainer: n, why: `the description says ${n} ft` };
  }
  if (/\b(COIL|REEL)\b/.test(d)) return { unit: "ft", perContainer: null, why: "a coil or reel is counted in feet" };
  const pack = d.match(/\bPK\s*(\d+)\b/) ?? d.match(/\b(\d+)\s*PK\b/);
  if (pack) {
    const n = Number(pack[1]);
    if (Number.isFinite(n) && n > 0) return { unit: "ea", perContainer: n, why: `the description says a pack of ${n}` };
  }
  return { unit: null, perContainer: null, why: "the description doesn't say; ask" };
}

/** A live lot, as the FIFO walk sees it. */
export type LotForTake = {
  id: string;
  bought_on: string | null;
  created_at: string | null;
  pieces: number;
  cost: number;
  piecesLeft: number;
  costLeft: number;
};

export type PlannedTake = { lotId: string; qty: number; cost: number };

/**
 * THE TAKE, WORKED OUT THE WAY THE DATABASE STAMPS IT (stock_draw + stamp_stock_move, 0303), for a
 * preview and for tests. Oldest lot first; one take per lot touched; a take that empties a lot
 * takes its exact remaining dollars, any other is qty x cost / pieces rounded to the cent and never
 * more than is left; what the shelf cannot cover is a SHORT at $0 - never a cost invented at the
 * newest lot's rate.
 */
export function planFifoTake(lots: LotForTake[], qty: number): { takes: PlannedTake[]; short: number; cost: number } {
  let rem = qty3(Number(qty) || 0);
  const takes: PlannedTake[] = [];
  const ordered = [...lots].sort(
    (a, b) =>
      String(a.bought_on ?? "").localeCompare(String(b.bought_on ?? "")) ||
      String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")) ||
      a.id.localeCompare(b.id),
  );
  for (const l of ordered) {
    if (rem <= 0) break;
    const left = qty3(l.piecesLeft);
    if (!(left > 0)) continue;
    const take = Math.min(left, rem);
    const cost = take === left ? cents(l.costLeft) : Math.min(cents((take * l.cost) / l.pieces), cents(l.costLeft));
    takes.push({ lotId: l.id, qty: take, cost });
    rem = qty3(rem - take);
  }
  return { takes, short: rem > 0 ? rem : 0, cost: cents(takes.reduce((s, t) => s + t.cost, 0)) };
}

/** A stored lot on a line, for the checks below. */
export type StoredLineLot = { lot_id: string; bill_line_id: string | null; cost: unknown; live?: boolean; live_moves?: unknown };

/**
 * WHAT EACH LIVE LOT ON ONE BILL SHOULD COST TODAY: shelfLotCost over the bill's lines as they
 * stand. The pure half of restampLotsForBill, and of the daily drift check.
 *   · a lot whose line is gone, is a tax line, or no longer has a positive extension comes OFF
 *     the shelf (a $0.00 extension shipped nothing);
 *   · a lot with takes on it is never restamped - 0304 froze its bill, so it cannot have drifted,
 *     and a stamped take's cost never moves after the fact.
 */
export function restampPlan(
  lots: StoredLineLot[],
  lines: (BillLine & { id: string })[],
): { lotId: string; action: "keep" | "restamp" | "unshelve"; cost: number | null }[] {
  return lots
    .filter((l) => l.live !== false && l.bill_line_id)
    .map((l) => {
      const line = lines.find((x) => String(x.id) === String(l.bill_line_id));
      if (Number(l.live_moves) > 0) return { lotId: l.lot_id, action: "keep" as const, cost: null };
      if (!line || isTaxLine(line) || !(billLineCost(line) > 0)) return { lotId: l.lot_id, action: "unshelve" as const, cost: null };
      const want = shelfLotCost(line, lines);
      return cents(Number(l.cost)) === want
        ? { lotId: l.lot_id, action: "keep" as const, cost: want }
        : { lotId: l.lot_id, action: "restamp" as const, cost: want };
    });
}

/** Lots whose stored cost is not what shelfLotCost gives today: the TypeScript half of
 *  stock_reconcile_problems, for the daily ops check. Empty is the only healthy answer. */
export function lotCostDrift(
  lots: StoredLineLot[],
  lines: (BillLine & { id: string })[],
): { lotId: string; stored: number; today: number }[] {
  const out: { lotId: string; stored: number; today: number }[] = [];
  for (const l of lots) {
    if (l.live === false || !l.bill_line_id) continue;
    const line = lines.find((x) => String(x.id) === String(l.bill_line_id));
    if (!line) continue;
    const today = shelfLotCost(line, lines);
    const stored = cents(Number(l.cost));
    if (stored !== today) out.push({ lotId: l.lot_id, stored, today });
  }
  return out;
}

/** The sentence a put-on-shelf refuses with, or null to go ahead. */
export function putOnShelfProblem(input: { pieces: unknown; unit: unknown; lineAmount: unknown; isTax: boolean; share: number }): string | null {
  const pieces = Number(input.pieces);
  if (!Number.isFinite(pieces) || pieces <= 0) return "Say how many pieces go on the shelf.";
  if (pieces > 1_000_000) return "That count looks too big for one roll. Check it and try again.";
  if (!String(input.unit ?? "").trim()) return "Say what it's counted in (ft, ea).";
  if (input.isTax) return "Sales tax isn't a thing on a shelf. It rides with the lines it was charged on.";
  if (!(Number(input.lineAmount) > 0)) return "That line's extension is $0.00, which means nothing shipped, so nothing from it can go on the shelf.";
  if (!(input.share > 0))
    return "This whole line is still billed to the job. Say how much this job used first, so the rest can go on the shelf.";
  return null;
}

/* ════════════════════════════════════════════════════════════════════════════════════════════
   THE SERVER PART. Not wired to any screen in Phase 1.
   ════════════════════════════════════════════════════════════════════════════════════════════ */

export type ShelfResult = { ok: true; id: string } | { ok: false; error: string };

type Sb = { from: (t: string) => any; rpc?: (fn: string, args?: Record<string, unknown>) => any };

/**
 * PUT WHAT A JOB DID NOT USE OF A RECEIPT LINE ON THE SHELF, as one lot.
 *
 * The line's billed_amount (0272) must already say what the job used: the lot is the REST, costed
 * by shelfLotCost over the bill's lines as they stand. `pieces` and `unit` are what a person
 * confirmed (guessUnit only suggests). The item is either given, or created in the same unit.
 */
export async function putOnShelf(input: {
  lineId: string;
  pieces: number;
  unit: string;
  itemId?: string | null;
  newItem?: { name: string; keyPart?: string | null; priceItemId?: string | null } | null;
}): Promise<ShelfResult> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This is staff-only." };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: "Your sign-in isn't attached to a company, so there's no shelf to put this on." };

  const { data: line, error: lineErr } = await supabase
    .from("bill_line_items")
    .select("id, bill_id")
    .eq("id", input.lineId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (lineErr) return { ok: false, error: dbError(lineErr) };
  if (!line) return { ok: false, error: "That receipt line isn't there any more. Reload and try again." };
  const { data: lines, error: linesErr } = await supabase
    .from("bill_line_items")
    .select("id, description, quantity, unit_price, amount, category, billable, billed_amount")
    .eq("bill_id", (line as { bill_id: string }).bill_id)
    .eq("org_id", orgId);
  if (linesErr) return { ok: false, error: dbError(linesErr) };
  const all = (lines ?? []) as (BillLine & { id: string })[];
  const me = all.find((l) => String(l.id) === String(input.lineId));
  if (!me) return { ok: false, error: "That receipt line isn't there any more. Reload and try again." };
  const share = shelfLotCost(me, all);
  const problem = putOnShelfProblem({ pieces: input.pieces, unit: input.unit, lineAmount: billLineCost(me), isTax: isTaxLine(me), share });
  if (problem) return { ok: false, error: problem };

  let itemId = input.itemId ?? null;
  if (!itemId) {
    const name = String(input.newItem?.name ?? me.description ?? "").trim().slice(0, 200);
    if (!name) return { ok: false, error: "Name the item this goes on the shelf as." };
    const { data: made, error: makeErr } = await supabase
      .from("inventory_items")
      .insert({
        org_id: orgId,
        name,
        unit: String(input.unit).trim(),
        key_part: normalisePartNumber(input.newItem?.keyPart),
        price_item_id: input.newItem?.priceItemId ?? null,
        quantity_on_hand: 0,
        reorder_point: 0,
      })
      .select("id");
    if (makeErr) return { ok: false, error: dbError(makeErr) };
    itemId = (made?.[0]?.id as string | undefined) ?? null;
    if (!itemId) return { ok: false, error: "That item didn't save. Nothing went on the shelf - try again." };
  }

  const { data: lot, error: lotErr } = await supabase
    .from("stock_lots")
    .insert({
      org_id: orgId,
      item_id: itemId,
      kind: "line",
      bill_line_id: input.lineId,
      pieces: qty3(Number(input.pieces)),
      unit: String(input.unit).trim(),
      cost: share,
    })
    .select("id");
  if (lotErr) return { ok: false, error: dbError(lotErr) };
  const id = lot?.[0]?.id as string | undefined;
  if (!id) return { ok: false, error: "That roll didn't go on the shelf. Nothing changed - try again." };
  revalidatePath("/inventory");
  revalidatePath("/bills");
  return { ok: true, id };
}

/**
 * RECOMPUTE EVERY TAKE-LESS LOT ON ONE BILL FROM ITS LINES AS THEY STAND, and clear cost_stale.
 * Every bill-line write path calls this after it writes (Phase 2 wires them). With no lots on the
 * bill it reads one small query and does nothing. Takes the caller's client, so an importer running
 * as the office uses its own session.
 */
export async function restampLotsForBill(
  supabase: Sb,
  orgId: string,
  billId: string,
): Promise<{ ok: true; restamped: number; unshelved: number } | { ok: false; error: string }> {
  const { data: lots, error: lotsErr } = await supabase
    .from("stock_lot_balance")
    .select("lot_id, bill_line_id, cost, live, live_moves")
    .eq("org_id", orgId)
    .eq("bill_id", billId)
    .eq("live", true);
  if (lotsErr) {
    if (isMissingShelf(lotsErr)) return { ok: true, restamped: 0, unshelved: 0 };
    return { ok: false, error: dbError(lotsErr) };
  }
  if (!lots?.length) return { ok: true, restamped: 0, unshelved: 0 };
  const { data: lines, error: linesErr } = await supabase
    .from("bill_line_items")
    .select("id, description, quantity, unit_price, amount, category, billable, billed_amount")
    .eq("bill_id", billId)
    .eq("org_id", orgId);
  if (linesErr) return { ok: false, error: dbError(linesErr) };
  let restamped = 0;
  let unshelved = 0;
  for (const step of restampPlan(lots as StoredLineLot[], (lines ?? []) as (BillLine & { id: string })[])) {
    if (step.action === "keep") {
      // Right already; only the stale flag may need clearing.
      const { error } = await supabase.from("stock_lots").update({ cost_stale: false }).eq("id", step.lotId).eq("org_id", orgId).eq("cost_stale", true).select("id");
      if (error) return { ok: false, error: dbError(error) };
      continue;
    }
    const patch = step.action === "restamp" ? { cost: step.cost, cost_stale: false } : { unshelved_at: new Date().toISOString() };
    const { data, error } = await supabase.from("stock_lots").update(patch).eq("id", step.lotId).eq("org_id", orgId).select("id");
    if (error) return { ok: false, error: dbError(error) };
    if (!data?.length) return { ok: false, error: "A roll from this receipt didn't update. Reload and try again." };
    if (step.action === "restamp") restamped += 1;
    else unshelved += 1;
  }
  return { ok: true, restamped, unshelved };
}

export type TakeResult =
  | { ok: true; drawGroup: string; item: string; unit: string; qty: number; short: number; onHand: number; cost?: number }
  | { ok: false; error: string };

/**
 * TOOK FROM STOCK: the one verb, for the crew and the office alike. Goes through stock_draw, the
 * only way pieces leave the shelf: FIFO across lots under one draw group, a short past the shelf.
 * A tech gets quantities back and never a cost; the database decides that, not this function.
 */
export async function takeFromStock(input: {
  itemId: string;
  jobId: string;
  qty: number;
  note?: string | null;
  source?: "tray" | "bill_line" | "crew" | "office" | "nort";
}): Promise<TakeResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("stock_draw", {
    p_item: input.itemId,
    p_job: input.jobId,
    p_qty: input.qty,
    p_note: input.note ?? null,
    p_source: input.source ?? null,
  });
  if (error) return { ok: false, error: dbError(error) };
  const d = (data ?? {}) as Record<string, unknown>;
  revalidatePath(`/jobs/${input.jobId}`);
  revalidatePath("/inventory");
  return {
    ok: true,
    drawGroup: String(d.draw_group ?? ""),
    item: String(d.item ?? ""),
    unit: String(d.unit ?? ""),
    qty: Number(d.qty ?? 0),
    short: Number(d.short ?? 0),
    onHand: Number(d.on_hand ?? 0),
    ...(d.cost != null ? { cost: Number(d.cost) } : {}),
  };
}

/** Undo a take, until an invoice bills it. The refusal names the invoice to take it off first. */
export async function undoTake(drawGroup: string): Promise<{ ok: true; undone: number } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("stock_undo", { p_group: drawGroup });
  if (error) return { ok: false, error: dbError(error) };
  revalidatePath("/inventory");
  return { ok: true, undone: Number((data as { undone?: unknown } | null)?.undone ?? 0) };
}

