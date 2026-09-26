import { billLineBilledCost, billLineCost, isTaxLine, shelfLotCost, type BillLine } from "@/lib/bill-itemisation";
import { bucketOf } from "@/lib/business-cost-buckets";
import { isMissingCreditColumn, isMissingShelf } from "@/lib/job-cost";
import { todayStrInTz, tzDayStartUtc } from "@/lib/tz";
import { claimedIdsOfLines } from "@/lib/unbilled-work";
import { readAllPages } from "@/lib/read-all-pages";

/**
 * EXPORT FOR ACCOUNTANT (Shop Stock, Phase 4).
 *
 * Erik, 2026-09-24: "tools are depreciable i think". The app doesn't decide that, and it never does
 * the depreciation math: it hands the accountant plain lists and says "Depreciation is your
 * accountant's call." Four lists, each a CSV with plain column names:
 *
 *   Stock Bought        every roll that went on the shelf in the window, at what it cost
 *                       (tax share included, off its ticket), with the ticket and the job it was
 *                       bought on, dated by its TICKET the way Owner Money dates Put On The Shelf
 *                       (a ticket re-dated takes its rolls with it), so the Total is the app's
 *                       Put On The Shelf for the same days. A roll counted in with no receipt says
 *                       so and is subtotalled on its own line, outside the Total: it was never a
 *                       month's cost in these books.
 *   Stock Used          every piece that left the shelf in the window and where it went: onto a
 *                       job (at its stamped cost), written off, counted short, sent back to the
 *                       supplier; pieces brought back from a job or found on a count come in as
 *                       negatives. A supplier credit tied to a return is its own row, in the
 *                       Supplier Credit column.
 *   On Hand             what was on the shelf at the end of a day, roll by roll, at cost.
 *   Tools Bought        tickets filed as Tools & Supplies, Tools lines the company kept off any
 *                       other ticket (not billed to a customer) with their tax share, and the part
 *                       of a shelf ticket that isn't rolls (Owner Money counts it in Tools &
 *                       Supplies too).
 *
 * And one list for Erik only, never downloaded and never changed: tools already billed to
 * customers (the SuperHawg on J-002's receipt, the bits and the blade). Listed, left as they are.
 *
 * THE MONEY IS THE LEDGER'S, NEVER RECOMPUTED HERE: a roll's cost is stock_lots.cost (shelfLotCost,
 * capped at the paper), a move's cost is what the database stamped. The tool lines use the same
 * shelfLotCost arithmetic the invoice uses for "what the job doesn't bill", so a Tools line's tax
 * share here is the cent the customer wasn't charged.
 *
 * This file is pure except readAccountantInputs, which reads one company's rows (every read names
 * its org_id: the office client runs under RLS, and the org filter is the belt).
 */

export type AccountantListKey = "stock_bought" | "stock_used" | "on_hand" | "tools";

export const ACCOUNTANT_LISTS: { key: AccountantListKey; title: string; file: string; says: string }[] = [
  { key: "stock_bought", title: "Stock Bought", file: "stock-bought", says: "Every roll or box that went on the shelf in these dates, at what it cost off its ticket." },
  { key: "stock_used", title: "Stock Used", file: "stock-used", says: "Every piece that left the shelf in these dates: onto which job, written off, or back to the supplier." },
  { key: "on_hand", title: "On Hand", file: "on-hand", says: "What was on the shelf at the end of the last day, roll by roll, at cost." },
  { key: "tools", title: "Tools Bought", file: "tools-bought", says: "Tickets filed as Tools & Supplies, and tools kept off other tickets. Depreciation is your accountant's call." },
];

export function isAccountantListKey(v: unknown): v is AccountantListKey {
  return typeof v === "string" && ACCOUNTANT_LISTS.some((l) => l.key === v);
}

export type Cell = string | number | null;
/** `summaryRows`: how many rows at the end are totals, not data. `total`: the list's money Total
 *  (what the page shows before a download). */
export type CsvTable = { header: string[]; rows: Cell[][]; summaryRows?: number; total?: number };

