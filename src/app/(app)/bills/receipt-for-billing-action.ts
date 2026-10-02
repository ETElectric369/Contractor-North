"use server";

/**
 * ONE RECEIPT'S BILLING CARD, READ ON ITS OWN (Already Billed's shelf step, Pinyon Sage).
 *
 * The Bills page builds every job receipt's card in one breath (bills/page.tsx). Already Billed
 * asks "Did J-010 Use All Of It?" and, on No, shows the same card for the one receipt so the kept
 * GFCIs go on the shelf BEFORE the paid invoice claims it (0328 refuses the shelf after). Same
 * shape, same reads, one bill: its lines with what a person decided about each (0268 billable,
 * 0272 billed_amount, is_stock), the rolls on the shelf from those lines, and the invoice that
 * already holds it. Staff only. A failed read says so; nothing here writes.
 */

import { requireStaff } from "@/lib/staff-guard";
import { claimedIdsOfLines } from "@/lib/unbilled-work";
import type { ReceiptForBilling } from "./receipt-billing-card";

export async function receiptForBilling(billId: string): Promise<{ ok: true; receipt: ReceiptForBilling } | { ok: false; error: string }> {
  const ctx = await requireStaff();
  if ("error" in ctx) return { ok: false, error: ctx.error ?? "This action is staff-only." };
  if (!ctx.orgId) return { ok: false, error: "Your sign-in isn't attached to a company yet." };
  const id = String(billId ?? "");
  if (!id) return { ok: false, error: "Couldn't tell which receipt you meant." };
  const sb = ctx.supabase;
  const { data: b, error } = await sb
    .from("bills")
    .select("id, supplier, bill_date, job_id, amount, po_id, superseded_by_bill_id, jobs(name), bill_line_items(id, description, quantity, unit_price, amount, category, billable, billed_amount, is_stock, sort_order)")
    .eq("id", id)
    .eq("org_id", ctx.orgId)
    .maybeSingle();
  if (error) return { ok: false, error: "Couldn't read that receipt just now. Try again in a moment." };
  if (!b) return { ok: false, error: "That receipt isn't here anymore. Reload the page." };
  const bill = b as any;
  const lines = [...((bill.bill_line_items ?? []) as any[])].sort((x, y) => (x.sort_order ?? 0) - (y.sort_order ?? 0));
  const lineIds = lines.map((l) => String(l.id));

  const [lotsRead, claimsRead] = await Promise.all([
    lineIds.length
      ? sb
          .from("stock_lot_balance")
          .select("lot_id, bill_line_id, item_id, pieces, unit, cost, pieces_left, cost_left, live_moves, cost_stale")
          .eq("live", true)
          .in("bill_line_id", lineIds)
      : Promise.resolve({ data: [] as any[], error: null }),
    sb
      .from("invoice_items")
      .select("import_key, source_ids, invoices!inner(invoice_number, status, created_at)")
      .or(`source_ids.cs.{${id}},import_key.eq.bill:${id}${bill.po_id ? `,source_ids.cs.{${bill.po_id}}` : ""}`)
      .neq("invoices.status", "void")
      .limit(50),
  ]);
  if (claimsRead.error) return { ok: false, error: "Couldn't check which invoice holds that receipt just now. Try again in a moment." };
  const lots = (lotsRead.error ? [] : (lotsRead.data ?? [])) as any[];
  const itemIds = [...new Set(lots.map((l) => String(l.item_id)).filter(Boolean))];
  const names = new Map<string, string>();
  if (itemIds.length) {
    const { data: items } = await sb.from("inventory_items").select("id, name").in("id", itemIds);
    for (const i of (items ?? []) as any[]) names.set(String(i.id), String(i.name ?? ""));
  }
  const shelfByLine = new Map<string, NonNullable<ReceiptForBilling["lines"][number]["shelf"]>>();
  for (const r of lots) {
    shelfByLine.set(String(r.bill_line_id), {
      lotId: String(r.lot_id),
      itemName: names.get(String(r.item_id)) ?? "In stock",
      pieces: Number(r.pieces) || 0,
      unit: String(r.unit ?? ""),
      cost: Number(r.cost) || 0,
      piecesLeft: Number(r.pieces_left) || 0,
      costLeft: Number(r.cost_left) || 0,
      liveMoves: Number(r.live_moves) || 0,
      stale: r.cost_stale === true,
    });
  }
  // The earliest live invoice holding the receipt (or the order it delivered), as the Bills page says it.
  const holders = ((claimsRead.data ?? []) as any[])
    .filter((c) => claimedIdsOfLines([c]).some((x) => x === id || (bill.po_id && x === bill.po_id)))
    .sort((x, y) => String(x.invoices?.created_at ?? "").localeCompare(String(y.invoices?.created_at ?? "")));
  const first = holders[0];
  const receipt: ReceiptForBilling = {
    id: String(bill.id),
    supplier: bill.supplier ?? "Receipt",
    bill_date: bill.bill_date ?? null,
    job_id: bill.job_id ?? null,
    job_name: bill.jobs?.name ?? null,
    amount: Number(bill.amount) || 0,
    billedOn: first ? { label: first.invoices?.invoice_number || "an earlier invoice", status: String(first.invoices?.status ?? "") } : null,
    lines: lines.map((l) => ({
      id: String(l.id),
      description: String(l.description ?? ""),
      quantity: Number(l.quantity) || 0,
      amount: Number(l.amount) || 0,
      unitPrice: l.unit_price == null ? null : Number(l.unit_price),
      category: l.category ?? null,
      billable: l.billable !== false,
      billedAmount: l.billed_amount == null ? null : Number(l.billed_amount),
      isStock: l.is_stock === true,
      shelf: shelfByLine.get(String(l.id)) ?? null,
    })),
  };
  return { ok: true, receipt };
}
