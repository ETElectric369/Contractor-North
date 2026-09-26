"use server";
import { dbError } from "@/lib/db-error";

import { revalidatePath } from "next/cache";
import { emptyToNull } from "@/lib/forms";
import { requireStaff } from "@/lib/staff-guard";
import { SHELF_NEEDS_0328, isMissingShelfRpc, undoTake, unshelveLot } from "@/lib/stock-ledger";
import type { ShelfPickerItem } from "@/lib/shelf-plan";
import { isMissingCreditColumn, isMissingShelf } from "@/lib/job-cost";
import { canTieToShelfReturn, shelfReturnMoney } from "@/lib/supplier-returns";
import { formatCurrency } from "@/lib/utils";

export type Result = { ok: boolean; error?: string; id?: string };

/** Every write here org-scopes by id AND asks for the row back.
 *
 *  WHAT THESE NO LONGER WRITE (Shop Stock, 0303): quantity_on_hand, which the shelf's record keeps
 *  (a typed number is refused by the database), and unit_cost, which lives per purchase on the lots
 *  now, to the cent. An item is its name, part number, category, unit, reorder point, vendor and
 *  where it lives.
 *
 *  THE SILENT-WRITE LAW, and why this file needed it. A PostgREST update that matches no row is a
 *  204: no error, no rows, and the code above reads it as saved. Before cn-v964 all four actions
 *  checked only `error`, so an item belonging to another org (or one deleted in another tab) came
 *  back from "Save changes" looking saved and was not. That mattered little while the table had
 *  zero rows in it; the shelf now keeps real counts and real costs (lib/stock-ledger.ts, 0303), so
 *  these are about to be numbers Erik orders against. `.select("id")` on every write, zero rows is a failure. */
const NO_ORG = "Your sign-in isn't attached to a company yet, so there's no stock list to change.";

export async function createInventoryItem(formData: FormData): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Name is required." };

  const { data, error } = await supabase
    .from("inventory_items")
    .insert({
      org_id: orgId,
      name,
      part_number: emptyToNull(formData.get("part_number")),
      category: emptyToNull(formData.get("category")),
      unit: String(formData.get("unit") ?? "ea") || "ea",
      reorder_point: Number(formData.get("reorder_point")) || 0,
      vendor: emptyToNull(formData.get("vendor")),
      location: emptyToNull(formData.get("location")),
    })
    .select("id");

  if (error) return { ok: false, error: dbError(error) };
  const id = data?.[0]?.id as string | undefined;
  if (!id) return { ok: false, error: "That item didn't save. Nothing was added - try again." };

  // ALREADY ON THE SHELF: its first roll, counted in (an opening roll: a count, a typed cost and a
  // note). Checked before it is written, and a refusal says the item itself was made.
  const openingPieces = Number(formData.get("opening_pieces")) || 0;
  if (openingPieces > 0) {
    const roll = await addOpeningRoll({
      itemId: id,
      pieces: openingPieces,
      cost: Number(formData.get("opening_cost")) || 0,
      note: String(formData.get("opening_note") ?? ""),
    });
    if (!roll.ok) {
      revalidatePath("/inventory");
      return { ok: false, id, error: `The item is made, but its roll didn't go on the shelf: ${roll.error} Add it from the item's row with Add A Roll Counted In.` };
    }
  }
  revalidatePath("/inventory");
  return { ok: true, id };
}

export async function updateInventoryItem(id: string, formData: FormData): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  const name = String(formData.get("name") ?? "").trim();
  if (!name) return { ok: false, error: "Name is required." };

  const { data, error } = await supabase
    .from("inventory_items")
    .update({
      name,
      part_number: emptyToNull(formData.get("part_number")),
      category: emptyToNull(formData.get("category")),
      unit: String(formData.get("unit") ?? "ea") || "ea",
      reorder_point: Number(formData.get("reorder_point")) || 0,
      vendor: emptyToNull(formData.get("vendor")),
      location: emptyToNull(formData.get("location")),
    })
    .eq("id", id)
    .eq("org_id", orgId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "That item isn't there any more. Reload the page and try again." };
  revalidatePath("/inventory");
  return { ok: true };
}

