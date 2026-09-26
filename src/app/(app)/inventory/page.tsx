import Link from "next/link";
import { redirect } from "next/navigation";
import { Boxes, Search } from "lucide-react";
import { requireStaff } from "@/lib/staff-guard";
import { isMissingShelf } from "@/lib/job-cost";
import { PageHeader, EmptyState } from "@/components/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DEFAULT_TIMEZONE, formatCurrency, sanitizeSearch } from "@/lib/utils";
import { companyUseWord, proposalOf, storedMarks } from "@/lib/paperwork";
import { cleanLines } from "@/lib/paper-lines";
import { waitingForShelf, type WaitingLineIn } from "@/lib/shelf-plan";
import { claimedIdsOfLines } from "@/lib/unbilled-work";
import { readSupplierPaperHomes, type SupplierPaperHome } from "@/app/(app)/bills/supplier-papers";
import { reportError } from "@/lib/observe";
import { todayStrInTz } from "@/lib/tz";
import { NewItemButton } from "./new-item-button";
import { ShopStockList, type ShelfItemView, type ShelfLotView, type ShelfMoveView } from "./shop-stock-list";

export const dynamic = "force-dynamic";

/**
 * SHOP STOCK (the Inventory page, renamed; Shop Stock, Phase 2).
 *
 * Erik: "things like wire and wire nuts i get a roll and cut off 20' for a job". This is that
 * shelf: one row per item ("12/2 NM-B · 250 ft · $180.17"), and under it where every roll came
 * from ("In: 250 ft from CED, 8/19") and where every piece went, with Undo where the shelf's record
 * allows it. Below the list, Waiting For The Shelf names what probably belongs here and never moves
 * any of it: the app suggests, a person decides.
 *
 * OFFICE ONLY, ON THE SERVER (0302). requireStaff is the refusal, and the shelf's tables are
 * staff-only to read. A tech's view of the shelf is shelf_for_crew (names and counts, no cost),
 * which arrives with Took From Stock in Phase 3.
 *
 * EVERY FIGURE HERE IS THE LEDGER'S (0303). On hand is the rolls' pieces left, never typed; value
 * is every live roll's dollars left, to the cent, off its receipt. Count It writes the difference
 * as moves; it never types over a number.
 */
