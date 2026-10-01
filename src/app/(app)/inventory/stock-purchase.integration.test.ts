import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { assertTestDatabase, notOnThisDatabase } from "@/lib/db-guard";

/**
 * SHOP STOCK, TYPED IN (W1-FU-misc B), WHERE IT MEETS THE DATABASE.
 *
 * The REAL server action (addStockPurchase: requireStaff → insertItemizedBill → shelveLines →
 * shelve_bill_lines, 0328) and the REAL Undo (deleteBill → stock_line_deleted, 0303; 0304's freeze
 * after a take) run against the test database through a PostgREST-shaped shim over one pg
 * connection, speaking as the company's office exactly as PostgREST does. Proven here:
 *   · a typed purchase makes ONE on_shelf bill (no job, Shop Stock, On Account never paid), ONE line
 *     and ONE live lot at the whole amount;
 *   · its cost counts in the month bought (the P&L's own reader, computeOwnerMoney: Stock Bought);
 *   · Undo takes the lot out of stock; after a take, Undo is refused in plain words;
 *   · a unit mismatch on an existing item is refused in words, and nothing is written (a new item
 *     whose name is already in stock in another unit is refused too, and its bill comes back off);
 *   · a tech can't, and another company's item can't be named.
 *
 * ONE transaction, BEGIN first, always rolled back, in two TEST companies minted inside it
 * (throwaway-org.db-fixture.ts); every fixture is dated 2001 and named TEST. No DDL.
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

const state = vi.hoisted(() => ({ member: null as any, reported: [] as unknown[][] }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => state.member?.supabase,
  createServiceClient: () => {
    throw new Error("no service client in this suite");
  },
}));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: async () => (state.member?.staff ? state.member : { error: "This action is staff-only." }),
  requireMember: async () => state.member,
}));
vi.mock("@/lib/observe", () => ({ reportError: (...a: unknown[]) => void state.reported.push(a) }));

import { addStockPurchase } from "./actions";
import { deleteBill } from "@/app/(app)/jobs/actions";
import { mintOrgAndStranger } from "@/lib/throwaway-org.db-fixture";
import { PG_TYPES, postgrestShim } from "@/lib/postgrest-shim.db-fixture";
import { computeOwnerMoney, ownerMoneyWindow, type OwnerMoneyInputs } from "@/lib/analytics/owner-money";

d("Shop Stock typed in: one bill on no job, one line, one roll, its month, its Undo", () => {
  let c: pg.Client;
  let ready = false;
  let orgId = "";
  let staffId = "";
  let techId = "";
  let otherOrgId = "";
  let otherStaffId = "";
  let jobId = "";

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const rows = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;
  const asOffice = () => (state.member = { supabase: postgrestShim(c, staffId), userId: staffId, orgId, staff: true });
  const needs = () => ready || notOnThisDatabase("[stock-purchase] the stock ledger (0303/0304/0328) is not on this database; nothing to test against.");
  const billsInOrg = async () => Number((await one("select count(*)::int as n from public.bills where org_id = $1", [orgId])).n);
  const buy = (over: Record<string, unknown> = {}) =>
    addStockPurchase({
      newItemName: "TEST 12/2 NM-B",
      pieces: 250,
      unit: "ft",
      amount: 180,
      date: "2001-08-19",
      where: "TEST CED",
      paid: "unpaid",
      billNumber: "TEST-8802",
      ...over,
    } as any);

  beforeAll(async () => {
    c = new pg.Client({
      host: TEST_DB_HOST,
      port: 5432,
      user: TEST_DB_USER,
      password: TEST_DBPW,
      database: "postgres",
      ssl: { rejectUnauthorized: false },
      types: PG_TYPES,
    });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    const has = await one(
      `select to_regclass('public.stock_lot_balance') is not null as ledger,
              to_regprocedure('public.shelve_bill_lines(uuid, jsonb, jsonb)') is not null as shelve,
              to_regprocedure('public.stock_takes_on_bill(uuid)') is not null as freeze`,
    );
    ready = !!(has.ledger && has.shelve && has.freeze);
    if (!ready) return;
    const fx = await mintOrgAndStranger(c, "stock-purchase");
    orgId = fx.orgId;
    staffId = fx.staffId;
    techId = fx.techId;
    otherOrgId = fx.otherOrgId;
    otherStaffId = fx.otherStaffId;
    jobId = (
      await one(
        "insert into public.jobs (org_id, name, job_number, status, billing_type) values ($1, 'TEST 12 Elm', 'TEST-SP-J1', 'in_progress', 'tm') returning id",
        [orgId],
      )
    ).id;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("the shim speaks as the office exactly as PostgREST does (auth.uid(), the signed-in role, RLS)", async () => {
    if (!needs()) return;
    expect((await postgrestShim(c, staffId).rpc("auth_org_id")).data).toBe(orgId);
    expect((await postgrestShim(c, otherStaffId).rpc("auth_org_id")).data).toBe(otherOrgId);
    expect((await postgrestShim(c, null).rpc("auth_org_id")).data).toBeNull();
    // Another company's office reads none of this company's stock items.
    await c.query("insert into public.inventory_items (org_id, name, unit) values ($1, 'TEST Shim Probe', 'ea')", [orgId]);
    const theirs = await postgrestShim(c, otherStaffId).from("inventory_items").select("id").eq("name", "TEST Shim Probe");
    expect(theirs).toMatchObject({ data: [], error: null });
    const ours = await postgrestShim(c, staffId).from("inventory_items").select("id").eq("name", "TEST Shim Probe");
    expect(ours.data).toHaveLength(1);
  });

  it("a typed purchase makes one on_shelf bill, one line and one live lot at the whole amount", async () => {
    if (!needs()) return;
    asOffice();
    const res = await buy();
    expect(res).toEqual({ ok: true, id: expect.any(String), message: "250 ft of TEST 12/2 NM-B in stock, $180.00 from TEST CED." });
    const bill = await one(
      "select org_id, job_id, on_shelf, category, status, amount, bill_date, supplier, bill_number, created_by from public.bills where id = $1",
      [res.id],
    );
    expect(bill).toEqual({
      org_id: orgId,
      job_id: null,
      on_shelf: true,
      category: "Shop Stock",
      status: "unpaid", // On Account is never saved as paid
      amount: 180,
      bill_date: "2001-08-19",
      supplier: "TEST CED",
      bill_number: "TEST-8802",
      created_by: staffId,
    });
    const lines = await rows("select id, description, quantity, unit_price, amount, category, billable, billed_amount from public.bill_line_items where bill_id = $1", [res.id]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ description: "TEST 12/2 NM-B", quantity: 250, unit_price: 0.72, amount: 180, category: "Materials", billable: true });
    const lots = await rows(
      `select b.lot_id, b.bill_line_id, b.pieces, b.unit, b.cost, b.live, i.name as item, i.unit as item_unit, i.org_id as item_org
         from public.stock_lot_balance b join public.inventory_items i on i.id = b.item_id
        where b.bill_id = $1`,
      [res.id],
    );
    expect(lots).toHaveLength(1);
    expect(lots[0]).toMatchObject({ bill_line_id: lines[0].id, pieces: 250, unit: "ft", cost: 180, live: true, item: "TEST 12/2 NM-B", item_unit: "ft", item_org: orgId });
  });

  it("its cost counts in the month it was bought: Stock Bought, never Materials or a business bucket", async () => {
    if (!needs()) return;
    asOffice();
    const res = await buy({ newItemName: "TEST Wire Nuts Red", pieces: 5, unit: "box", amount: 64.1, date: "2001-07-14", paid: "paid" });
    expect(res.ok).toBe(true);
    // The P&L's own reader, over this bill and its rolls as the database holds them.
    const bill = await one("select id, job_id, amount, bill_date, created_at, category, status, po_id, superseded_by_bill_id, on_shelf from public.bills where id = $1", [res.id]);
    expect(bill.status).toBe("paid");
    const lots = await rows("select lot_id, bill_id, cost, cost_left, live from public.stock_lot_balance where bill_id = $1", [res.id]);
    const inputs: OwnerMoneyInputs = {
      payments: [],
      refunds: [],
      bills: [bill],
      pos: [],
      pettyCash: [],
      entries: [],
      runs: [],
      payPayments: [],
      creditMemos: [],
      people: new Map(),
      recordsStart: null,
      shelfLots: lots,
    };
    const july = computeOwnerMoney(inputs, ownerMoneyWindow("2001-07", "2001-12-31"), "America/Los_Angeles", "2001-12-31");
    expect(july.totals.putOnShelf).toBe(64.1);
    expect(july.totals.materialsAndBills).toBe(0);
    expect(july.totals.businessCostsTotal).toBe(0);
    const august = computeOwnerMoney(inputs, ownerMoneyWindow("2001-08", "2001-12-31"), "America/Los_Angeles", "2001-12-31");
    expect(august.totals.putOnShelf).toBe(0);
  });

  it("a second purchase of the same item lands on that item, as its own roll", async () => {
    if (!needs()) return;
    asOffice();
    const item = await one("select id from public.inventory_items where org_id = $1 and name = 'TEST 12/2 NM-B'", [orgId]);
    const res = await buy({ itemId: item.id, newItemName: null, pieces: 100, amount: 75, paid: "paid", billNumber: "" });
    expect(res).toMatchObject({ ok: true, message: "100 ft of TEST 12/2 NM-B in stock, $75.00 from TEST CED." });
    const live = await rows("select pieces, cost from public.stock_lot_balance where item_id = $1 and live order by pieces", [item.id]);
    expect(live).toEqual([
      { pieces: 100, cost: 75 },
      { pieces: 250, cost: 180 },
    ]);
    expect((await one("select bill_number from public.bills where id = $1", [res.id])).bill_number).toBeNull();
  });

  it("a unit mismatch on an existing item is refused in words, and nothing is written", async () => {
    if (!needs()) return;
    asOffice();
    const before = await billsInOrg();
    const item = await one("select id from public.inventory_items where org_id = $1 and name = 'TEST 12/2 NM-B'", [orgId]);
    expect(await buy({ itemId: item.id, newItemName: null, unit: "ea", pieces: 3 })).toEqual({
      ok: false,
      error: "TEST 12/2 NM-B is counted in ft. Count this in ft, or make a new item for ea.",
    });
    expect(await billsInOrg()).toBe(before);
    // The same name typed as a new item, in another unit: the stock ledger refuses it, and the bill it
    // wrote comes back off (there is never a stock bill with nothing in stock).
    const named = await buy({ newItemName: "TEST 12/2 NM-B", unit: "ea", pieces: 3 });
    expect(named.ok).toBe(false);
    expect(named.error).toMatch(/^TEST 12\/2 NM-B is already in stock, counted in ft .* Count this in ft, or give it a different name\. Nothing was recorded\.$/);
    expect(await billsInOrg()).toBe(before);
  });

  it("the sheet's words, server-side: what it is, how many, the unit, where", async () => {
    if (!needs()) return;
    asOffice();
    const before = await billsInOrg();
    expect(await buy({ newItemName: " " })).toEqual({ ok: false, error: "Pick or name the item." });
    expect(await buy({ pieces: 0 })).toEqual({ ok: false, error: "Type how many." });
    expect(await buy({ unit: " " })).toEqual({ ok: false, error: "Say the unit." });
    expect(await buy({ where: "" })).toEqual({ ok: false, error: "Say where it was bought." });
    expect(await buy({ amount: 0 })).toEqual({ ok: false, error: "Type the amount." });
    expect(await billsInOrg()).toBe(before);
  });

  it("Undo takes the roll back out of stock and the bill off the books", async () => {
    if (!needs()) return;
    asOffice();
    const res = await buy({ newItemName: "TEST Romex 14/2", pieces: 50, amount: 40 });
    expect(res.ok).toBe(true);
    const lot = await one("select lot_id from public.stock_lot_balance where bill_id = $1 and live", [res.id]);
    expect(lot?.lot_id).toBeTruthy();
    expect(await deleteBill(res.id!, "")).toEqual({ ok: true });
    expect(await one("select count(*)::int as n from public.bills where id = $1", [res.id])).toEqual({ n: 0 });
    const gone = await one("select unshelved_at is not null as off, bill_line_id from public.stock_lots where id = $1", [lot.lot_id]);
    expect(gone).toEqual({ off: true, bill_line_id: null });
    expect(await one("select count(*)::int as n from public.stock_lot_balance where lot_id = $1 and live", [lot.lot_id])).toEqual({ n: 0 });
  });

  it("after a piece of it went on a job, Undo is refused in plain words, and the purchase stays", async () => {
    if (!needs()) return;
    asOffice();
    const res = await buy({ newItemName: "TEST Breaker 20A", pieces: 6, unit: "ea", amount: 54 });
    expect(res.ok).toBe(true);
    const item = await one("select item_id from public.stock_lot_balance where bill_id = $1 and live", [res.id]);
    // A take onto the job, as the office, through the one door pieces leave by (stock_draw).
    await c.query("savepoint take");
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: staffId, role: "authenticated" })]);
    await c.query("set local role authenticated");
    await c.query("select public.stock_draw(p_item => $1, p_job => $2, p_qty => 1, p_note => null, p_source => 'office')", [item.item_id, jobId]);
    await c.query("release savepoint take");
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
    const undo = await deleteBill(res.id!, "");
    expect(undo.ok).toBe(false);
    expect(undo.error).toMatch(/already on a job, so the ticket can't be deleted\. Undo the take from this roll first\./);
    expect(await one("select count(*)::int as n from public.bills where id = $1", [res.id])).toEqual({ n: 1 });
  });

  it("a tech can't type one in, and another company's item can't be named", async () => {
    if (!needs()) return;
    state.member = { supabase: postgrestShim(c, techId), userId: techId, orgId, staff: false };
    const before = await billsInOrg();
    expect(await buy()).toEqual({ ok: false, error: "This action is staff-only." });
    asOffice();
    const theirs = (
      await one("insert into public.inventory_items (org_id, name, unit) values ($1, 'TEST Their Coil', 'ft') returning id", [otherOrgId])
    ).id;
    expect(await buy({ itemId: theirs, newItemName: null })).toEqual({ ok: false, error: "That item isn't in this company's stock any more. Reload and pick again." });
    expect(await billsInOrg()).toBe(before);
    expect(otherStaffId).toBeTruthy();
  });
});