export async function deleteInventoryItem(id: string): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  const { data, error } = await supabase
    .from("inventory_items")
    .delete()
    .eq("id", id)
    .eq("org_id", orgId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "That item was already gone. The list is up to date." };
  revalidatePath("/inventory");
  return { ok: true };
}

/**
 * MARK INACTIVE / MAKE ACTIVE (review of Phase 2). An item with rolls or moves on the shelf's record
 * can never be deleted (0304 keeps its history), and that refusal names this door, so it has to
 * exist. Inactive hides the item from Shop Stock and the pickers; it never hides money, so an item
 * with anything still on the shelf is refused until it is counted to 0. A roll that later lands on
 * the item makes it active again (shelve_bill_lines, 0328).
 */
export async function setInventoryItemActive(id: string, active: boolean): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  if (!active) {
    const { data: item, error: itemErr } = await supabase
      .from("inventory_items")
      .select("id, name, unit, quantity_on_hand")
      .eq("id", id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (itemErr) return { ok: false, error: dbError(itemErr) };
    if (!item) return { ok: false, error: "That item isn't there any more. Reload the page and try again." };
    const { data: live, error: liveErr } = await supabase
      .from("stock_lot_balance")
      .select("lot_id, pieces_left, cost_left")
      .eq("org_id", orgId)
      .eq("item_id", id)
      .eq("live", true);
    if (liveErr) return { ok: false, error: dbError(liveErr) };
    const left = ((live ?? []) as { pieces_left?: unknown; cost_left?: unknown }[]).some(
      (l) => Number(l.pieces_left) > 0 || Number(l.cost_left) > 0,
    );
    const onHand = Number((item as { quantity_on_hand?: unknown }).quantity_on_hand) || 0;
    if (left || onHand !== 0) {
      const it = item as { name: string; unit: string };
      return {
        ok: false,
        error: `${it.name} still has ${onHand} ${it.unit} on the shelf's record. Count It to 0 first, so its value doesn't disappear from Shop Stock with it.`,
      };
    }
  }
  const { data, error } = await supabase
    .from("inventory_items")
    .update({ active })
    .eq("id", id)
    .eq("org_id", orgId)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "That item isn't there any more. Reload the page and try again." };
  revalidatePath("/inventory");
  return { ok: true };
}

/*
 * adjustQuantity IS GONE (Shop Stock, 0303). What is on hand is a cache the shelf's own record keeps
 * (rolls in, pieces out), and the database refuses a typed-over count, so a door that typed one
 * would only ever say no. Counting the shelf is Count It below (recount moves, 0328), the one way a
 * count can change without a number nobody can trace.
 */

/** The shelf's items for a picker: names and units only, never a cost (Shop Stock, Phase 2). */
export async function shelfPickerItems(): Promise<{ ok: true; items: ShelfPickerItem[] } | { ok: false; error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This is office-only." };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  const { data, error } = await supabase
    .from("inventory_items")
    .select("id, name, unit, key_part, part_number, price_item_id, created_at")
    .eq("org_id", orgId)
    .eq("active", true)
    .order("name")
    .limit(2000);
  if (error) return { ok: false, error: dbError(error) };
  return { ok: true, items: (data ?? []) as ShelfPickerItem[] };
}

/**
 * COUNT IT (Shop Stock, 0328). A person counted what is really on the shelf. Fewer than the record
 * are written off oldest roll first at what they cost (Shop Stock Lost); more are found pieces at
 * $0 (no paper behind them). Nothing is typed over: each difference is a move with an Undo.
 */
export async function countItem(itemId: string, counted: number, note?: string | null): Promise<Result & { message?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  const n = Number(counted);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: "Say how many are on the shelf (0 if none)." };
  const { data, error } = await supabase.rpc("stock_recount", { p_item: itemId, p_counted: n, p_note: note ?? null });
  if (error) return { ok: false, error: isMissingShelfRpc(error) ? SHELF_NEEDS_0328.replace("Putting things on the shelf", "Counting the shelf") : dbError(error) };
  const d = (data ?? {}) as { changed?: boolean; on_hand?: unknown; moves?: { kind: string; qty: unknown }[] };
  revalidatePath("/inventory");
  if (!d.changed) return { ok: true, message: "That matches the shelf's record. Nothing changed." };
  const down = (d.moves ?? []).filter((m) => m.kind === "recount_down").reduce((s, m) => s + Number(m.qty || 0), 0);
  const up = (d.moves ?? []).filter((m) => m.kind === "recount_up").reduce((s, m) => s + Number(m.qty || 0), 0);
  return {
    ok: true,
    message: down > 0
      ? `Counted: ${Number(d.on_hand)} on the shelf. ${Math.round(down * 1000) / 1000} short were written off at what they cost (Shop Stock Lost).`
      : `Counted: ${Number(d.on_hand)} on the shelf. ${Math.round(up * 1000) / 1000} found, at $0 (no receipt behind them).`,
  };
}

