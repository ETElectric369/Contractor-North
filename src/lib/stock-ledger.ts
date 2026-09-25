import "server-only";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff-guard";
import { createClient } from "@/lib/supabase/server";
import { dbError } from "@/lib/db-error";
import { type BillLine } from "@/lib/bill-itemisation";
import { isMissingShelf } from "@/lib/job-cost";
import {
  SHELF_NEEDS_LINES,
  matchItem,
  planShelving,
  restampPayload,
  restampPlan,
  type ShelfPick,
  type ShelfPickerItem,
  type StoredLineLot,
} from "@/lib/shelf-plan";

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
 * Phase 2 wires the doors that put a roll ON the shelf (shelveLines: the receipt card, the tray,
 * Record To Shelf) and the office's Count It; the doors that take a piece OFF it (takeFromStock)
 * arrive with their screens in Phase 3.
 *
 * This is deliberately NOT a "use server" module (same reason as bill-itemisation.ts): the pure
 * half has to be importable by tests. Call the server functions from your own action.
 */

/* ════════════════════════════════════════════════════════════════════════════════════════════
   THE PURE PART lives in src/lib/shelf-plan.ts (Phase 2): the tray row, the receipt card and the
   Record To Shelf sheet are client components and need the same unit guess and item match the
   server uses, and this file is server-only. Re-exported here so every existing import holds.
   ════════════════════════════════════════════════════════════════════════════════════════════ */

export * from "@/lib/shelf-plan";

/* ════════════════════════════════════════════════════════════════════════════════════════════
   THE SERVER PART.
   ════════════════════════════════════════════════════════════════════════════════════════════ */

type Sb = { from: (t: string) => any; rpc?: (fn: string, args?: Record<string, unknown>) => any };

/** 0328 not on this database yet: said in words, never a raw "function does not exist". */
export const SHELF_NEEDS_0328 =
  "Putting things on the shelf needs one more database update (0328) that hasn't been applied yet. Nothing was changed.";

/** PostgREST's answer for an RPC the database doesn't have. */
export function isMissingShelfRpc(err: unknown): boolean {
  const code = String((err as { code?: string } | null)?.code ?? "");
  const msg = String((err as { message?: string } | null)?.message ?? "");
  return code === "PGRST202" || code === "42883" || /could not find the function/i.test(msg) || /function .* does not exist/i.test(msg);
}

const LINE_COLUMNS = "id, description, quantity, unit_price, amount, category, billable, billed_amount";

export type ShelvedLot = { lotId: string; itemId: string; lineId: string; cost: number; pieces: number; unit: string; billedAmount: number };
export type ShelveResult = { ok: true; lots: ShelvedLot[]; billId: string } | { ok: false; error: string };

/**
 * PUT ONE TICKET'S ROLLS ON THE SHELF: the one server door every Phase 2 screen goes through (the
 * receipt card, the tray, Record To Shelf).
 *
 *   1. read the ticket's lines, and the rolls already on the shelf from it;
 *   2. an item named new is matched first, exactly (part number, then name, never fuzzy), so the
 *      second coil of 12/2 lands on the SAME item rather than a twin; a match counted in another
 *      unit is refused in words;
 *   3. planShelving works out, in memory, what each job used and what each roll costs over the
 *      lines as they will stand; the rolls already on the ticket are restamped to their new share
 *      in the same breath (tax is re-shared once more lines come off);
 *   4. shelve_bill_lines (0328) writes all of it in one transaction, capped at the paper again.
 *
 * Takes the caller's client: every write runs as the signed-in person, under the tables' own rules.
 */