export default async function ShopStockPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; low?: string; inactive?: string; item?: string }>;
}) {
  const { q, low, inactive, item: openItem } = await searchParams;
  const lowOnly = low === "1";
  // Show Inactive Items: the only place an item marked inactive can be found and made active again.
  const inactiveOnly = inactive === "1";
  const ctx = await requireStaff();
  if ("error" in ctx) redirect("/planner");
  const { supabase, orgId } = ctx;
  if (!orgId) redirect("/planner");

  // Named columns, never "*": the projection law, and a cost column added later must not reach a
  // page by default.
  let itemQuery = supabase
    .from("inventory_items")
    .select("id, name, part_number, key_part, description, category, unit, quantity_on_hand, reorder_point, vendor, location, active")
    .eq("org_id", orgId)
    .eq("active", !inactiveOnly)
    .order("name");
  const term = sanitizeSearch(q);
  if (term) itemQuery = itemQuery.or(`name.ilike.%${term}%,part_number.ilike.%${term}%,key_part.ilike.%${term}%,category.ilike.%${term}%`);

  // ONE BREATH: everything the page needs that depends on nothing else.
  const [items, lots, lotRows, moves, jobs, receiptLines, stockDocs, docLinks, papers] = await Promise.all([
    itemQuery,
    supabase
      .from("stock_lot_balance")
      .select("lot_id, item_id, kind, bill_line_id, bill_id, pieces, unit, cost, bought_on, cost_stale, live, pieces_left, cost_left, live_moves")
      .eq("org_id", orgId)
      .limit(10000),
    supabase.from("stock_lots").select("id, note, created_at, unshelved_at").eq("org_id", orgId).limit(10000),
    supabase
      .from("stock_moves")
      .select("id, item_id, lot_id, job_id, draw_group, kind, qty, cost, note, created_by, created_at, undone_at, settled_by")
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .limit(5000),
    supabase.from("jobs").select("id, name, job_number").eq("org_id", orgId).limit(2000),
    // Waiting For The Shelf, signal 1 and 2: every job receipt line (live bills only, below).
    supabase
      .from("bill_line_items")
      .select("id, bill_id, description, quantity, amount, category, billable, billed_amount, bills!inner(job_id, po_id, bill_date, superseded_by_bill_id)")
      .eq("org_id", orgId)
      .not("bills.job_id", "is", null)
      .limit(10000),
    // Signal 3: CED documents whose job box names the shelf.
    supabase
      .from("supplier_invoices")
      .select("id, supplier_account_id, invoice_number, kind, total, job_name_raw")
      .eq("org_id", orgId)
      .eq("kind", "invoice")
      .or("job_name_raw.ilike.%stock%,job_name_raw.ilike.%inventory%")
      .limit(500),
    supabase.from("bill_supplier_invoices").select("supplier_invoice_id").eq("org_id", orgId).limit(10000),
    // Signal 4: papers in the tray that say STOCK.
    supabase
      .from("organized_items")
      .select("id, title, status, line_items, proposal")
      .eq("org_id", orgId)
      .eq("status", "needs_review")
      .limit(300),
  ]);

  // A shelf ledger missing (a database before 0303) is no rolls; any other failure is said, never
  // read as a shelf worth $0.
  const lotsReadFailed = !!lots.error && !isMissingShelf(lots.error);
  const lotList = ((lots.error ? [] : lots.data) ?? []) as any[];
  const lotMeta = new Map(((lotRows.error ? [] : lotRows.data) ?? []).map((r: any) => [String(r.id), r]));
  const moveList = ((moves.error ? [] : moves.data) ?? []) as any[];
  const jobName = new Map(((jobs.data ?? []) as any[]).map((j) => [String(j.id), j.name || j.job_number || "a job"]));

  // Second breath: who moved what, and which receipt each roll came off.
  const billIds = Array.from(new Set(lotList.map((l) => l.bill_id).filter(Boolean).map(String)));
  const people = Array.from(new Set(moveList.map((m) => m.created_by).filter(Boolean).map(String)));
  // Which receipts an invoice the customer holds already bills (the receipt, or the order it
  // delivered): the same claim read the Bills page makes, scoped the same way, by job. On those the
  // receipt card has no Put The Rest On The Shelf, so the Waiting card must not send anyone to it.
  const receiptJobIds = Array.from(
    new Set(((receiptLines.error ? [] : receiptLines.data) ?? []).map((l: any) => l?.bills?.job_id).filter(Boolean).map(String)),
  );
  const [bills, profiles, claimRows] = await Promise.all([
    billIds.length
      ? supabase.from("bills").select("id, supplier, bill_date, job_id, on_shelf").eq("org_id", orgId).in("id", billIds)
      : Promise.resolve({ data: [] as any[], error: null }),
    people.length
      ? supabase.from("profiles").select("id, full_name").in("id", people)
      : Promise.resolve({ data: [] as any[], error: null }),
    receiptJobIds.length
      ? supabase
          .from("invoice_items")
          .select("import_key, source_ids, invoices!inner(invoice_number, status, created_at, job_id)")
          .in("invoices.job_id", receiptJobIds)
          .not("invoices.status", "in", "(void,draft)")
          .limit(5000)
      : Promise.resolve({ data: [] as any[], error: null }),
  ]);
  const heldBy = new Map<string, string>();
  for (const row of [...((claimRows.error ? [] : claimRows.data) ?? [])].sort((a: any, b: any) =>
    String(a.invoices?.created_at ?? "").localeCompare(String(b.invoices?.created_at ?? "")),
  ) as any[]) {
    const label = `${row.invoices?.invoice_number || "an invoice"} (${String(row.invoices?.status ?? "sent")})`;
    for (const id of claimedIdsOfLines([{ import_key: row.import_key, source_ids: row.source_ids }])) if (!heldBy.has(id)) heldBy.set(id, label);
  }
  const billOf = new Map(((bills.data ?? []) as any[]).map((b) => [String(b.id), b]));
  const whoOf = new Map(((profiles.data ?? []) as any[]).map((p) => [String(p.id), String(p.full_name ?? "Someone").split(" ")[0]]));

  const day = (iso: string | null | undefined) => {
    if (!iso) return "";
    const d = String(iso).slice(0, 10).split("-");
    return d.length === 3 ? `${Number(d[1])}/${Number(d[2])}` : "";
  };

  const lotsByItem = new Map<string, ShelfLotView[]>();
  for (const l of lotList) {
    const meta = lotMeta.get(String(l.lot_id)) as any;
    const bill = l.bill_id ? billOf.get(String(l.bill_id)) : null;
    const from =
      l.kind === "opening"
        ? `Counted in, not off a receipt${meta?.note ? `: ${meta.note}` : ""}`
        : `from ${bill?.supplier ?? "a receipt"}${bill?.bill_date ? `, ${day(bill.bill_date)}` : ""}${
            bill?.on_shelf ? " (a shelf ticket)" : bill?.job_id ? ` (bought on ${jobName.get(String(bill.job_id)) ?? "a job"})` : ""
          }`;
    const view: ShelfLotView = {
      id: String(l.lot_id),
      pieces: Number(l.pieces) || 0,
      unit: String(l.unit ?? ""),
      cost: Number(l.cost) || 0,
      piecesLeft: Number(l.pieces_left) || 0,
      costLeft: Number(l.cost_left) || 0,
      from,
      boughtOn: l.bought_on ?? null,
      live: l.live !== false,
      liveMoves: Number(l.live_moves) || 0,
      stale: l.cost_stale === true,
      offOn: meta?.unshelved_at ? day(meta.unshelved_at) : null,
      backTo: bill?.job_id ? jobName.get(String(bill.job_id)) ?? "its job" : null,
      // Unread bill (a failed read) is treated as a shelf ticket: no Take It Off, and the server
      // refuses a shelf ticket's roll in words either way.
      shelfTicket: l.kind !== "opening" && (!bill || bill.on_shelf === true || !bill.job_id),
    };
    const arr = lotsByItem.get(String(l.item_id)) ?? [];
    arr.push(view);
    lotsByItem.set(String(l.item_id), arr);
  }
  const movesByItem = new Map<string, ShelfMoveView[]>();
  for (const m of moveList) {
    const who = m.created_by ? whoOf.get(String(m.created_by)) ?? "Someone" : "The office";
    const job = m.job_id ? jobName.get(String(m.job_id)) ?? "a job" : null;
    const qty = Number(m.qty) || 0;
    const words: Record<string, string> = {
      draw: `${who} took ${qty} for ${job}`,
      short: `${who} took ${qty} for ${job}, past what the shelf showed`,
      job_return: `${qty} came back from ${job}`,
      recount_down: `Counted: ${qty} fewer than the record (written off)`,
      recount_up: `Counted: ${qty} more than the record (found, $0)`,
      write_off: `${qty} written off`,
      supplier_return: `${qty} went back to the supplier`,
    };
    const view: ShelfMoveView = {
      id: String(m.id),
      kind: String(m.kind),
      text: `${words[m.kind] ?? `${m.kind} ${qty}`}, ${day(m.created_at)}${m.note && !/^Counted on the shelf$/.test(m.note) ? ` · ${m.note}` : ""}`,
      cost: Number(m.cost) || 0,
      undone: !!m.undone_at,
      drawGroup: m.draw_group ? String(m.draw_group) : null,
      settled: !!m.settled_by,
    };
    const arr = movesByItem.get(String(m.item_id)) ?? [];
    arr.push(view);
    movesByItem.set(String(m.item_id), arr);
  }

  const itemViews: ShelfItemView[] = ((items.data ?? []) as any[]).map((i) => {
    const itemLots = lotsByItem.get(String(i.id)) ?? [];
    return {
      id: String(i.id),
      name: String(i.name),
      unit: String(i.unit ?? "ea"),
      partNumber: i.key_part ?? i.part_number ?? null,
      category: i.category ?? null,
      location: i.location ?? null,
      vendor: i.vendor ?? null,
      description: i.description ?? null,
      reorderPoint: Number(i.reorder_point) || 0,
      onHand: Number(i.quantity_on_hand) || 0,
      value: Math.round(itemLots.filter((l) => l.live).reduce((s, l) => s + l.costLeft, 0) * 100) / 100,
      lots: itemLots.sort((a, b) => String(a.boughtOn ?? "").localeCompare(String(b.boughtOn ?? ""))),
      moves: movesByItem.get(String(i.id)) ?? [],
      active: i.active !== false,
    };
  });

  const isLow = (i: ShelfItemView) => i.reorderPoint > 0 && i.onHand <= i.reorderPoint;
  const lowStock = itemViews.filter(isLow);
  const totalValue = Math.round(itemViews.reduce((s, i) => s + i.value, 0) * 100) / 100;
  const shown = (lowOnly ? lowStock : itemViews).slice().sort((a, b) => Number(isLow(b)) - Number(isLow(a)) || a.name.localeCompare(b.name));

  // ── WAITING FOR THE SHELF (read only: suggested, never moved) ─────────────────────────────
  const liveLotLines = new Set(lotList.filter((l) => l.live !== false && l.bill_line_id).map((l) => String(l.bill_line_id)));
  const waitingLines: WaitingLineIn[] = ((receiptLines.error ? [] : receiptLines.data) ?? [])
    .filter((l: any) => l?.bills && !l.bills.superseded_by_bill_id && l.bills.job_id)
    .map((l: any) => ({
      lineId: String(l.id),
      billId: String(l.bill_id),
      jobId: String(l.bills.job_id),
      jobLabel: jobName.get(String(l.bills.job_id)) ?? null,
      description: String(l.description ?? ""),
      quantity: l.quantity,
      amount: l.amount,
      category: l.category ?? null,
      billable: l.billable !== false,
      billedAmount: l.billed_amount,
      hasLot: liveLotLines.has(String(l.id)),
      billDate: l.bills.bill_date ?? null,
      // A failed claim read can't say who holds it: those lines keep the door, and the server
      // (0328 and putRestOnShelf) refuses a held receipt in words.
      heldBy: heldBy.get(String(l.bill_id)) ?? (l.bills.po_id ? heldBy.get(String(l.bills.po_id)) ?? null : null),
    }));
  const linked = new Set(((docLinks.data ?? []) as any[]).map((r) => String(r.supplier_invoice_id)));
  const stockCandidates = ((stockDocs.error ? [] : stockDocs.data) ?? []).filter(
    (d: any) => !linked.has(String(d.id)) && companyUseWord(d.job_name_raw)?.shelf,
  );
  // WHERE EACH ONE STANDS ON /bills (audit v1018, class 14), read only when there is one to place:
  // Record To Shelf is offered only where its fold holds the paper. A paper a bill covers by its
  // number, or a credit memo took back, is not waiting for the shelf at all. A failed read says so.
  const homes = stockCandidates.length
    ? await readSupplierPaperHomes(supabase, orgId, todayStrInTz(DEFAULT_TIMEZONE)).catch((e: unknown) => {
        reportError("inventory.stock-paper-homes", e, { orgId });
        return null;
      })
    : null;
  const stockDocuments = stockCandidates.flatMap((d: any) => {
    const home: SupplierPaperHome | "unchecked" = homes ? homes.get(String(d.id)) ?? "not_in_books" : "unchecked";
    if (home === "covered" || home === "taken_back") return [];
    return [
      {
        id: String(d.id),
        number: String(d.invoice_number ?? ""),
        total: d.total,
        words: String(d.job_name_raw ?? "").trim(),
        accountId: d.supplier_account_id ? String(d.supplier_account_id) : null,
        home,
      },
    ];
  });
  const linelessPapers = ((papers.error ? [] : papers.data) ?? []).flatMap((p: any) => {
    const marks = storedMarks(proposalOf(p));
    const word = companyUseWord(marks.po) ?? companyUseWord(marks.jobName);
    if (!word?.shelf || cleanLines(p.line_items).length) return [];
    return [{ id: String(p.id), title: String(p.title ?? "A paper in the tray"), words: word.words }];
  });
  const waiting = waitingForShelf({ lines: waitingLines, stockDocuments, linelessPapers });
  const waitingReadFailed = !!receiptLines.error;

  const linkClass = "inline-flex min-h-[44px] items-center rounded-lg border px-4 text-sm font-medium transition-colors";

  return (
    <div>
      <PageHeader title="Shop Stock" description="What's on the shelf, what it cost, where every roll came from and where every piece went.">
        <NewItemButton />
      </PageHeader>

      {itemViews.length > 0 && (
        <div className="mb-4 grid grid-cols-3 gap-3 sm:max-w-lg sm:gap-4">
          <Card>
            <CardContent className="py-4">
              <div className="text-xl font-bold tabular-nums text-slate-900 sm:text-2xl">{itemViews.length}</div>
              <div className="text-xs text-slate-500">Items</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="py-4">
              <div className="text-xl font-bold tabular-nums text-slate-900 sm:text-2xl">{lotsReadFailed ? "—" : formatCurrency(totalValue)}</div>
              <div className="text-xs text-slate-500">On The Shelf Now</div>
            </CardContent>
          </Card>
          <Card className={lowStock.length ? "border-amber-200 bg-amber-50" : ""}>
            <CardContent className="py-4">
              <div className="text-xl font-bold tabular-nums text-slate-900 sm:text-2xl">{lowStock.length}</div>
              <div className="text-xs text-slate-500">Need Reordering</div>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <form className="min-w-0 flex-1">
          <div className="relative max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input name="q" defaultValue={q} placeholder="Search the shelf…" className="pl-9" />
            {lowOnly && <input type="hidden" name="low" value="1" />}
            {inactiveOnly && <input type="hidden" name="inactive" value="1" />}
          </div>
        </form>
        {(lowStock.length > 0 || lowOnly) && (
          <Link
            href={lowOnly ? withQuery({ q }) : withQuery({ q, low: "1" })}
            className={
              lowOnly
                ? `${linkClass} border-amber-300 bg-amber-100 text-amber-900`
                : `${linkClass} border-slate-200 bg-white text-slate-600 hover:bg-slate-50`
            }
          >
            {lowOnly ? "Show All" : `Need Reordering (${lowStock.length})`}
          </Link>
        )}
        <Link
          href={inactiveOnly ? withQuery({ q }) : withQuery({ q, inactive: "1" })}
          className={`${linkClass} border-slate-200 bg-white text-slate-600 hover:bg-slate-50`}
        >
          {inactiveOnly ? "Show Active Items" : "Show Inactive Items"}
        </Link>
      </div>

      {shown.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title={inactiveOnly ? "No inactive items" : lowOnly ? "Nothing needs reordering" : q ? "No matches" : "Nothing on the shelf yet"}
          description={
            lowOnly
              ? "Everything with a reorder point set is above it."
              : q
                ? "Try a different search."
                : "Put the rest of a roll on the shelf from a job's receipt (Bills), file a STOCK ticket to Shop Stock from the tray, or Record To Shelf on a CED document. New Item is for something already on the shelf with no receipt here."
          }
        >
          {(lowOnly || q) && (
            <Link href={withQuery({})} className={`${linkClass} border-slate-200 bg-white text-slate-600 hover:bg-slate-50`}>
              Show All
            </Link>
          )}
        </EmptyState>
      ) : (
        // ?item= (a Settle item's link) opens that item, where Settle From The Shelf is.
        <ShopStockList items={shown} openItem={typeof openItem === "string" ? openItem : null} />
      )}

      {lotsReadFailed && (
        <p className="mt-3 max-w-2xl text-xs text-amber-800">
          The shelf&apos;s rolls couldn&apos;t be read just now, so no value or history is shown. Reload to try again.
        </p>
      )}

      <Card className="mt-6 p-4">
        <h2 className="text-base font-semibold text-slate-900">Waiting For The Shelf</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          Things that probably belong on the shelf. Nothing here moves on its own: each one names the button that would put it there, and you
          decide.
        </p>
        {waitingReadFailed ? (
          <p className="mt-3 text-sm text-amber-800">The receipts couldn&apos;t be read just now, so this list is empty for now. Reload to try again.</p>
        ) : waiting.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">Nothing waiting.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200">
            {waiting.map((w) => (
              <li key={w.key} className="px-3 py-2.5">
                <p className="text-sm font-medium text-slate-900">{w.title}</p>
                <p className="mt-0.5 text-xs text-slate-500">{w.why}</p>
                {w.href && w.door && (
                  <Link href={w.href} className="mt-1 inline-flex min-h-11 items-center text-sm font-medium text-brand hover:underline">
                    {w.door}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function withQuery(params: { q?: string; low?: string; inactive?: string }): string {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.low) sp.set("low", params.low);
  if (params.inactive) sp.set("inactive", params.inactive);
  const s = sp.toString();
  return s ? `/inventory?${s}` : "/inventory";
}