/**
 * Undo an office upkeep move: a count, a found piece, a write-off or a return to the supplier. A take
 * is undone by stock_undo. WHILE UNEXPORTED: once a Stock Used or On Hand download for the
 * accountant has carried the move, it stays (0350's guard_stock_move_exported refuses it too); the
 * way forward is Count It, from today.
 */
export async function undoShelfMove(moveId: string): Promise<Result & { message?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  const { data: move, error: moveErr } = await supabase
    .from("stock_moves")
    .select("id, kind, created_at, undone_at")
    .eq("id", moveId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (moveErr) return { ok: false, error: dbError(moveErr) };
  const m = move as { kind?: string; created_at?: string; undone_at?: string | null } | null;
  if (!m || !UPKEEP_KINDS.includes(String(m.kind)) || m.undone_at)
    return { ok: false, error: "That's already undone, or isn't a count, a write-off or a return. Reload to see where it stands." };
  const sent = await exportCarrying(supabase, orgId, String(m.created_at ?? ""));
  if (sent) return { ok: false, error: sent };
  const { data, error } = await supabase
    .from("stock_moves")
    .update({ undone_at: new Date().toISOString() })
    .eq("id", moveId)
    .eq("org_id", orgId)
    .in("kind", UPKEEP_KINDS)
    .is("undone_at", null)
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "That's already undone. Reload to see where it stands." };
  revalidatePath("/inventory");
  revalidatePath("/analytics");
  const message =
    m.kind === "write_off"
      ? "Undone: those pieces are back on the shelf, and nothing is written off."
      : m.kind === "supplier_return"
        ? "Undone: those pieces are back on the shelf. A credit tied to them stays on the shelf, untied, until a return is tied to it again."
        : "Undone: that count no longer counts.";
  return { ok: true, message };
}

/** The office's own upkeep moves: the ones Undo here reaches, and the ones an export freezes. */
const UPKEEP_KINDS = ["recount_down", "recount_up", "write_off", "supplier_return"];

/**
 * Has an accountant download already carried a move made at `createdAt`? The sentence to say if so,
 * or null. Mirrors 0350's guard (which is the boundary); before 0350 there is no record of
 * downloads, so nothing is frozen, and a failed read refuses rather than guessing.
 */
async function exportCarrying(supabase: any, orgId: string, createdAt: string): Promise<string | null> {
  if (!createdAt) return null;
  const { data, error } = await supabase
    .from("accountant_exports")
    .select("list, from_at, to_at, created_at")
    .eq("org_id", orgId)
    .in("list", ["stock_used", "on_hand"])
    .gt("created_at", createdAt)
    .gt("to_at", createdAt)
    .order("created_at")
    .limit(50);
  if (error) {
    if (isMissingShelf(error) || /accountant_exports/.test(String(error.message ?? ""))) return null;
    return `Couldn't check whether your accountant already has this, so nothing changed: ${dbError(error)}`;
  }
  const hit = ((data ?? []) as { list: string; from_at: string | null; created_at: string }[]).find(
    (e) => !e.from_at || Date.parse(e.from_at) <= Date.parse(createdAt),
  );
  if (!hit) return null;
  return `This already went to your accountant in the ${hit.list === "stock_used" ? "Stock Used" : "On Hand"} list downloaded ${shortDay(hit.created_at)}, so it stays as it is. Count the shelf (Count It) to put it right from today.`;
}

const shortDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "earlier";
};

/** The roll a write-off or a return comes off, read for the office: its item, what is left, and
 *  the supplier on its ticket. A failed read refuses. */
