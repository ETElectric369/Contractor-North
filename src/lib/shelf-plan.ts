import { billLineCost, isTaxLine, shelfLotCost, type BillLine } from "@/lib/bill-itemisation";
import {
  containerCountInDescription,
  perUnitCost,
  round2,
  splitContradictsReceipt,
  statedUnitPrice,
  usedCost,
} from "@/app/(app)/bills/receipt-billing";

/**
 * THE SHOP SHELF'S PURE HALF (Shop Stock; moved out of stock-ledger.ts in Phase 2).
 *
 * Everything here is arithmetic and vocabulary, with no database and no session, so the three
 * screens that put things on the shelf (the receipt card's Put The Rest On The Shelf, the tray's
 * Shop Stock destination, and Record To Shelf on a CED document) show a person exactly the figure
 * the server is about to write, from the same function. src/lib/stock-ledger.ts re-exports all of
 * it, so the server half and the tests keep importing from one place.
 *
 * THE LAW THIS FILE KEEPS: the app suggests, a person decides. A count, a unit or an item guessed
 * here only fills a box on a screen. Nothing is written until a person confirms each line.
 */


const cents = (n: number) => Math.round(n * 100) / 100;
const qty3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * round(take x cost / pieces, 2) EXACTLY as Postgres rounds a numeric: on the exact quotient, half
 * away from zero. Float arithmetic cannot do that: 36 of a 40-piece lot costing $0.15 is exactly
 * 13.5 cents, which Postgres rounds to $0.14 and Math.round over binary floats rounds to $0.13. So
 * the three figures are scaled to integers (pieces to the thousandth, dollars to the cent, which is
 * all either column holds) and divided in BigInt. Every input here is non-negative.
 */
export function proRataCents(take: number, cost: number, pieces: number): number {
  const t = BigInt(Math.round(take * 1000));
  const c = BigInt(Math.round(cost * 100));
  const p = BigInt(Math.round(pieces * 1000));
  if (p <= BigInt(0)) return 0;
  // floor((2tc + p) / 2p) = the quotient t*c/p rounded half up, in cents.
  const q = (BigInt(2) * t * c + p) / (BigInt(2) * p);
  return Number(q) / 100;
}

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
    const cost = take === left ? cents(l.costLeft) : Math.min(proRataCents(take, l.cost, l.pieces), cents(l.costLeft));
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
 *     the shelf (a $0.00 extension shipped nothing), and so does one whose line the job now bills
 *     in full (its share is $0: nothing of it is left for a shelf);
 *   · a lot with takes on it is never restamped - 0304 froze its bill, so it cannot have drifted,
 *     and a stamped take's cost never moves after the fact. Its step is "keep" with cost null: it
 *     was not checked, so nothing may call it right (restampLotsForBill leaves its stale flag).
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
      if (!(want > 0)) return { lotId: l.lot_id, action: "unshelve" as const, cost: null };
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
   PUTTING THINGS ON THE SHELF (Phase 2)
   ════════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * IS THIS BILL A SHELF TICKET? The flag (bills.on_shelf, 0303) is what the money reads; the
 * category "Shop Stock" is what the doors write beside it, so a screen that only has the category
 * still names it right. Never a business-cost bucket: bucketOf would call the word "Other".
 */
export function isShelfTicket(b: { on_shelf?: boolean | null; category?: string | null }): boolean {
  return b.on_shelf === true || String(b.category ?? "").trim().toLowerCase() === "shop stock";
}

/** What a roll or a box is counted in. A person picks one; the item keeps it for good (0303). */
export const SHELF_UNITS = ["ft", "ea", "box", "roll"] as const;

/** The tray's refusal for a ticket with no lines (the plan's own sentence). */
export const SHELF_NEEDS_LINES = "Add the lines first, so pieces can be taken from it.";

/** A return is money coming back, not a roll going on the shelf. */
export const SHELF_NO_RETURNS =
  "A return goes back against the roll it came from, which comes in a later update. File it on its job or as a business cost.";

export type ShelfCountGuess = {
  /** Pieces the line bought, in `unit` (250 for a 250 ft coil), or null when the ticket doesn't say. */
  pieces: number | null;
  unit: string | null;
  /** How many units the ticket's own quantity column counts (1 coil, or 250 feet): the figure the
   *  count is checked against the receipt's price column with (splitContradictsReceipt). */
  bought: number;
  why: string;
};