export async function shelveLines(supabase: Sb, orgId: string, billId: string, picks: ShelfPick[]): Promise<ShelveResult> {
  if (!supabase.rpc) return { ok: false, error: "This connection can't put things on the shelf." };
  const [{ data: lines, error: linesErr }, { data: lots, error: lotsErr }] = await Promise.all([
    supabase.from("bill_line_items").select(LINE_COLUMNS).eq("bill_id", billId).eq("org_id", orgId).order("sort_order"),
    supabase.from("stock_lot_balance").select("lot_id, bill_line_id, cost, live, live_moves").eq("org_id", orgId).eq("bill_id", billId).eq("live", true),
  ]);
  if (linesErr) return { ok: false, error: dbError(linesErr) };
  if (lotsErr) return { ok: false, error: isMissingShelf(lotsErr) ? SHELF_NEEDS_0328 : dbError(lotsErr) };
  const all = (lines ?? []) as (BillLine & { id: string })[];
  if (!all.length) return { ok: false, error: SHELF_NEEDS_LINES };
  const live = (lots ?? []) as StoredLineLot[];
  for (const p of picks) {
    if (live.some((l) => String(l.bill_line_id) === String(p.lineId)))
      return { ok: false, error: "A roll from that line is already on the shelf. Take it off the shelf first to count it again." };
  }

  // Exact matches only, and only for an item a person named new: a picked item is theirs.
  const named = picks.filter((p) => !p.itemId);
  let resolved = picks;
  if (named.length) {
    const { data: items, error: itemsErr } = await supabase
      .from("inventory_items")
      .select("id, name, unit, key_part, part_number, price_item_id, created_at")
      .eq("org_id", orgId);
    if (itemsErr) return { ok: false, error: dbError(itemsErr) };
    const candidates = (items ?? []) as ShelfPickerItem[];
    const out: ShelfPick[] = [];
    for (const p of picks) {
      if (p.itemId) {
        const it = candidates.find((c) => c.id === p.itemId);
        if (it && String(it.unit).trim().toLowerCase() !== String(p.unit).trim().toLowerCase())
          return { ok: false, error: `${it.name} is counted in ${it.unit}. Count this in ${it.unit}, or make a new item for ${p.unit}.` };
        out.push(p);
        continue;
      }
      const m = matchItem(candidates, { partNumber: p.keyPart ?? null, description: String(p.newItemName ?? "") });
      if (m.kind === "match") {
        const it = candidates.find((c) => c.id === m.id)!;
        if (String(it.unit).trim().toLowerCase() !== String(p.unit).trim().toLowerCase())
          return {
            ok: false,
            error: `${it.name} is already on the shelf, counted in ${it.unit} (${m.why}). Count this in ${it.unit}, or give it a different name.`,
          };
        out.push({ ...p, itemId: it.id, newItemName: null });
      } else out.push(p);
    }
    resolved = out;
  } else {
    // Picked items still have to be this company's and in this unit; the database says so too.
    const ids = Array.from(new Set(picks.map((p) => String(p.itemId))));
    const { data: items, error: itemsErr } = await supabase.from("inventory_items").select("id, name, unit").eq("org_id", orgId).in("id", ids);
    if (itemsErr) return { ok: false, error: dbError(itemsErr) };
    for (const p of picks) {
      const it = ((items ?? []) as { id: string; name: string; unit: string }[]).find((i) => i.id === p.itemId);
      if (!it) return { ok: false, error: "That item isn't on this company's shelf any more. Reload and pick again." };
      if (String(it.unit).trim().toLowerCase() !== String(p.unit).trim().toLowerCase())
        return { ok: false, error: `${it.name} is counted in ${it.unit}. Count this in ${it.unit}, or make a new item for ${p.unit}.` };
    }
  }

  const plan = planShelving(all, resolved);
  if (!plan.ok) return plan;
  const restamp = restampPayload(live, plan.patched);

  const { data, error } = await supabase.rpc("shelve_bill_lines", {
    p_bill: billId,
    p_lines: plan.lots.map((l) => ({
      line_id: l.lineId,
      billed_amount: l.billedAmount,
      pieces: l.pieces,
      unit: l.unit,
      cost: l.cost,
      item_id: l.itemId,
      item_name: l.newItemName,
      key_part: l.keyPart,
    })),
    p_restamp: restamp,
  });
  if (error) return { ok: false, error: isMissingShelfRpc(error) ? SHELF_NEEDS_0328 : dbError(error) };
  const wrote = ((data as { lots?: { lot_id: string; item_id: string; line_id: string }[] } | null)?.lots ?? []) as {
    lot_id: string;
    item_id: string;
    line_id: string;
  }[];
  if (wrote.length !== plan.lots.length) return { ok: false, error: "The shelf didn't take every roll. Reload to see where it stands." };
  // Anything the plan did not restamp (a roll whose line itself changed) is put right the usual way.
  await restampLotsForBill(supabase, orgId, billId);
  revalidatePath("/inventory");
  revalidatePath("/bills");
  return {
    ok: true,
    billId,
    lots: plan.lots.map((l) => {
      const w = wrote.find((x) => String(x.line_id) === l.lineId);
      return { lotId: String(w?.lot_id ?? ""), itemId: String(w?.item_id ?? ""), lineId: l.lineId, cost: l.cost, pieces: l.pieces, unit: l.unit, billedAmount: l.billedAmount };
    }),
  };
}

export type ShelfResult = { ok: true; id: string; lot: ShelvedLot } | { ok: false; error: string };

/**
 * PUT THE REST ON THE SHELF, for one receipt line (the receipt card's door): `used` of `pieces` went
 * into this job and is billed to it; the rest goes on the shelf at its share of the ticket.
 */
export async function putOnShelf(input: ShelfPick): Promise<ShelfResult> {
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
  const res = await shelveLines(supabase, orgId, String((line as { bill_id: string }).bill_id), [input]);
  if (!res.ok) return res;
  return { ok: true, id: res.lots[0].lotId, lot: res.lots[0] };
}

/**
 * TAKE A ROLL BACK OFF THE SHELF, before anything has been taken from it (0304 refuses after, and
 * says which takes to undo). The roll stays in the shelf's history as taken off; its dollars go
 * back onto the job whose ticket it came off. What that job's customer is billed does not move.
 */
export async function unshelveLot(lotId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This is staff-only." };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: "Your sign-in isn't attached to a company." };
  const { data, error } = await supabase
    .from("stock_lots")
    .update({ unshelved_at: new Date().toISOString() })
    .eq("id", lotId)
    .eq("org_id", orgId)
    .is("unshelved_at", null)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "That roll is already off the shelf. Reload to see where it stands." };
  revalidatePath("/inventory");
  revalidatePath("/bills");
  return { ok: true };
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
      // A lot with takes was never checked (cost null): its stale flag, if any, stays for the
      // reconcile view to name. Only a lot the paper was just checked against is called right.
      if (step.cost == null) continue;
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