async function readRoll(supabase: any, orgId: string, lotId: string) {
  const { data: lot, error } = await supabase
    .from("stock_lot_balance")
    .select("lot_id, item_id, bill_id, unit, pieces_left, cost_left, live, cost_stale")
    .eq("lot_id", lotId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) return { error: isMissingShelf(error) ? "The shelf isn't switched on for this database yet." : dbError(error) };
  const l = lot as { item_id: string; bill_id: string | null; unit: string; pieces_left: unknown; cost_left: unknown; live: boolean; cost_stale: boolean } | null;
  if (!l || l.live === false) return { error: "That roll isn't on the shelf any more. Reload to see where it stands." };
  if (l.cost_stale) return { error: "That roll's receipt changed after it went on the shelf, so its cost is being worked out again. Open its receipt on Bills first." };
  let supplier: string | null = null;
  if (l.bill_id) {
    const { data: bill } = await supabase.from("bills").select("supplier").eq("id", l.bill_id).eq("org_id", orgId).maybeSingle();
    supplier = (bill as { supplier?: string | null } | null)?.supplier ?? null;
  }
  return { itemId: String(l.item_id), unit: String(l.unit ?? ""), left: Number(l.pieces_left) || 0, costLeft: Number(l.cost_left) || 0, supplier };
}

/**
 * WRITE OFF (Shop Stock, Phase 4): pieces off one roll that are gone for good (ruined, lost, used on
 * the shop). The database stamps what they cost off the roll; it shows as Shop Stock Lost in the
 * month written off. The company eats it: a write-off has no job, so no customer is ever charged.
 * Undo while no accountant download has carried it.
 */
export async function writeOffPieces(input: { lotId: string; qty: number; reason: string }): Promise<Result & { message?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  const qty = Math.round((Number(input.qty) || 0) * 1000) / 1000;
  const reason = String(input.reason ?? "").trim().slice(0, 500);
  if (!(qty > 0)) return { ok: false, error: "Say how many to write off." };
  if (!reason) return { ok: false, error: "Say why (for example, \"ruined in the rain\"), so the write-off explains itself later." };
  const roll = await readRoll(supabase, orgId, String(input.lotId ?? ""));
  if ("error" in roll) return { ok: false, error: roll.error };
  if (qty > roll.left) return { ok: false, error: `Only ${roll.left} ${roll.unit} are left on that roll.` };
  const { data, error } = await supabase
    .from("stock_moves")
    .insert({ org_id: orgId, item_id: roll.itemId, lot_id: input.lotId, kind: "write_off", qty, source: "office", note: reason })
    .select("id, cost");
  if (error) return { ok: false, error: dbError(error) };
  const row = (data ?? [])[0] as { id: string; cost: unknown } | undefined;
  if (!row) return { ok: false, error: "The write-off didn't save. Nothing changed - try again." };
  revalidatePath("/inventory");
  revalidatePath("/analytics");
  return {
    ok: true,
    id: String(row.id),
    message: `${qty} ${roll.unit} written off at ${formatCurrency(Number(row.cost) || 0)}, what they cost off the roll. It shows as Shop Stock Lost this month. No customer is charged for it.`,
  };
}

export type ShelfCreditOption = { id: string; supplier: string; number: string | null; date: string | null; amount: number; onShelf: boolean; tiedCost: number };

/**
 * The credits a return from the shelf may be tied to: below $0, on no job, not set aside. A credit
 * filed on a job is left out on purpose (it would come off that job's customer bill); the sheet says
 * so. `tiedCost` is what returns already tied to each credit cost.
 */