/**
 * THE COUNT A TICKET LINE SUGGESTS, filled into the box and never saved on its own.
 *
 * Read in this order, and only from what the ticket prints:
 *   · when the ticket's own columns close (quantity x unit price = the extension, statedUnitPrice),
 *     the quantity is what the ticket counted: "NMB 12/2 250 ft coil", 250 at $0.66, is 250 ft;
 *     "NMB 6/3 (1000 ft REEL)", 55 at $4.32, is 55 ft cut off a reel, never 1,000; a line of 2
 *     coils at $165 each is 2 x 250 = 500 ft (a small whole quantity times what one holds);
 *   · otherwise what one container holds, when the description says it (a 250 ft coil, a PK100,
 *     a 500/BX), as one of them;
 *   · otherwise nothing, and the person types it.
 * The unit comes from the same place (guessUnit), else "ea" when a count was found.
 */
export function shelfCountGuess(
  line: { description?: string | null; quantity?: unknown; unit_price?: unknown; amount?: unknown },
  priceListUnit?: string | null,
): ShelfCountGuess {
  const qty = Number(line.quantity) || 0;
  const g = guessUnit(line.description, priceListUnit);
  const stated = statedUnitPrice(qty, Number(line.unit_price), Number(line.amount));
  const per = g.perContainer ?? containerCountInDescription(line.description);
  const unit = g.unit ?? (per || stated != null ? "ea" : null);
  if (stated != null && qty > 0) {
    // The ticket counted containers: a few of them, each holding `per`.
    if (per && qty !== per && Number.isInteger(qty) && qty <= 10) {
      return { pieces: qty * per, unit, bought: qty, why: `the ticket sold ${qty}, ${per} ${unit ?? ""} in each`.replace(/\s+/g, " ") };
    }
    return { pieces: qty, unit, bought: qty, why: `the ticket counted ${qty}${unit ? ` ${unit}` : ""}` };
  }
  if (per) return { pieces: per, unit, bought: 1, why: `the description says ${per}${unit ? ` ${unit}` : ""} in one` };
  return { pieces: null, unit, bought: 1, why: "the ticket doesn't say how many; type it" };
}

/** One line going on the shelf, as a person confirmed it. */
export type ShelfPick = {
  lineId: string;
  /** Pieces the line bought, in `unit` (250 for a 250 ft coil). */
  pieces: number;
  /** Pieces THIS job used: 0 for a ticket bought for the shelf, or a coil the job never touched. */
  used: number;
  unit: string;
  /** How many units the receipt's quantity column counts (see ShelfCountGuess.bought). */
  bought?: number | null;
  /** An existing item on the shelf, or a new one by this name. */
  itemId?: string | null;
  newItemName?: string | null;
  /** The supplier's part number, when the paper prints one: the new item is matched on it later. */
  keyPart?: string | null;
};

/** One lot, worked out before anything is written: what the job is billed, and what the roll costs. */
export type PlannedLot = {
  lineId: string;
  /** billed_amount for the line: the dollars of it THIS job used (0 when it used none). */
  billedAmount: number;
  /** Pieces that go on the shelf (bought - used). */
  pieces: number;
  unit: string;
  /** shelfLotCost over the ticket's lines as they will stand: the line's rest plus its tax share. */
  cost: number;
  itemId: string | null;
  newItemName: string | null;
  keyPart: string | null;
};

const unitOf = (raw: unknown) => String(raw ?? "").trim().toLowerCase().slice(0, 20);
const lineLabel = (l: { description?: string | null }) => String(l.description ?? "").trim() || "That line";

/**
 * EVERY LOT ON ONE TICKET, WORKED OUT IN MEMORY FIRST (the pure half of shelveLines).
 *
 * The billed_amount of every picked line is set on a COPY of the ticket's lines, and each lot is
 * costed by shelfLotCost over that copy, so the tax share is the one the ticket will actually have
 * once every answer is in (tax is shared across every line that comes off, in proportion). The
 * database then writes the same numbers in one transaction (shelve_bill_lines, 0328) and caps them
 * at the paper again. A refusal here is the sentence the person sees, and nothing has been written.
 */