export const HEADERS: Record<AccountantListKey | "tools_billed", string[]> = {
  stock_bought: ["Date Bought", "Item", "Quantity", "Unit", "Cost", "Supplier", "Ticket Number", "Bought On Job", "How It Came In", "Note"],
  stock_used: ["Date", "Item", "Quantity", "Unit", "Cost", "Went To", "Job Number", "Job", "Note", "Supplier Credit"],
  on_hand: ["Item", "Unit", "On Hand", "Cost On Hand", "Date Bought", "Supplier", "Ticket Number", "Note"],
  tools: ["Date", "Supplier", "Ticket Number", "What", "Cost", "Filed As", "Job Number"],
  tools_billed: ["Date", "Supplier", "Job Number", "Job", "What", "Billed To Customer (At Cost)", "Invoice"],
};

// ── CSV ──────────────────────────────────────────────────────────────────────

/**
 * RFC 4180: comma separated, CRLF, a field quoted when it holds a comma, a quote or a line break
 * (quotes doubled). Numbers go out as numbers, money to the cent. A TEXT cell a spreadsheet would
 * run as a formula (=, +, -, @, tab, return first) gets a leading apostrophe, so a description a
 * supplier printed can never execute on the accountant's machine.
 */
export function toCsv(t: CsvTable): string {
  const cell = (v: Cell): string => {
    if (v == null) return "";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [t.header, ...t.rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

const cents = (n: number) => Math.round(n * 100) / 100;
const qty3 = (n: number) => Math.round(n * 1000) / 1000;
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ── Inputs ───────────────────────────────────────────────────────────────────

export type AccountantInputs = {
  items: { id: string; name: string; unit: string }[];
  /** stock_lot_balance rows with stock_lots.note: every lot, live or not. */
  lots: { lot_id: string; item_id: string; kind: string; bill_id: string | null; bill_line_id?: string | null; pieces: unknown; unit: string; cost: unknown; bought_on: string | null; live: boolean; note?: string | null }[];
  /** stock_moves, every kind, undone ones included (they are left out here). */
  moves: {
    id: string;
    item_id: string;
    lot_id: string | null;
    job_id: string | null;
    kind: string;
    qty: unknown;
    cost: unknown;
    note: string | null;
    created_at: string;
    undone_at: string | null;
    settled_by: string | null;
    credit_bill_id?: string | null;
  }[];
  /** Live bills (not set aside). */
  bills: { id: string; supplier: string | null; bill_number: string | null; bill_date: string | null; created_at: string | null; job_id: string | null; amount: unknown; category: string | null; on_shelf?: boolean | null }[];
  /** Their lines. */
  lines: (BillLine & { id: string; bill_id: string })[];
  jobs: { id: string; job_number: string | null; name: string | null }[];
  /** Non-void invoice lines that claim a bill (source_ids / import_key), with the invoice number. */
  claims: { source_ids: string[] | null; import_key: string | null; invoice_number: string | null }[];
};

export type Window = { from: string; to: string };

/** The instants a window of org-local days covers: [start of `from`, start of the day after `to`). */
export function windowInstants(w: Window, tz: string): { fromAt: string; toAt: string } {
  const next = new Date(Date.parse(`${w.to}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { fromAt: tzDayStartUtc(w.from, tz).toISOString(), toAt: tzDayStartUtc(next, tz).toISOString() };
}

/**
 * THE INSTANT A DOWNLOAD STOPS AT. A Stock Used or On Hand download carries the moves made before the
 * earlier of its window's end and `cutoffAt`, and 0350's record stores that same instant as its
 * to_at, so the moves the database freezes are exactly the moves in the file (a write-off made while
 * the file was being built is in neither, and goes in the next download).
 */
export function cutoffEnd(toAt: string, cutoffAt?: string | null): string {
  if (!cutoffAt || !Number.isFinite(Date.parse(cutoffAt))) return toAt;
  return Date.parse(cutoffAt) < Date.parse(toAt) ? new Date(Date.parse(cutoffAt)).toISOString() : toAt;
}

/** A bill's day: its own date when it has one, else the org-local day it was entered. */
function billDay(b: { bill_date: string | null; created_at: string | null }, tz: string): string | null {
  if (b.bill_date) return String(b.bill_date).slice(0, 10);
  if (!b.created_at) return null;
  const d = new Date(b.created_at);
  return Number.isFinite(d.getTime()) ? todayStrInTz(tz, d) : null;
}

const inDays = (day: string | null, w: Window) => !!day && day >= w.from && day <= w.to;

function lookups(inp: AccountantInputs) {
  const item = new Map(inp.items.map((i) => [String(i.id), i]));
  const bill = new Map(inp.bills.map((b) => [String(b.id), b]));
  const job = new Map(inp.jobs.map((j) => [String(j.id), j]));
  const lot = new Map(inp.lots.map((l) => [String(l.lot_id), l]));
  const linesOf = new Map<string, (BillLine & { id: string; bill_id: string })[]>();
  for (const l of inp.lines) {
    const arr = linesOf.get(String(l.bill_id)) ?? [];
    arr.push(l);
    linesOf.set(String(l.bill_id), arr);
  }
  return { item, bill, job, lot, linesOf };
}

const totalRow = (width: number, at: Record<number, number>, label = "Total"): Cell[] => {
  const r: Cell[] = Array.from({ length: width }, () => null);
  r[0] = label;
  for (const [i, v] of Object.entries(at)) r[Number(i)] = cents(v);
  return r;
};

// ── 1. Stock Bought ──────────────────────────────────────────────────────────

export function stockBoughtList(inp: AccountantInputs, w: Window, tz: string): CsvTable {
  const k = lookups(inp);
  const rows: { day: string; id: string; row: Cell[] }[] = [];
  const counted: { day: string; id: string; row: Cell[] }[] = [];
  let total = 0;
  let countedTotal = 0;
  for (const l of inp.lots) {
    if (l.live === false) continue;
    const b = l.bill_id ? k.bill.get(String(l.bill_id)) : undefined;
    // THE TICKET'S DAY, the way Owner Money dates Put On The Shelf: a ticket re-dated after its rolls
    // went on the shelf takes them to its new day (0304 lets the date move), and a ticket with no
    // date is the org-local day it was entered. A roll with no ticket in the books keeps its own day.
    const day = b ? billDay(b, tz) : l.bought_on ? String(l.bought_on).slice(0, 10) : null;
    if (!day || !inDays(day, w)) continue;
    const j = b?.job_id ? k.job.get(String(b.job_id)) : undefined;
    const how = l.kind === "opening" ? "Counted in, no receipt" : !b ? "Its ticket isn't in the books" : b.on_shelf ? "Shelf ticket" : b.job_id ? "Rest of a job's receipt" : "Receipt";
    const cost = cents(num(l.cost));
    const row: Cell[] = [
      day,
      k.item.get(String(l.item_id))?.name ?? "An item",
      qty3(num(l.pieces)),
      l.unit,
      cost,
      l.kind === "opening" ? null : (b?.supplier ?? null),
      b?.bill_number ?? null,
      j ? j.job_number || j.name || null : null,
      how,
      l.note ?? null,
    ];
    if (b) {
      total += cost;
      rows.push({ day, id: String(l.lot_id), row });
    } else {
      countedTotal += cost;
      counted.push({ day, id: String(l.lot_id), row });
    }
  }
  const order = (a: { day: string; id: string }, b: { day: string; id: string }) => a.day.localeCompare(b.day) || a.id.localeCompare(b.id);
  const out = [...rows.sort(order), ...counted.sort(order)].map((r) => r.row);
  if (!out.length) return { header: HEADERS.stock_bought, rows: out, summaryRows: 0, total: 0 };
  const width = HEADERS.stock_bought.length;
  const sum = totalRow(width, { 4: total });
  sum[8] = "Bought on tickets (the app's Put On The Shelf)";
  out.push(sum);
  let summaryRows = 1;
  if (counted.length) {
    const other = totalRow(width, { 4: countedTotal }, "Not In Total");
    other[8] = "Counted in with no receipt: never a month's cost in the app";
    out.push(other);
    summaryRows = 2;
  }
  return { header: HEADERS.stock_bought, rows: out, summaryRows, total: cents(total) };
}

// ── 2. Stock Used ────────────────────────────────────────────────────────────

const WENT_TO: Record<string, string> = {
  draw: "Job",
  job_return: "Back from a job",
  write_off: "Written off (Shop Stock Lost)",
  recount_down: "Counted short (Shop Stock Lost)",
  recount_up: "Found on a count",
  supplier_return: "Returned to supplier",
  short: "Taken past the shelf, no roll yet",
};

export function stockUsedList(inp: AccountantInputs, w: Window, tz: string, cutoffAt?: string | null): CsvTable {
  const k = lookups(inp);
  const { fromAt, toAt } = windowInstants(w, tz);
  const from = Date.parse(fromAt);
  const to = Date.parse(cutoffEnd(toAt, cutoffAt));
  const rows: { at: string; row: Cell[] }[] = [];
  let cost = 0;
  let credit = 0;
  const tied = new Set<string>();
  for (const m of inp.moves) {
    if (m.undone_at) continue;
    if (m.kind === "supplier_return" && m.credit_bill_id) tied.add(String(m.credit_bill_id));
    const t = Date.parse(m.created_at);
    if (!(t >= from && t < to)) continue;
    // A settled short is its draws (they are rows of their own); only an open one is said.
    if (m.kind === "short" && m.settled_by) continue;
    const back = m.kind === "job_return" || m.kind === "recount_up";
    const q = qty3(num(m.qty)) * (back ? -1 : 1);
    const c = cents(num(m.cost)) * (back ? -1 : 1);
    cost += c;
    const it = k.item.get(String(m.item_id));
    const j = m.job_id ? k.job.get(String(m.job_id)) : undefined;
    const lot = m.lot_id ? k.lot.get(String(m.lot_id)) : undefined;
    rows.push({
      at: m.created_at,
      row: [
        todayStrInTz(tz, new Date(m.created_at)),
        it?.name ?? "An item",
        q,
        it?.unit ?? lot?.unit ?? null,
        cents(c),
        WENT_TO[m.kind] ?? m.kind,
        j?.job_number ?? null,
        j?.name ?? null,
        m.note ?? null,
        null,
      ],
    });
  }
  // THE SUPPLIER'S CREDIT FOR RETURNED STOCK, in its own month, as its own row.
  for (const id of tied) {
    const b = k.bill.get(id);
    if (!b) continue;
    const day = billDay(b, tz);
    if (!inDays(day, w)) continue;
    const back = cents(Math.abs(num(b.amount)));
    credit += back;
    rows.push({
      at: `${day}T23:59:59Z`,
      row: [day, null, null, null, null, "Supplier credit for returned stock", null, null, `${b.supplier ?? "Supplier"}${b.bill_number ? ` #${b.bill_number}` : ""}`, back],
    });
  }
  rows.sort((a, b) => a.at.localeCompare(b.at));
  const out = rows.map((r) => r.row);
  if (!out.length) return { header: HEADERS.stock_used, rows: out, summaryRows: 0, total: 0 };
  out.push(totalRow(HEADERS.stock_used.length, { 4: cost, 9: credit }));
  return { header: HEADERS.stock_used, rows: out, summaryRows: 1, total: cents(cost) };
}

// ── 3. On Hand, at the end of a day ──────────────────────────────────────────

/** Consuming kinds take pieces and dollars off a roll; a job_return puts both back (0303's
 *  stock_lot_left, as of an instant). */
const TAKES = new Set(["draw", "write_off", "supplier_return", "recount_down"]);

export function onHandList(inp: AccountantInputs, asOf: string, tz: string, cutoffAt?: string | null): CsvTable {
  const k = lookups(inp);
  const end = Date.parse(cutoffEnd(windowInstants({ from: asOf, to: asOf }, tz).toAt, cutoffAt));
  const before = (m: { created_at: string; undone_at: string | null }) => !m.undone_at && Date.parse(m.created_at) < end;
  const rows: Cell[][] = [];
  let total = 0;
  const lots = inp.lots
    .filter((l) => l.live !== false && !!l.bought_on && String(l.bought_on).slice(0, 10) <= asOf)
    .sort((a, b) => {
      const an = k.item.get(String(a.item_id))?.name ?? "";
      const bn = k.item.get(String(b.item_id))?.name ?? "";
      return an.localeCompare(bn) || String(a.bought_on).localeCompare(String(b.bought_on));
    });
  for (const l of lots) {
    let pieces = num(l.pieces);
    let dollars = num(l.cost);
    for (const m of inp.moves) {
      if (String(m.lot_id ?? "") !== String(l.lot_id) || !before(m)) continue;
      if (TAKES.has(m.kind)) {
        pieces -= num(m.qty);
        dollars -= num(m.cost);
      } else if (m.kind === "job_return") {
        pieces += num(m.qty);
        dollars += num(m.cost);
      }
    }
    pieces = qty3(pieces);
    dollars = cents(dollars);
    if (pieces === 0 && dollars === 0) continue;
    total += dollars;
    const b = l.bill_id ? k.bill.get(String(l.bill_id)) : undefined;
    rows.push([
      k.item.get(String(l.item_id))?.name ?? "An item",
      l.unit,
      pieces,
      dollars,
      String(l.bought_on).slice(0, 10),
      l.kind === "opening" ? "Counted in, no receipt" : (b?.supplier ?? null),
      b?.bill_number ?? null,
      l.note ?? null,
    ]);
  }
  // Pieces found on a count (no roll, $0) and pieces taken past the shelf (no roll yet), per item.
  const extra = new Map<string, { found: number; short: number }>();
  for (const m of inp.moves) {
    if (!before(m) || m.lot_id) continue;
    const e = extra.get(String(m.item_id)) ?? { found: 0, short: 0 };
    if (m.kind === "recount_up") e.found += num(m.qty);
    else if (m.kind === "short" && !m.settled_by) e.short += num(m.qty);
    extra.set(String(m.item_id), e);
  }
  for (const [itemId, e] of extra) {
    const it = k.item.get(itemId);
    if (e.found) rows.push([it?.name ?? "An item", it?.unit ?? null, qty3(e.found), 0, null, null, null, "Found on a count, no receipt behind them"]);
    if (e.short) rows.push([it?.name ?? "An item", it?.unit ?? null, qty3(-e.short), 0, null, null, null, "Taken past the shelf, no roll yet"]);
  }
  if (!rows.length) return { header: HEADERS.on_hand, rows, summaryRows: 0, total: 0 };
  rows.push(totalRow(HEADERS.on_hand.length, { 3: total }));
  return { header: HEADERS.on_hand, rows, summaryRows: 1, total: cents(total) };
}

// ── 4. Tools ─────────────────────────────────────────────────────────────────

const isToolsLine = (l: BillLine) => /^tools?$/i.test(String(l.category ?? "").trim());

/** What a line cost the company with its share of the ticket's tax, as if nothing on the ticket
 *  were billed: every purchased line off, the tax untouched (shelfLotCost's own arithmetic). */
function ownCostWithTax(line: BillLine, all: BillLine[]): number {
  const off = all.map((l) => (isTaxLine(l) ? l : { ...l, billable: false }));
  const i = all.indexOf(line);
  return shelfLotCost(off[i], off);
}

export function toolsList(inp: AccountantInputs, w: Window, tz: string): CsvTable {
  const k = lookups(inp);
  const rows: { day: string; row: Cell[] }[] = [];
  let total = 0;
  // The shelf's rolls per ticket, and the credits tied to a return (they are Stock Used's).
  const rollsOf = new Map<string, { cost: number; lineIds: Set<string> }>();
  for (const l of inp.lots) {
    if (l.live === false || !l.bill_id) continue;
    const r = rollsOf.get(String(l.bill_id)) ?? { cost: 0, lineIds: new Set<string>() };
    r.cost += Math.round(num(l.cost) * 100);
    if (l.bill_line_id) r.lineIds.add(String(l.bill_line_id));
    rollsOf.set(String(l.bill_id), r);
  }
  const tied = new Set(inp.moves.filter((m) => !m.undone_at && m.kind === "supplier_return" && m.credit_bill_id).map((m) => String(m.credit_bill_id)));
  for (const b of inp.bills) {
    const day = billDay(b, tz);
    if (!inDays(day, w)) continue;
    const lines = k.linesOf.get(String(b.id)) ?? [];
    if (b.on_shelf) {
      // A SHELF TICKET: its rolls are Stock Bought; whatever of it isn't a roll (a tester, the
      // Not Stock lines, their tax, freight) is what Owner Money counts in Tools & Supplies, so it is
      // here too, as it was paid. A credit tied to a return is Stock Used's, not here.
      if (b.job_id || tied.has(String(b.id))) continue;
      const r = rollsOf.get(String(b.id));
      const rest = (Math.round(num(b.amount) * 100) - (r?.cost ?? 0)) / 100;
      if (Math.abs(rest) < 0.005) continue;
      const what = lines
        .filter((l) => !isTaxLine(l) && !r?.lineIds.has(String(l.id)))
        .map((l) => String(l.description ?? "").trim())
        .filter(Boolean)
        .join("; ");
      total += rest;
      rows.push({ day: day!, row: [day, b.supplier ?? null, b.bill_number ?? null, what || "(tax and charges on the ticket)", cents(rest), "Shelf ticket, not rolls", null] });
      continue;
    }
    const bucket = bucketOf(b.category);
    if (!b.job_id && bucket === "Tools & Supplies") {
      // A ticket filed as Tools & Supplies: the whole ticket, as it was paid.
      const what = lines.filter((l) => !isTaxLine(l)).map((l) => String(l.description ?? "").trim()).filter(Boolean).join("; ");
      const cost = cents(num(b.amount));
      total += cost;
      rows.push({ day: day!, row: [day, b.supplier ?? null, b.bill_number ?? null, what || "(no lines on the ticket)", cost, "Tools & Supplies ticket", null] });
      continue;
    }
    // Tools lines on any other ticket: the part the company kept (not billed to a customer), tax share
    // included. A line billed to the customer in full is on the report-only list, not here.
    for (const l of lines) {
      if (!isToolsLine(l) || !(billLineCost(l) > 0)) continue;
      const cost = cents(b.job_id ? shelfLotCost(l, lines) : ownCostWithTax(l, lines));
      if (!(cost > 0)) continue;
      total += cost;
      const j = b.job_id ? k.job.get(String(b.job_id)) : undefined;
      rows.push({
        day: day!,
        row: [day, b.supplier ?? null, b.bill_number ?? null, String(l.description ?? "").trim(), cost, b.job_id ? "Kept off a job's receipt (not billed)" : bucket, j?.job_number ?? null],
      });
    }
  }
  rows.sort((a, b) => a.day.localeCompare(b.day));
  const out = rows.map((r) => r.row);
  if (!out.length) return { header: HEADERS.tools, rows: out, summaryRows: 0, total: 0 };
  out.push(totalRow(HEADERS.tools.length, { 4: total }));
  return { header: HEADERS.tools, rows: out, summaryRows: 1, total: cents(total) };
}

/**
 * TOOLS ALREADY BILLED TO CUSTOMERS: report only. Tools lines on job receipts that a customer was
 * billed for (at cost, the part billed), with the invoice holding the receipt. Nothing here changes
 * anything; the office decides what, if anything, to do about them.
 */
export function toolsBilledList(inp: AccountantInputs, tz: string): CsvTable {
  const k = lookups(inp);
  const heldBy = new Map<string, string[]>();
  for (const c of inp.claims) {
    for (const id of claimedIdsOfLines([{ source_ids: c.source_ids, import_key: c.import_key }])) {
      const arr = heldBy.get(id) ?? [];
      const n = c.invoice_number || "an invoice";
      if (!arr.includes(n)) arr.push(n);
      heldBy.set(id, arr);
    }
  }
  const rows: { day: string; row: Cell[] }[] = [];
  for (const b of inp.bills) {
    if (!b.job_id) continue;
    const j = k.job.get(String(b.job_id));
    for (const l of k.linesOf.get(String(b.id)) ?? []) {
      if (!isToolsLine(l)) continue;
      const billed = cents(billLineBilledCost(l));
      if (!(billed > 0)) continue;
      const day = billDay(b, tz) ?? "";
      rows.push({
        day,
        row: [day, b.supplier ?? null, j?.job_number ?? null, j?.name ?? null, String(l.description ?? "").trim(), billed, (heldBy.get(String(b.id)) ?? []).join("; ") || "Not on an invoice yet"],
      });
    }
  }
  rows.sort((a, b) => a.day.localeCompare(b.day));
  return { header: HEADERS.tools_billed, rows: rows.map((r) => r.row) };
}

/** One list by its key, over the window (On Hand is as of the window's last day). A download passes
 *  `cutoffAt` (cutoffEnd); the page's preview doesn't. */
export function accountantList(key: AccountantListKey, inp: AccountantInputs, w: Window, tz: string, cutoffAt?: string | null): CsvTable {
  switch (key) {
    case "stock_bought":
      return stockBoughtList(inp, w, tz);
    case "stock_used":
      return stockUsedList(inp, w, tz, cutoffAt);
    case "on_hand":
      return onHandList(inp, w.to, tz, cutoffAt);
    case "tools":
      return toolsList(inp, w, tz);
  }
}

/** Data rows in a list (the Total rows are not). */
export function dataRowCount(t: CsvTable): number {
  return t.summaryRows != null ? t.rows.length - t.summaryRows : t.rows.filter((r) => r[0] !== "Total").length;
}

/**
 * The window a download covered, for 0350's record: On Hand is everything before the end of its day.
 * It ends at `cutoffAt` when that is earlier (cutoffEnd), the same instant the list was cut at, so
 * the moves 0350 freezes are the moves the file carried. A window wholly after the cutoff carried
 * nothing; its record still has to satisfy from_at < to_at, and freezes nothing (no move is later).
 */
export function exportWindow(key: AccountantListKey, w: Window, tz: string, cutoffAt?: string | null): { from_at: string | null; to_at: string } {
  const { fromAt, toAt } = windowInstants(w, tz);
  let to = cutoffEnd(toAt, cutoffAt);
  if (key === "on_hand") return { from_at: null, to_at: to };
  if (Date.parse(to) <= Date.parse(fromAt)) to = new Date(Date.parse(fromAt) + 1).toISOString();
  return { from_at: fromAt, to_at: to };
}

/**
 * 0350's accountant_exports not on this database yet: the table itself is missing (Postgres 42P01,
 * PostgREST PGRST205), and nothing else. A refusal that merely NAMES the table (row-level security,
 * permission denied, a check) is a real failure: the download must not go out unrecorded.
 */
export function isMissingExportRecord(err: unknown): boolean {
  const code = String((err as { code?: string } | null)?.code ?? "");
  const msg = String((err as { message?: string } | null)?.message ?? "");
  return code === "42P01" || code === "PGRST205" || (/accountant_exports/.test(msg) && /does not exist|could not find the table/i.test(msg));
}

/** A download's cutoff: a few seconds before now, so a move whose database clock reads a hair ahead
 *  of this server's is never in the record's window without being in the file. */
export function downloadCutoff(now = Date.now()): string {
  return new Date(now - 5_000).toISOString();
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** A window from the page's ?from=&to=, or this month to today. Invalid or reversed dates fall back. */
export function parseWindow(from: unknown, to: unknown, todayYmd: string): Window {
  const ok = (v: unknown): v is string => typeof v === "string" && YMD.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`));
  const f = ok(from) ? from : `${todayYmd.slice(0, 7)}-01`;
  const t = ok(to) ? to : todayYmd;
  return f <= t ? { from: f, to: t } : { from: `${todayYmd.slice(0, 7)}-01`, to: todayYmd };
}

// ── The read ─────────────────────────────────────────────────────────────────

type Sb = { from: (t: string) => any };

/**
 * Everything the four lists read, for ONE company. Before 0303 there is no shelf (the stock lists are
 * empty, said by the page); before 0350 there is no credit column (no return is tied). Any other
 * failure is an error, never an empty list.
 *
 * EVERY READ IS PAGED (readAllPages, ordered by id): PostgREST cuts a select at db-max-rows with no
 * error, and a list handed to the accountant must never be quietly short. A read that can't be had
 * whole is a failure, said in words.
 */
export async function readAccountantInputs(supabase: Sb, orgId: string): Promise<{ ok: true; inputs: AccountantInputs; shelf: boolean } | { ok: false; error: string }> {
  const all = <T>(table: string, cols: string, build?: (q: any) => any, orderBy = "id") =>
    readAllPages<T>((from, to) => {
      let q = supabase.from(table).select(cols).eq("org_id", orgId);
      if (build) q = build(q);
      return q.order(orderBy).range(from, to);
    });
  const [items, lotBal, lotRows, bills, jobs] = await Promise.all([
    all<AccountantInputs["items"][number]>("inventory_items", "id, name, unit"),
    all<any>("stock_lot_balance", "lot_id, item_id, kind, bill_id, bill_line_id, pieces, unit, cost, bought_on, live", undefined, "lot_id"),
    all<any>("stock_lots", "id, note"),
    all<AccountantInputs["bills"][number]>(
      "bills",
      "id, supplier, bill_number, bill_date, created_at, job_id, amount, category, on_shelf",
      (q) => q.is("superseded_by_bill_id", null),
    ),
    all<AccountantInputs["jobs"][number]>("jobs", "id, job_number, name"),
  ]);
  const shelf = !(lotBal.error && isMissingShelf(lotBal.error));
  for (const r of [items, bills, jobs]) if (r.error) return { ok: false, error: "The books couldn't be read just now. Nothing was made; try again." };
  if (lotBal.error && shelf) return { ok: false, error: "The shelf couldn't be read just now. Nothing was made; try again." };

  let moves: any[] = [];
  if (shelf) {
    const cols = "id, item_id, lot_id, job_id, kind, qty, cost, note, created_at, undone_at, settled_by";
    let r = await all<any>("stock_moves", `${cols}, credit_bill_id`);
    if (r.error && isMissingCreditColumn(r.error)) r = await all<any>("stock_moves", cols);
    if (r.error) return { ok: false, error: "The shelf's record couldn't be read just now. Nothing was made; try again." };
    moves = r.rows;
  }

  const billRows = bills.rows;
  // Lines, and which invoices hold which receipt, only for the tickets the tool lists can reach.
  const ids = billRows.map((b) => String(b.id));
  const lines: any[] = [];
  const claims: AccountantInputs["claims"] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const [ls, cs] = await Promise.all([
      all<any>("bill_line_items", "id, bill_id, description, quantity, unit_price, amount, category, billable, billed_amount, sort_order", (q) => q.in("bill_id", chunk)),
      all<any>("invoice_items", "id, source_ids, import_key, invoices!inner(invoice_number, status)", (q) =>
        q.neq("invoices.status", "void").overlaps("source_ids", chunk),
      ),
    ]);
    if (ls.error || cs.error) return { ok: false, error: "The receipts couldn't be read just now. Nothing was made; try again." };
    lines.push(...ls.rows);
    for (const c of cs.rows) claims.push({ source_ids: c.source_ids ?? null, import_key: c.import_key ?? null, invoice_number: c.invoices?.invoice_number ?? null });
  }
  // A ticket's lines in their own order (they were paged by id).
  lines.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || String(a.id).localeCompare(String(b.id)));
  const noteOf = new Map(((lotRows.error ? [] : lotRows.rows) ?? []).map((r: any) => [String(r.id), r.note ?? null]));
  return {
    ok: true,
    shelf,
    inputs: {
      items: items.rows,
      lots: ((lotBal.error ? [] : lotBal.rows) ?? []).map((l: any) => ({ ...l, note: noteOf.get(String(l.lot_id)) ?? null })),
      moves,
      bills: billRows,
      lines,
      jobs: jobs.rows,
      claims,
    },
  };
}