export async function shelfCredits(): Promise<{ ok: true; credits: ShelfCreditOption[]; onJobs: number } | { ok: false; error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This is office-only." };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  const { data, error } = await supabase
    .from("bills")
    .select("id, supplier, bill_number, bill_date, amount, job_id, on_shelf, superseded_by_bill_id")
    .eq("org_id", orgId)
    .lt("amount", 0)
    .is("superseded_by_bill_id", null)
    .order("bill_date", { ascending: false })
    .limit(200);
  if (error) return { ok: false, error: dbError(error) };
  const rows = (data ?? []) as any[];
  const open = rows.filter((b) => canTieToShelfReturn(b));
  const tied = new Map<string, number>();
  if (open.length) {
    const { data: moves, error: movesErr } = await supabase
      .from("stock_moves")
      .select("credit_bill_id, cost")
      .eq("org_id", orgId)
      .eq("kind", "supplier_return")
      .is("undone_at", null)
      .in("credit_bill_id", open.map((b) => String(b.id)));
    if (movesErr && !isMissingCreditColumn(movesErr)) return { ok: false, error: dbError(movesErr) };
    for (const m of (movesErr ? [] : moves ?? []) as { credit_bill_id: string; cost: unknown }[])
      tied.set(String(m.credit_bill_id), Math.round(((tied.get(String(m.credit_bill_id)) ?? 0) + (Number(m.cost) || 0)) * 100) / 100);
  }
  return {
    ok: true,
    onJobs: rows.filter((b) => b.job_id).length,
    credits: open.map((b) => ({
      id: String(b.id),
      supplier: String(b.supplier ?? "A supplier"),
      number: b.bill_number ?? null,
      date: b.bill_date ? String(b.bill_date).slice(0, 10) : null,
      amount: Number(b.amount) || 0,
      onShelf: b.on_shelf === true,
      tiedCost: tied.get(String(b.id)) ?? 0,
    })),
  };
}

/** Tying a return to a credit needs 0350; before it, the return still goes, untied, and says so. */
const RETURN_TIE_NEEDS_0350 =
  "Tying a return to the supplier's credit needs one more database update (0350) that hasn't been applied yet. Return the pieces without a credit for now (the whole cost is written off), and Undo and return them again with the credit once the update is in.";

/**
 * RETURN TO CED (Shop Stock, Phase 4): pieces off one roll go back to the supplier. A supplier_return
 * move lowers the roll by what they cost (the database stamps it). When the supplier's credit memo
 * is in the books it is tied to the return and filed to the shelf (on_shelf, no job), so no job's
 * materials import ever reads it and NO CUSTOMER IS EVER CREDITED for shelf stock. What the pieces
 * cost minus the credit is written off as Shop Stock Lost, and the answer says so in words.
 */