export function planShelving(
  lines: (BillLine & { id: string })[],
  picks: ShelfPick[],
): { ok: true; lots: PlannedLot[]; patched: (BillLine & { id: string })[] } | { ok: false; error: string } {
  if (!picks.length) return { ok: false, error: "Say what goes on the shelf first." };
  const answers = new Map<string, { pick: ShelfPick; billedAmount: number; pieces: number; unit: string }>();
  for (const pick of picks) {
    const id = String(pick.lineId ?? "");
    if (!id || answers.has(id)) return { ok: false, error: "Each line goes on the shelf once. Reload and try again." };
    const line = lines.find((l) => String(l.id) === id);
    if (!line) return { ok: false, error: "A line on this ticket isn't there any more. Reload and try again." };
    const label = lineLabel(line);
    if (isTaxLine(line)) return { ok: false, error: "Sales tax isn't a thing on a shelf. It rides with the lines it was charged on." };
    if (isFreightLine(line)) return { ok: false, error: "Freight isn't a thing on a shelf. It stays with the ticket it was charged on." };
    const cost = billLineCost(line);
    if (!(cost > 0))
      return { ok: false, error: `${label}: its extension is $0.00, which means nothing shipped, so nothing from it can go on the shelf.` };
    const total = Number(pick.pieces);
    const used = Number(pick.used ?? 0);
    const unit = unitOf(pick.unit);
    if (!Number.isFinite(total) || total <= 0) return { ok: false, error: `${label}: say how many it bought.` };
    if (total > 1_000_000) return { ok: false, error: `${label}: that count looks too big for one roll. Check it and try again.` };
    if (!Number.isFinite(used) || used < 0) return { ok: false, error: `${label}: say how many this job used (0 if none).` };
    if (used >= total) return { ok: false, error: `${label}: this job used all of it, so nothing is left for the shelf.` };
    if (!unit) return { ok: false, error: `${label}: say what it's counted in (ft, ea, box, roll).` };
    if (used > 0 && line.billable === false)
      return {
        ok: false,
        error: `${label} is off the customer's bill. Switch it back on to bill what this job used, or put all of it on the shelf (0 used).`,
      };
    if (!pick.itemId && !String(pick.newItemName ?? "").trim())
      return { ok: false, error: `${label}: pick the item it goes on the shelf as, or name a new one.` };
    // The receipt's own price column is the witness to the "1000' REEL, qty 55" counter cut: a
    // count that would make one purchased unit cost something the paper never charged is refused.
    const objection = splitContradictsReceipt({
      cost,
      quantity: Number(line.quantity),
      unitPrice: Number(line.unit_price),
      boughtQuantity: pick.bought == null ? null : Number(pick.bought),
      pieces: total,
    });
    if (objection) return { ok: false, error: `${label}: ${objection}` };
    const billedAmount = used > 0 ? usedCost(used, perUnitCost(cost, total)) : 0;
    if (!(billedAmount < round2(cost)))
      return { ok: false, error: `${label}: what this job used comes to the whole line, so nothing is left for the shelf.` };
    answers.set(id, { pick, billedAmount, pieces: Math.round((total - used) * 1000) / 1000, unit });
  }
  const patched = lines.map((l) => {
    const a = answers.get(String(l.id));
    return a ? { ...l, billed_amount: a.billedAmount } : l;
  });
  const lots: PlannedLot[] = [];
  for (const l of patched) {
    const a = answers.get(String(l.id));
    if (!a) continue;
    const share = shelfLotCost(l, patched);
    const problem = putOnShelfProblem({ pieces: a.pieces, unit: a.unit, lineAmount: billLineCost(l), isTax: isTaxLine(l), share });
    if (problem) return { ok: false, error: `${lineLabel(l)}: ${problem}` };
    lots.push({
      lineId: String(l.id),
      billedAmount: a.billedAmount,
      pieces: a.pieces,
      unit: a.unit,
      cost: share,
      itemId: a.pick.itemId ?? null,
      newItemName: a.pick.itemId ? null : String(a.pick.newItemName ?? "").trim().slice(0, 200),
      keyPart: normalisePartNumber(a.pick.keyPart),
    });
  }
  return { ok: true, lots, patched };
}

