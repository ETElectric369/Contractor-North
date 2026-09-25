import { isMissingShelf } from "@/lib/job-cost";
import { lotCostDrift, type StoredLineLot } from "@/lib/shelf-plan";
import type { BillLine } from "@/lib/bill-itemisation";

/**
 * THE SHELF'S DAILY CHECK (Shop Stock, Phase 2; the plan's ops check). Empty is the only healthy
 * answer, and anything else is written to error_events by the daily cron, where the morning ops
 * review reads it:
 *   · every row of stock_reconcile_problems (0303): a roll below empty or empty with cents on it,
 *     a stale roll, a roll worth more than its paper, a take past the shelf unsettled for a week,
 *     the on-hand cache drifting from the record, and the rest the view names;
 *   · the TypeScript half the view cannot do: a live roll whose stored cost is not what
 *     shelfLotCost gives over its receipt's lines today (lotCostDrift).
 *
 * Pure-ish: it takes a client (the cron's service client, which reads every org) and returns what
 * it found; the caller reports. Read only, always.
 */
export type ShelfProblem = { orgId: string; problem: string; detail: string; lotId?: string | null; billId?: string | null };

type Client = { from: (t: string) => any };

export async function findShelfProblems(supabase: Client): Promise<{ problems: ShelfProblem[]; skipped: string | null }> {
  const problems: ShelfProblem[] = [];
  const { data: rows, error } = await supabase
    .from("stock_reconcile_problems")
    .select("org_id, problem, lot_id, item_id, move_id, bill_id, detail")
    .limit(500);
  if (error) {
    if (isMissingShelf(error)) return { problems: [], skipped: "the shelf ledger (0303) is not on this database" };
    throw new Error(`stock_reconcile_problems could not be read: ${String((error as { message?: string }).message ?? error)}`);
  }
  for (const r of (rows ?? []) as any[]) {
    problems.push({ orgId: String(r.org_id), problem: String(r.problem), detail: String(r.detail ?? ""), lotId: r.lot_id ?? null, billId: r.bill_id ?? null });
  }

  // The TypeScript half: every live roll off a receipt line, against its receipt as it stands.
  const { data: lots, error: lotsErr } = await supabase
    .from("stock_lot_balance")
    .select("org_id, lot_id, bill_line_id, bill_id, cost, live, live_moves, kind")
    .eq("live", true)
    .eq("kind", "line")
    .limit(10000);
  if (lotsErr) throw new Error(`stock_lot_balance could not be read: ${String((lotsErr as { message?: string }).message ?? lotsErr)}`);
  const byBill = new Map<string, (StoredLineLot & { org_id: string })[]>();
  for (const l of (lots ?? []) as any[]) {
    if (!l.bill_id) continue;
    const arr = byBill.get(String(l.bill_id)) ?? [];
    arr.push(l);
    byBill.set(String(l.bill_id), arr);
  }
  const billIds = Array.from(byBill.keys());
  for (let i = 0; i < billIds.length; i += 200) {
    const chunk = billIds.slice(i, i + 200);
    const { data: lines, error: linesErr } = await supabase
      .from("bill_line_items")
      .select("id, bill_id, description, quantity, unit_price, amount, category, billable, billed_amount")
      .in("bill_id", chunk);
    if (linesErr) throw new Error(`bill_line_items could not be read: ${String((linesErr as { message?: string }).message ?? linesErr)}`);
    const linesByBill = new Map<string, (BillLine & { id: string })[]>();
    for (const l of (lines ?? []) as any[]) {
      const arr = linesByBill.get(String(l.bill_id)) ?? [];
      arr.push(l);
      linesByBill.set(String(l.bill_id), arr);
    }
    for (const billId of chunk) {
      const billLots = byBill.get(billId) ?? [];
      for (const d of lotCostDrift(billLots, linesByBill.get(billId) ?? [])) {
        const lot = billLots.find((l) => String(l.lot_id) === d.lotId);
        problems.push({
          orgId: String(lot?.org_id ?? ""),
          problem: "lot_cost_drift",
          detail: `roll $${d.stored.toFixed(2)}, its receipt says $${d.today.toFixed(2)} today`,
          lotId: d.lotId,
          billId,
        });
      }
    }
  }
  return { problems, skipped: null };
}