export async function returnToSupplier(input: { lotId: string; qty: number; creditBillId?: string | null; note?: string | null }): Promise<Result & { message?: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  const qty = Math.round((Number(input.qty) || 0) * 1000) / 1000;
  if (!(qty > 0)) return { ok: false, error: "Say how many went back." };
  const roll = await readRoll(supabase, orgId, String(input.lotId ?? ""));
  if ("error" in roll) return { ok: false, error: roll.error };
  if (qty > roll.left) return { ok: false, error: `Only ${roll.left} ${roll.unit} are left on that roll.` };

  const creditId = input.creditBillId ? String(input.creditBillId) : null;
  let credit: { amount: number; onShelf: boolean } | null = null;
  if (creditId) {
    // The column first: before 0350 nothing is flipped onto the shelf for a tie that can't be written.
    const probe = await supabase.from("stock_moves").select("credit_bill_id").eq("org_id", orgId).limit(1);
    if (probe.error) return { ok: false, error: isMissingCreditColumn(probe.error) ? RETURN_TIE_NEEDS_0350 : dbError(probe.error) };
    const { data: bill, error: billErr } = await supabase
      .from("bills")
      .select("id, amount, job_id, on_shelf, superseded_by_bill_id")
      .eq("id", creditId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (billErr) return { ok: false, error: dbError(billErr) };
    if (!bill) return { ok: false, error: "That credit isn't in the books any more. Reload and pick again." };
    if (!canTieToShelfReturn(bill))
      return {
        ok: false,
        error: (bill as { job_id?: string | null }).job_id
          ? "That credit is filed on a job, where it would come off the customer's bill. Clear its job on Bills first if it was really for the shelf."
          : "That isn't a credit that can be tied to a return. Pick the supplier's credit memo for these pieces.",
      };
    credit = { amount: Number((bill as { amount: unknown }).amount) || 0, onShelf: (bill as { on_shelf?: boolean }).on_shelf === true };
    // FILED TO THE SHELF, so no job's import can ever read it (0350 requires it for the tie).
    if (!credit.onShelf) {
      const { data: flipped, error: flipErr } = await supabase
        .from("bills")
        .update({ on_shelf: true })
        .eq("id", creditId)
        .eq("org_id", orgId)
        .is("job_id", null)
        .select("id");
      if (flipErr) return { ok: false, error: dbError(flipErr) };
      if (!flipped?.length) return { ok: false, error: "That credit changed while this was open. Reload and pick again. Nothing changed." };
    }
  }

  const { data, error } = await supabase
    .from("stock_moves")
    .insert({
      org_id: orgId,
      item_id: roll.itemId,
      lot_id: input.lotId,
      kind: "supplier_return",
      qty,
      source: "office",
      note: String(input.note ?? "").trim().slice(0, 500) || null,
      ...(creditId ? { credit_bill_id: creditId } : {}),
    })
    .select("id, cost");
  const row = (data ?? [])[0] as { id: string; cost: unknown } | undefined;
  if (error || !row) {
    // Nothing went back: the credit goes back to where it was, so nothing is half done.
    let putBack = "";
    if (creditId && credit && !credit.onShelf) {
      const { error: backErr } = await supabase.from("bills").update({ on_shelf: false }).eq("id", creditId).eq("org_id", orgId).select("id");
      if (backErr) putBack = " The credit was filed to the shelf and couldn't be put back; it is on the shelf with no return tied to it.";
    }
    const why = error ? (isMissingCreditColumn(error) ? RETURN_TIE_NEEDS_0350 : dbError(error)) : "The return didn't save. Nothing went back - try again.";
    return { ok: false, error: `${why}${putBack}` };
  }
  let others = 0;
  if (creditId) {
    const { data: tied } = await supabase
      .from("stock_moves")
      .select("id, cost")
      .eq("org_id", orgId)
      .eq("kind", "supplier_return")
      .eq("credit_bill_id", creditId)
      .is("undone_at", null)
      .neq("id", row.id);
    others = ((tied ?? []) as { cost: unknown }[]).reduce((s, m) => s + (Number(m.cost) || 0), 0);
  }
  const money = shelfReturnMoney({ qty, unit: roll.unit, supplier: roll.supplier, cost: Number(row.cost) || 0, creditAmount: credit ? credit.amount : null, otherReturnsCost: others });
  revalidatePath("/inventory");
  revalidatePath("/analytics");
  revalidatePath("/bills");
  return { ok: true, id: String(row.id), message: money.words };
}

/** Undo a take from the shelf (Phase 3's Took From Stock), until an invoice bills it. */
export async function undoShelfTake(drawGroup: string): Promise<Result> {
  const res = await undoTake(drawGroup);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/** Take a roll back off the shelf before anything was taken from it. */
export async function takeLotOffShelf(lotId: string): Promise<Result> {
  const res = await unshelveLot(lotId);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/**
 * A MANUAL ADD IS AN OPENING ROLL (the plan's Phase 2): something already on the shelf with no
 * receipt in the app. It needs a count, what it cost (typed, $0 allowed) and a note saying where
 * the figure came from, so nobody later mistakes it for paper.
 */
export async function addOpeningRoll(input: { itemId: string; pieces: number; cost: number; note: string }): Promise<Result> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error };
  const { supabase, orgId } = ctx;
  if (!orgId) return { ok: false, error: NO_ORG };
  const pieces = Number(input.pieces);
  const cost = Math.round((Number(input.cost) || 0) * 100) / 100;
  const note = String(input.note ?? "").trim();
  if (!(pieces > 0)) return { ok: false, error: "Say how many are on the shelf." };
  if (cost < 0) return { ok: false, error: "What it cost can't be below $0." };
  if (!note) return { ok: false, error: "Say where this came from (for example, \"counted in the truck, 9/24\"). A roll with no receipt needs a note." };
  const { data: item, error: itemErr } = await supabase.from("inventory_items").select("id, unit").eq("id", input.itemId).eq("org_id", orgId).maybeSingle();
  if (itemErr) return { ok: false, error: dbError(itemErr) };
  if (!item) return { ok: false, error: "That item isn't on this company's shelf any more. Reload and try again." };
  const { data, error } = await supabase
    .from("stock_lots")
    .insert({ org_id: orgId, item_id: input.itemId, kind: "opening", pieces: Math.round(pieces * 1000) / 1000, unit: (item as { unit: string }).unit, cost, note })
    .select("id");
  if (error) return { ok: false, error: dbError(error) };
  if (!data?.length) return { ok: false, error: "That roll didn't go on the shelf. Nothing changed - try again." };
  revalidatePath("/inventory");
  return { ok: true, id: String(data[0].id) };
}