/**
 * THE ROLLS ALREADY ON A TICKET, AS THEY MUST STAND ONCE NEW ROLLS COME OFF IT: every take-less
 * roll the paper was checked against, at its share over the ticket's lines as they will stand. The
 * billed_amount writes inside shelve_bill_lines mark every roll on the ticket stale (0304), so a roll
 * whose cents did not move is sent too: writing it clears the flag, in the same transaction. A roll
 * with takes on it is never here (its ticket is frozen, 0304, and the write would be refused).
 */
export function restampPayload(live: StoredLineLot[], patched: (BillLine & { id: string })[]): { lot_id: string; cost: number }[] {
  return restampPlan(live, patched)
    .filter((s) => (s.action === "restamp" || s.action === "keep") && s.cost != null)
    .map((s) => ({ lot_id: s.lotId, cost: s.cost as number }));
}

/** A person's answer for one line of a ticket filed to the shelf, keyed by the line's place on it. */
export type TicketLineChoice =
  | { index: number; notStock: true }
  | {
      index: number;
      notStock?: false;
      pieces: number;
      unit: string;
      bought?: number | null;
      itemId?: string | null;
      newItemName?: string | null;
      keyPart?: string | null;
    };

/** A freight or shipping charge (supplierBillLines writes category "Freight"). Never a thing on a
 *  shelf: on a shelf ticket it has no roll and counts as Tools & Supplies (owner-money.ts). */
export function isFreightLine(row: { description?: string | null; category?: string | null }): boolean {
  return /freight|shipping/i.test(String(row.category ?? "")) || /^\s*(freight|shipping)\b/i.test(String(row.description ?? ""));
}

/** Does this ticket line need a person's answer before the ticket can go on the shelf? Tax lines,
 *  freight and $0.00 lines ride along with no answer. */
export function lineNeedsShelfAnswer(row: { description?: string | null; amount?: unknown; category?: string | null }): boolean {
  return !isTaxLine(row as BillLine) && !isFreightLine(row) && Number(row.amount) > 0;
}

/**
 * THE WHOLE-TICKET GATE, asked by the tray's File It button and again by the server: every line a
 * person could put on the shelf has an answer (a count, or Not Stock), and at least one goes on it.
 * Null means go.
 */
export function ticketShelfProblem(
  rows: { description?: string | null; amount?: unknown; category?: string | null }[],
  total: number | null,
  choices: TicketLineChoice[] | null | undefined,
): string | null {
  if (total != null && Number(total) < 0) return SHELF_NO_RETURNS;
  if (!rows.length) return SHELF_NEEDS_LINES;
  const byIndex = new Map((choices ?? []).map((c) => [Number(c.index), c]));
  const open = rows.filter((r, i) => lineNeedsShelfAnswer(r) && !byIndex.has(i));
  if (open.length)
    return `Say for every line how many go on the shelf, or tap Not Stock. ${open.length === 1 ? "1 line is" : `${open.length} lines are`} still open.`;
  const toShelf = (choices ?? []).filter((c) => !c.notStock);
  if (!toShelf.length) return "Every line is Not Stock, so nothing would go on the shelf. File it on a job or as a business cost instead.";
  for (const c of toShelf) {
    if (c.notStock) continue;
    const row = rows[Number(c.index)];
    if (!row) return "A line on this ticket isn't there any more. Reload and try again.";
    if (!lineNeedsShelfAnswer(row)) return `${lineLabel(row)}: only a line that shipped something can go on the shelf.`;
    if (!(Number(c.pieces) > 0)) return `${lineLabel(row)}: say how many go on the shelf.`;
    if (!unitOf(c.unit)) return `${lineLabel(row)}: say what it's counted in (ft, ea, box, roll).`;
    if (!c.itemId && !String(c.newItemName ?? "").trim()) return `${lineLabel(row)}: pick the item it goes on the shelf as, or name a new one.`;
  }
  return null;
}

/** An item on the shelf, as a picker needs it (never a cost: a picker is a name and a unit). */
export type ShelfPickerItem = {
  id: string;
  name: string;
  unit: string;
  key_part?: string | null;
  part_number?: string | null;
  price_item_id?: string | null;
  created_at?: string | null;
};

/**
 * WHICH ITEM TO PRE-SELECT FOR A LINE: only an exact part number or an exact name (matchItem), and
 * only when it is counted in the same unit. Anything else starts on a new item with the line's own
 * words, and the person picks.
 */
export function suggestShelfItem(
  items: ShelfPickerItem[],
  line: { description?: string | null; partNumber?: string | null },
  unit: string | null,
): { id: string; why: string } | null {
  const m = matchItem(items, { partNumber: line.partNumber ?? null, description: String(line.description ?? "") });
  if (m.kind !== "match") return null;
  const it = items.find((i) => i.id === m.id);
  if (!it || (unit && unitOf(it.unit) !== unitOf(unit))) return null;
  return { id: m.id, why: m.why };
}

/* ── WAITING FOR THE SHELF: suggested, never moved ─────────────────────────────────────────── */

export type WaitingLineIn = {
  lineId: string;
  billId: string;
  jobId: string | null;
  jobLabel: string | null;
  description: string;
  quantity: unknown;
  amount: unknown;
  category: string | null;
  billable: boolean;
  billedAmount: unknown;
  hasLot: boolean;
  billDate?: string | null;
  /** The sent or paid invoice that already bills this receipt (or the order it delivered), as
   *  "INV-069 (paid)". The receipt card has no Put The Rest On The Shelf there, so neither does this. */
  heldBy?: string | null;
};

export type WaitingItem = {
  key: string;
  kind: "part_billed" | "container" | "stock_document" | "lineless_paper";
  title: string;
  why: string;
  /** Where the person acts on it, and the button they press there. Null when there is no such
   *  button yet (a receipt a customer already holds): the card says so instead of sending anyone
   *  to a door that isn't there. */
  href: string | null;
  door: string | null;
};

const CONTAINER_WORD = /\b(?:case|carton|spool|spl|roll|reel|coil|jar|tub|pail|bucket|drum|bag)\b/i;
const dollars = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

/**
 * WHAT PROBABLY BELONGS ON THE SHELF, listed and never moved (the plan's read-only card). Signals,
 * strongest first:
 *   · a job's receipt line billed only in part (or "0 used") with nothing on the shelf from it -
 *     the Herringbone 14/2 coil: the customer isn't paying for it and the job still carries it;
 *   · a job's receipt line that reads like a coil, a reel or a box (a container word, a count in
 *     its description, or a quantity over fifty) billed in full with nothing on the shelf - the
 *     Waldow Twister box;
 *   · a CED document whose job box says STOCK and that no bill covers yet;
 *   · a paper in the tray that says STOCK but was read with no lines.
 */
export function waitingForShelf(input: {
  lines: WaitingLineIn[];
  /** `accountId`: the supplier account it is on, so the door lands on that supplier's Not In Your
   *  Books list on /bills (the only home of Record To Shelf), not the top of the page. */
  stockDocuments?: {
    id: string;
    number: string;
    total: unknown;
    words: string;
    accountId?: string | null;
    /**
     * Where it stands on /bills (supplierPaperHomes, audit v1018 class 14): Record To Shelf is only
     * offered when the supplier's Not In Your Books fold holds it. "unchecked": that reading
     * failed. Absent reads as the fold.
     */
    home?: "not_in_books" | "on_card" | "waiting" | "before_books" | "unchecked";
  }[];
  linelessPapers?: { id: string; title: string; words: string }[];
}): WaitingItem[] {
  const out: WaitingItem[] = [];
  for (const l of input.lines) {
    if (l.hasLot || !l.jobId) continue;
    const line = { description: l.description, quantity: Number(l.quantity), unit_price: 0, amount: Number(l.amount), category: l.category } as BillLine;
    const cost = billLineCost(line);
    if (isTaxLine(line) || !(cost > 0)) continue;
    const where = `${l.jobLabel ?? "a job"}${l.billDate ? `, ${String(l.billDate).slice(0, 10)}` : ""}`;
    const billed = l.billedAmount == null || l.billedAmount === "" ? null : Number(l.billedAmount);
    // A receipt the customer already holds: named, with no door (the receipt card has none there).
    const held = l.heldBy ? ` It's on ${l.heldBy}, which the customer already has, so it can't go on the shelf from here yet.` : "";
    const door = (d: string) => (l.heldBy ? { href: null, door: null } : { href: `/bills#bill-${l.billId}`, door: d });
    if (l.billable !== false && billed != null && billed < cost) {
      out.push({
        key: `line:${l.lineId}`,
        kind: "part_billed",
        title: `${l.description} (${where})`,
        why:
          billed === 0
            ? `None of its ${dollars(cost)} is billed to the customer, and the job still carries all of it.${held}`
            : `The customer is billed ${dollars(billed)} of its ${dollars(cost)}, and the job still carries the rest.${held}`,
        ...door("Put The Rest On The Shelf"),
      });
      continue;
    }
    if (l.billable === false || billed != null) continue;
    const words = CONTAINER_WORD.test(l.description);
    const counted = containerCountInDescription(l.description) != null;
    const bigQty = Number(l.quantity) > 50;
    if (!words && !counted && !bigQty) continue;
    out.push({
      key: `line:${l.lineId}`,
      kind: "container",
      title: `${l.description} (${where})`,
      why: (words
        ? `Reads like a coil, a reel or a box, and all ${dollars(cost)} of it is billed to that job.`
        : counted
          ? `Its description counts what's in it, and all ${dollars(cost)} of it is billed to that job.`
          : `The ticket read ${Number(l.quantity)} on it, which is usually a box or a coil, and all ${dollars(cost)} is billed to that job.`) + held,
      ...door("Put The Rest On The Shelf"),
    });
  }
  for (const d of input.stockDocuments ?? []) {
    const title = `CED ${d.number}, ${dollars(Number(d.total) || 0)}`;
    const base = { key: `doc:${d.id}`, kind: "stock_document" as const, title };
    // A DOOR ONLY WHERE THE BUTTON IS (audit v1018, class 14): the fold that holds Record To Shelf
    // lists a paper only when /bills would (supplierPaperHomes). Anywhere else, the door goes where
    // this paper's own buttons are, or the card says why there is none.
    if (d.home === "on_card") {
      out.push({ ...base, why: `"${d.words}" is written on it, and it's waiting under Needs You on Bills, where Shop Stock puts it on the shelf.`, href: "/bills#needs-you", door: "Open Needs You" });
      continue;
    }
    if (d.home === "waiting") {
      out.push({
        ...base,
        why: `"${d.words}" is written on it, and it's set aside on Bills waiting on a credit.`,
        href: d.accountId ? `/bills#supplier-waiting-credit-${d.accountId}` : "/bills",
        door: "Open Waiting On A Credit",
      });
      continue;
    }
    if (d.home === "before_books") {
      out.push({
        ...base,
        why: `"${d.words}" is written on it, but it's from before your books here began, so Bills has no Record To Shelf for it. If its roll is still on the shelf, add the roll by hand.`,
        href: null,
        door: null,
      });
      continue;
    }
    if (d.home === "unchecked") {
      out.push({
        ...base,
        why: `"${d.words}" is written on it. Couldn't check your books just now, so it may already be recorded; its supplier's own lists on Bills say.`,
        href: d.accountId ? `/bills#supplier-invoices-${d.accountId}` : "/bills",
        door: "Open It On Bills",
      });
      continue;
    }
    out.push({
      ...base,
      why: `"${d.words}" is written on it, and no bill covers it yet.`,
      // Record To Shelf lives two folds deep (the supplier's line, then Not In Your Books):
      // FoldOpener opens both. With no account, the page's own top is the best it can do.
      href: d.accountId ? `/bills#supplier-not-in-books-${d.accountId}` : "/bills",
      door: "Record To Shelf",
    });
  }
  for (const p of input.linelessPapers ?? []) {
    out.push({
      key: `paper:${p.id}`,
      kind: "lineless_paper",
      title: p.title,
      why: `"${p.words}" is written on it, but it was read with no lines, and a roll on the shelf is a line. Read it again so its lines come with it.`,
      href: "/organize",
      door: "Read Again",
    });
  }
  return out;
}
