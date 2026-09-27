import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LIVE_ORGS, mintOrgAndStranger } from "@/lib/throwaway-org.db-fixture";
import { assertTestDatabase, notOnThisDatabase } from "@/lib/db-guard";

/**
 * Migration 0357: Already Billed, where its rules live.
 *
 * Erik, 2026-09-26: "i have a bill for purple sage that was already charged and i have no way to
 * associate it to the paid invoice becuase i did it manually". mark_already_billed lets a line on a
 * sent invoice claim what it already charged for; unmark_already_billed takes back only what a person
 * added. Pinned against the real database, inside ONE transaction that is always rolled back, in a
 * TEST company minted inside it (and a stranger company beside it):
 *   · a mark lands on the claim lists only: the line's total, the invoice's total and its status never
 *     move, the line is not marked edited, and a sibling draw's stored PDF is un-stamped;
 *   · every refusal the plan lists, in words, with nothing changed;
 *   · a return goes on a negative line typed by hand; an order, closed shifts and a whole take land;
 *   · a customer's invoice with no job takes rows from that customer's jobs, never another's;
 *   · Undo takes off only what a person added, and a split shift comes off whole;
 *   · a split carries the hand claim onto the new piece (and a piece split from a piece), and a join
 *     takes the absorbed piece off both lists;
 *   · the Purple Sage shape: a receipt with part of it on the shelf is claimed by a hand line, after
 *     which the shelf refuses it until the claim comes off.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 *   ALREADY_BILLED_APPLY=1 applies this checkout's 0357 inside the rolled-back transaction, whether
 *   or not the TEST database already has a copy of it (refused on production).
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER, ALREADY_BILLED_APPLY } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const PRODUCTION_REF = "rbpokaozcxqownollqlx";
const isProduction = `${TEST_DB_HOST ?? ""} ${TEST_DB_USER ?? ""}`.includes(PRODUCTION_REF);
if (ALREADY_BILLED_APPLY === "1" && isProduction) throw new Error("already-billed: ALREADY_BILLED_APPLY=1 is refused on the production database.");
const MIGRATION = fileURLToPath(new URL("../../supabase/migrations/0357_already_billed.sql", import.meta.url));

d("0357: Already Billed", () => {
  let c: pg.Client;
  let ready = false;
  let org = "";
  let staff = "";
  let tech = "";
  let strangerOrg = "";
  let stranger = "";
  let cust = "";
  let otherCust = "";
  let jobA = "";
  let jobB = "";
  let jobOther = "";
  let seq = 0;

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const as = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  /** Run as `who`, inside a savepoint that is always rolled back: the refusal's words, or null. */
  const refusal = async (who: string, fn: () => Promise<unknown>): Promise<{ message: string; code: string } | null> => {
    await c.query("savepoint attempt");
    try {
      await as(who);
      await fn();
      await c.query("rollback to savepoint attempt");
      return null;
    } catch (e: any) {
      await c.query("rollback to savepoint attempt");
      return { message: String(e?.message ?? e), code: String(e?.code ?? "") };
    } finally {
      await asServer();
    }
  };
  const mark = async (who: string, line: string, ids: string[]) => {
    await as(who);
    try {
      return (await one("select public.mark_already_billed($1, $2::uuid[]) as r", [line, ids])).r;
    } finally {
      await asServer();
    }
  };
  const unmark = async (who: string, line: string, ids: string[], whole?: boolean) => {
    await as(who);
    try {
      if (whole !== undefined) return (await one("select public.unmark_already_billed($1, $2::uuid[], $3) as r", [line, ids, whole])).r;
      return (await one("select public.unmark_already_billed($1, $2::uuid[]) as r", [line, ids])).r;
    } finally {
      await asServer();
    }
  };
  const tryMark = (who: string, line: string, ids: string[]) => refusal(who, () => c.query("select public.mark_already_billed($1, $2::uuid[])", [line, ids]));
  const tryUnmark = (who: string, line: string, ids: string[]) => refusal(who, () => c.query("select public.unmark_already_billed($1, $2::uuid[])", [line, ids]));

  // ── fixtures, as the server ──
  const newJob = async (customer: string, label: string, orgId = org, billing = "tm") =>
    (
      await one(
        `insert into public.jobs (org_id, customer_id, name, job_number, status, billing_type)
         values ($1, $2, $3, $3, 'in_progress', $4) returning id`,
        [orgId, customer, `TEST-AB-${label}`, billing],
      )
    ).id as string;
  const invoice = async (job: string | null, status: string, kind = "standard", customer: string | null = cust, orgId = org) =>
    (
      await one(
        `insert into public.invoices (org_id, customer_id, job_id, invoice_number, status, invoice_kind, subtotal, total)
         values ($1, $2, $3, $4, $5, $6, 0, 0) returning id`,
        [orgId, customer, job, `TEST-AB-${++seq}`, status, kind],
      )
    ).id as string;
  const line = async (
    inv: string,
    o: { description?: string; qty?: number; price?: number; source?: string | null; key?: string | null; edited?: boolean; ids?: string[]; kind?: string | null; unit?: string },
    orgId = org,
  ) =>
    (
      await one(
        `insert into public.invoice_items (org_id, invoice_id, description, quantity, unit, unit_price, import_source, import_key, edited, source_ids, line_kind)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[], $11) returning id`,
        [orgId, inv, o.description ?? "TEST line", o.qty ?? 1, o.unit ?? "ea", o.price ?? 100, o.source ?? null, o.key ?? null, o.edited ?? false, o.ids ?? [], o.kind ?? null],
      )
    ).id as string;
  /** The invoice's total from its lines, the way recalcInvoice keeps it (no tax). */
  const settleTotal = async (inv: string) =>
    c.query(
      `update public.invoices i set subtotal = x.s, total = x.s
         from (select coalesce(sum(line_total), 0) as s from public.invoice_items where invoice_id = $1) x
        where i.id = $1`,
      [inv],
    );
  const bill = async (job: string, amount: number, o: { superseded?: string | null; po?: string | null } = {}) =>
    (
      await one(
        `insert into public.bills (org_id, job_id, supplier, bill_number, amount, bill_date, status, po_id, superseded_by_bill_id)
         values ($1, $2, 'TEST CED', $3, $4, '2001-06-16', 'paid', $5, $6) returning id`,
        [org, job, `TEST-AB-B${++seq}`, amount, o.po ?? null, o.superseded ?? null],
      )
    ).id as string;
  const po = async (job: string, status: string, total: number) =>
    (
      await one(
        `insert into public.purchase_orders (org_id, job_id, po_number, vendor, status, total) values ($1, $2, $3, 'TEST CED', $4, $5) returning id`,
        [org, job, `TEST-AB-PO${++seq}`, status, total],
      )
    ).id as string;
  // One person is in one place at a time (0360): each day's shift is its own, and a running clock is
  // someone else's (the office's), so it never overlaps the tech's later shifts.
  const shift = async (job: string | null, day: string, open = false, who = tech) =>
    (
      await one(
        `insert into public.time_entries (org_id, profile_id, job_id, clock_in, clock_out, lunch_minutes, status, source)
         values ($1, $2, $3, $4, $5, 0, $6, 'manual') returning id`,
        [org, who, job, `${day}T15:00:00Z`, open ? null : `${day}T23:00:00Z`, open ? "open" : "closed"],
      )
    ).id as string;
  const state = async (lineId: string) =>
    one(
      `select ii.source_ids::text[] as source_ids, ii.hand_claims::text[] as hand, ii.line_total::text as line_total, ii.edited,
              i.total::text as total, i.status::text as status
         from public.invoice_items ii join public.invoices i on i.id = ii.invoice_id where ii.id = $1`,
      [lineId],
    );

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    let has = (await one("select to_regprocedure('public.mark_already_billed(uuid, uuid[])') is not null as yes")).yes === true;
    if (ALREADY_BILLED_APPLY === "1" && !isProduction) {
      await c.query(readFileSync(MIGRATION, "utf8"));
      has = (await one("select to_regprocedure('public.mark_already_billed(uuid, uuid[])') is not null as yes")).yes === true;
    }
    if (!has) return;
    const fx = await mintOrgAndStranger(c, "0357");
    if (LIVE_ORGS.has(fx.orgId) || LIVE_ORGS.has(fx.otherOrgId)) throw new Error("already-billed: refusing to write in a live company's org.");
    org = fx.orgId;
    staff = fx.staffId;
    tech = fx.techId;
    strangerOrg = fx.otherOrgId;
    stranger = fx.otherStaffId;
    cust = (await one("insert into public.customers (org_id, name) values ($1, 'TEST AB Purple Sage') returning id", [org])).id;
    otherCust = (await one("insert into public.customers (org_id, name) values ($1, 'TEST AB someone else') returning id", [org])).id;
    jobA = await newJob(cust, "A");
    jobB = await newJob(cust, "B");
    jobOther = await newJob(otherCust, "OTHER");
    ready = true;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  const go = () => ready || notOnThisDatabase("[already-billed] 0357 is not on this database yet; apply it with scripts/test-db/rebuild.cjs (or ALREADY_BILLED_APPLY=1).");

  it("a hand line on a paid invoice claims a receipt: only the claim lists change, and a sibling draw's stored PDF is un-stamped", async () => {
    if (!go()) return;
    const inv = await invoice(jobA, "paid");
    const materials = await line(inv, { description: "Materials", price: 110 });
    await settleTotal(inv);
    const receipt = await bill(jobA, 186.93);
    // A draw on the same job with a stored customer copy: its Progress Summary counts what is billed.
    const draw = await invoice(jobA, "sent", "progress");
    await line(draw, { description: "TEST labor", source: "labor", key: "labor:x", ids: [] });
    await c.query(
      `insert into public.doc_pdf_cache (doc, doc_id, margin, fingerprint, path, doc_status, org_id)
       values ('invoice', $1, 0.75, 'fp', $2, 'sent', $3)`,
      [draw, `${org}/invoice/${draw}/m0.75.pdf`, org],
    );
    const before = await state(materials);

    const r = await mark(staff, materials, [receipt]);
    expect(r.invoice_id).toBe(inv);
    expect(r.added).toEqual([receipt]);

    const after = await state(materials);
    expect(after.source_ids).toEqual([receipt]);
    expect(after.hand).toEqual([receipt]);
    expect(after.line_total).toBe(before.line_total);
    expect(after.total).toBe(before.total);
    expect(after.status).toBe("paid");
    expect(after.edited).toBe(false);
    const stamp = await one("select doc_status from public.doc_pdf_cache where doc = 'invoice' and doc_id = $1", [draw]);
    expect(stamp.doc_status).toBe("");
  });

  it("refuses every case the plan names, in words, and changes nothing", async () => {
    if (!go()) return;
    const paid = await invoice(jobA, "paid");
    const hand = await line(paid, { description: "Materials", price: 250 });
    const discount = await line(paid, { description: "Discount", price: -120 });
    const zero = await line(paid, { description: "Nothing", price: 0 });
    const imported = await line(paid, { description: "TEST import", source: "costs", key: "bill:00000000-0000-4000-8000-000000000001", ids: [] });
    const importedNeg = await line(paid, { description: "Returned: TEST", price: -10, source: "costs", key: "bill:00000000-0000-4000-8000-000000000002", edited: true });
    const credit = await line(paid, { description: "Less previous billings", price: -50, source: "draw_credit" });
    const fee = await line(paid, { description: "Card fee", price: 12, kind: "other" });
    await settleTotal(paid);
    const draft = await invoice(jobA, "draft");
    const draftLine = await line(draft, { description: "Materials" });
    const voided = await invoice(jobA, "void");
    const voidLine = await line(voided, { description: "Materials" });
    const deposit = await invoice(jobA, "paid", "deposit");
    const depositLine = await line(deposit, { description: "Deposit" });
    const lumpDraw = await invoice(jobA, "sent", "progress");
    const lumpLine = await line(lumpDraw, { description: "50% of the contract" });
    const milestoneDraw = await invoice(jobA, "sent", "final");
    await line(milestoneDraw, { description: "TEST labor", source: "labor", key: "labor:y" });
    const milestone = await line(milestoneDraw, { description: "Rough-in", source: "milestone" });

    const receipt = await bill(jobA, 60);
    const kept = await bill(jobA, 70);
    const copy = await bill(jobA, 70, { superseded: kept });
    const elsewhere = await bill(jobB, 40);
    const nothing = await bill(jobA, 0);
    const ret = await bill(jobA, -25);
    const draftPo = await po(jobA, "draft", 300);
    const billedPo = await po(jobA, "sent", 300);
    await bill(jobA, 300, { po: billedPo });
    const running = await shift(jobA, "2001-06-20", true, staff);
    const otherJobShift = await shift(jobB, "2001-06-21");
    // Already on another invoice (an import on INV-X), and already on this one.
    const other = await invoice(jobA, "sent");
    const onOther = await bill(jobA, 33);
    await line(other, { description: "TEST imported", source: "costs", key: `bill:${onOther}`, ids: [onOther] });
    const onHere = await bill(jobA, 44);
    await line(paid, { description: "TEST imported", source: "costs", key: `bill:${onHere}`, ids: [onHere], edited: true });

    const before = await state(hand);
    const cases: [string, { message: string; code: string } | null, RegExp][] = [];
    // Serially, one savepoint at a time.
    const run = async (name: string, who: string, lineId: string, ids: string[], re: RegExp) => {
      cases.push([name, await tryMark(who, lineId, ids), re]);
    };
    await run("a tech", tech, hand, [receipt], /Only the office/);
    await run("another company's office, on this line", stranger, hand, [receipt], /not found/);
    await run("a draft", staff, draftLine, [receipt], /still a draft: Add To TEST-AB-\d+ puts it there/);
    await run("a void invoice", staff, voidLine, [receipt], /is void/);
    await run("a deposit", staff, depositLine, [receipt], /is a deposit/);
    await run("a credit line", staff, credit, [ret], /credit for earlier payments/);
    await run("a lump line on a draw that bills no rows", staff, lumpLine, [receipt], /set part of the contract/);
    await run("a contract (milestone) line", staff, milestone, [receipt], /set part of the contract/);
    await run("a $0 line", staff, zero, [receipt], /\$0\.00, so it charged for nothing/);
    await run("an imported line nobody edited", staff, imported, [receipt], /came from an import and nobody has changed it/);
    await run("a charge filed as Other", staff, fee, [receipt], /filed as Other/);
    await run("a return onto a charge", staff, hand, [ret], /That is a return/);
    await run("a purchase onto a line that takes money off", staff, discount, [receipt], /only a return goes on it/);
    await run("a return onto an imported line", staff, importedNeg, [ret], /A return goes on a line you typed/);
    await run("a copy set aside", staff, hand, [copy], /set aside as a copy/);
    await run("a receipt on another job", staff, hand, [elsewhere], /on another job/);
    await run("a $0 receipt", staff, hand, [nothing], /\$0\.00, so there is nothing of it to bill/);
    await run("a draft order", staff, hand, [draftPo], /never placed/);
    await run("an order its bill replaced", staff, hand, [billedPo], /Mark the bill instead/);
    await run("a running shift", staff, hand, [running], /still running/);
    await run("a shift on another job", staff, hand, [otherJobShift], /on another job/);
    await run("already on another invoice", staff, hand, [onOther], /already billed on TEST-AB-\d+/);
    await run("already on this invoice", staff, hand, [onHere], /already holds that/);
    await run("nothing we know", staff, hand, ["0badbeef-0000-4000-8000-000000000000"], /isn't a receipt, an order, a shift or a take/);
    await run("nothing picked", staff, hand, [], /Pick what that line already charged for/);
    // Another company's office on its own line, naming our receipt: RLS hides it, so it is nothing it knows.
    const theirs = await invoice(null, "paid", "standard", (await one("insert into public.customers (org_id, name) values ($1, 'TEST AB stranger cust') returning id", [strangerOrg])).id, strangerOrg);
    const theirLine = await line(theirs, { description: "Materials" }, strangerOrg);
    await run("another company's office, naming our receipt", stranger, theirLine, [receipt], /isn't a receipt, an order, a shift or a take/);

    for (const [name, r, re] of cases) {
      expect(r, name).not.toBeNull();
      expect(r!.message, name).toMatch(re);
      expect(r!.message, name).toMatch(/Nothing was changed|not found/);
    }
    const after = await state(hand);
    expect(after).toEqual(before);
    expect(after.hand).toEqual([]);
  });

  it("a return goes on a negative line typed by hand; an order, closed shifts and a whole take land on a charge", async () => {
    if (!go()) return;
    const inv = await invoice(jobA, "partial");
    const materials = await line(inv, { description: "Materials", price: 500 });
    const labor = await line(inv, { description: "Labor - TEST Tech", qty: 16, unit: "hr", price: 95 });
    const discount = await line(inv, { description: "Discount", price: -120 });
    await settleTotal(inv);
    const ret = await bill(jobA, -40);
    const order = await po(jobA, "sent", 180);
    const s1 = await shift(jobA, "2001-07-01");
    const s2 = await shift(jobA, "2001-07-02");
    const before = await state(materials);

    expect((await mark(staff, discount, [ret])).added).toEqual([ret]);
    expect((await mark(staff, materials, [order])).added).toEqual([order]);
    expect((await mark(staff, labor, [s1, s2])).added).toEqual(expect.arrayContaining([s1, s2]));

    // A take from stock: a roll on the shelf from a receipt, taken onto the job in two draws' worth
    // of moves (two rolls of one item), billed whole or not at all.
    // Two tickets, one roll each, of the same item: a take of 3 walks both rolls (two moves).
    const src1 = await bill(jobB, 50);
    const src2 = await bill(jobB, 50);
    const l1 = (await one("insert into public.bill_line_items (org_id, bill_id, description, quantity, unit_price, amount, category, billable, sort_order) values ($1,$2,'TEST GFCI',2,25,50,'Materials',true,0) returning id", [org, src1])).id;
    const l2 = (await one("insert into public.bill_line_items (org_id, bill_id, description, quantity, unit_price, amount, category, billable, sort_order) values ($1,$2,'TEST GFCI',2,25,50,'Materials',true,0) returning id", [org, src2])).id;
    await as(staff);
    const shelved = (
      await one("select public.shelve_bill_lines($1, $2::jsonb, '[]'::jsonb) as r", [
        src1,
        JSON.stringify([{ line_id: l1, billed_amount: 0, item_name: "TEST GFCI 0357", unit: "ea", pieces: 2, cost: 50 }]),
      ])
    ).r;
    const item = shelved.lots[0].item_id as string;
    await one("select public.shelve_bill_lines($1, $2::jsonb, '[]'::jsonb) as r", [
      src2,
      JSON.stringify([{ line_id: l2, billed_amount: 0, item_id: item, unit: "ea", pieces: 2, cost: 50 }]),
    ]);
    const take = (await one("select public.stock_draw($1, $2, 3, 'TEST take', null) as r", [item, jobA])).r as { draw_group: string; moves: { move_id: string }[] };
    await asServer();
    const moves = take.moves.map((m) => m.move_id);
    expect(moves.length).toBe(2);
    expect((await tryMark(staff, materials, [moves[0]]))?.message).toMatch(/billed whole/);
    // A take is billed on its own job's invoice only.
    const jobless = await invoice(null, "paid");
    const joblessLine = await line(jobless, { description: "Materials" });
    expect((await tryMark(staff, joblessLine, moves))?.message).toMatch(/billed on their job's invoice/);
    expect((await mark(staff, materials, moves)).added).toEqual(expect.arrayContaining(moves));

    const after = await state(materials);
    expect(after.line_total).toBe(before.line_total);
    expect(after.total).toBe(before.total);
    expect(after.status).toBe("partial");
    expect(after.hand).toEqual(expect.arrayContaining([order, ...moves]));
    // A take comes off whole, as it went on: Not Billed After All on one of its moves takes both.
    const off = await unmark(staff, materials, [moves[0]]);
    expect([...off.removed].sort()).toEqual([...moves].sort());
    expect((await state(materials)).hand).toEqual([order]);
    expect((await mark(staff, materials, moves)).added).toEqual(expect.arrayContaining(moves));
    // An undone take can never be marked.
    await as(staff);
    const take2 = (await one("select public.stock_draw($1, $2, 1, 'TEST take 2', null) as r", [item, jobA])).r as { draw_group: string; moves: { move_id: string }[] };
    await one("select public.stock_undo($1) as r", [take2.draw_group]);
    await asServer();
    expect((await one("select undone_at is not null as gone from public.stock_moves where id = $1", [take2.moves[0].move_id])).gone).toBe(true);
    expect((await tryMark(staff, materials, take2.moves.map((m) => m.move_id)))?.message).toMatch(/was undone/);
  });

  it("an invoice with no job takes rows from its customer's jobs that aren't Time & Material, never another customer's", async () => {
    if (!go()) return;
    const inv = await invoice(null, "paid");
    const materials = await line(inv, { description: "Materials", price: 80 });
    await settleTotal(inv);
    const fixedJob = await newJob(cust, "F", org, "fixed");
    const mine = await bill(fixedJob, 64);
    const notMine = await bill(jobOther, 64);
    const onTm = await bill(jobB, 64);
    expect((await tryMark(staff, materials, [notMine]))?.message).toMatch(/on another job/);
    // A Time & Material job's work to date counts only its own invoices: its rows go on one of those.
    expect((await tryMark(staff, materials, [onTm]))?.message).toMatch(/has no job, and a Time & Material job counts only its own invoices in its work to date\. .*Nothing was changed\./);
    expect((await mark(staff, materials, [mine])).added).toEqual([mine]);
  });

  it("Undo takes off only what a person added, and nothing on the bill moves", async () => {
    if (!go()) return;
    const inv = await invoice(jobA, "paid");
    const own = await bill(jobA, 196.18);
    const ace = await bill(jobA, 47.94);
    // INV-060's shape: an edited materials line keyed to one bill.
    const edited = await line(inv, { description: "Materials — TEST", price: 390.98, source: "costs", key: `bill:${own}`, ids: [own], edited: true, unit: "lot" });
    await settleTotal(inv);
    const before = await state(edited);
    await mark(staff, edited, [ace]);
    expect((await state(edited)).source_ids).toEqual([own, ace]);
    expect((await state(edited)).hand).toEqual([ace]);

    expect((await tryUnmark(staff, edited, [own]))?.message).toMatch(/from an import/);
    expect((await tryUnmark(tech, edited, [ace]))?.message).toMatch(/Only the office/);
    expect((await tryUnmark(stranger, edited, [ace]))?.message).toMatch(/not found/);
    // A void invoice's lines are its record: un-voiding it is judged against them (0259).
    await c.query("savepoint voided");
    await c.query("update public.invoices set status = 'void' where id = $1", [inv]);
    const onVoid = await tryUnmark(staff, edited, [ace]);
    expect(onVoid?.message).toMatch(/is void: what it held stays as its record\. Nothing was changed\./);
    expect((await state(edited)).hand).toEqual([ace]);
    await c.query("rollback to savepoint voided");
    const r = await unmark(staff, edited, [ace]);
    expect(r.removed).toEqual([ace]);
    const after = await state(edited);
    expect(after.source_ids).toEqual([own]);
    expect(after.hand).toEqual([]);
    expect(after.line_total).toBe(before.line_total);
    expect(after.total).toBe(before.total);
    expect(after.status).toBe("paid");
    // A direct write can't make hand_claims hold what the line doesn't claim.
    await c.query("update public.invoice_items set hand_claims = array[$2::uuid, $3::uuid] where id = $1", [edited, own, ace]);
    expect((await state(edited)).hand).toEqual([own]);
    await c.query("update public.invoice_items set hand_claims = '{}' where id = $1", [edited]);
  });

  it("a claim written straight onto a line typed by hand (tonight's scripts) is held by hand, so Not Billed After All can take it back", async () => {
    if (!go()) return;
    const inv = await invoice(jobA, "paid");
    const materials = await line(inv, { description: "Materials", price: 75 });
    const r = await bill(jobA, 58.1);
    await as(staff);
    await c.query("update public.invoice_items set source_ids = source_ids || $2::uuid where id = $1", [materials, r]);
    await asServer();
    expect((await state(materials)).hand).toEqual([r]);
    await unmark(staff, materials, [r]);
    expect((await state(materials)).source_ids).toEqual([]);
  });

  it("a split shift keeps its hand claim on every piece, joins back cleanly, and comes off whole", async () => {
    if (!go()) return;
    const inv = await invoice(jobA, "paid");
    const labor = await line(inv, { description: "Labor - TEST Tech", qty: 8, unit: "hr", price: 95 });
    await settleTotal(inv);
    const s = await shift(jobA, "2001-08-01");
    await mark(staff, labor, [s]);

    await as(staff);
    const first = (await one("select public.split_time_entry($1, $2, $3, null, null, null) as r", [s, "2001-08-01T19:00:00Z", jobA])).r;
    // A piece split from a piece: its split_from is the shift's first piece.
    const second = (await one("select public.split_time_entry($1, $2, $3, null, null, null) as r", [first.right_id, "2001-08-01T21:00:00Z", jobA])).r;
    await asServer();
    let st = await state(labor);
    expect(st.source_ids).toEqual(expect.arrayContaining([s, first.right_id, second.right_id]));
    expect(st.hand).toEqual(expect.arrayContaining([s, first.right_id, second.right_id]));
    expect(st.hand.length).toBe(3);

    // Join the last two back: the absorbed piece leaves both lists.
    await as(staff);
    await one("select public.join_time_entries($1, $2) as r", [first.right_id, second.right_id]);
    await asServer();
    st = await state(labor);
    expect(st.source_ids).not.toContain(second.right_id);
    expect(st.hand).not.toContain(second.right_id);
    expect(st.hand).toEqual(expect.arrayContaining([s, first.right_id]));

    // Undo on one piece takes the whole shift off.
    const r = await unmark(staff, labor, [s]);
    expect(r.removed).toEqual(expect.arrayContaining([s, first.right_id]));
    st = await state(labor);
    expect(st.source_ids).toEqual([]);
    expect(st.hand).toEqual([]);
  });

  it("a split shift is marked whole: every unbilled piece of it on the job, or none (a piece nobody pays for is not asked for)", async () => {
    if (!go()) return;
    const inv = await invoice(jobA, "paid");
    const labor = await line(inv, { description: "Labor - TEST Tech", qty: 8, unit: "hr", price: 95 });
    await settleTotal(inv);
    const p = await shift(jobA, "2001-09-03");
    await as(staff);
    const s2 = (await one("select public.split_time_entry($1, $2, $3, null, null, null) as r", [p, "2001-09-03T19:00:00Z", jobA])).r.right_id as string;
    await asServer();
    expect((await tryMark(staff, labor, [p]))?.message).toMatch(/A split shift is billed whole: tick every part of it, or none\. Nothing was changed\./);
    expect((await tryMark(staff, labor, [s2]))?.message).toMatch(/A split shift is billed whole/);
    expect((await state(labor)).hand).toEqual([]);
    expect([...(await mark(staff, labor, [p, s2])).added].sort()).toEqual([p, s2].sort());
    // A piece cut onto a code the company doesn't bill (shop time) is never billed, so it isn't asked for.
    await c.query("insert into public.job_codes (org_id, code, description, billable) values ($1, 'TEST-AB-SHOP', 'TEST shop time', false)", [org]);
    const q = await shift(jobA, "2001-09-04");
    await as(staff);
    await one("select public.split_time_entry($1, $2, $3, 'TEST-AB-SHOP', null, null) as r", [q, "2001-09-04T19:00:00Z", jobA]);
    await asServer();
    expect((await mark(staff, labor, [q])).added).toEqual([q]);
  });

  it("a mark's own Undo takes off exactly what it added: an earlier, separate mark of the same shift stays on", async () => {
    if (!go()) return;
    const inv = await invoice(jobA, "paid");
    const labor = await line(inv, { description: "Labor - TEST Tech", qty: 8, unit: "hr", price: 95 });
    await settleTotal(inv);
    // The first piece is marked while the second (a Switch Job's piece) is still running. The latest
    // day in this file: a running clock runs until now, past every later shift of the same person.
    const p = await shift(jobA, "2001-12-10");
    const s2 = (
      await one(
        `insert into public.time_entries (org_id, profile_id, job_id, clock_in, lunch_minutes, status, source, split_from, split_how)
         values ($1, $2, $3, '2001-12-10T23:00:00Z', 0, 'open', 'app', $4, 'live') returning id`,
        [org, tech, jobA, p],
      )
    ).id as string;
    await mark(staff, labor, [p]);
    await c.query("update public.time_entries set clock_out = '2001-12-11T01:00:00Z', status = 'closed' where id = $1", [s2]);
    await mark(staff, labor, [s2]);
    expect((await state(labor)).hand).toEqual([p, s2]);
    // Undo of the second mark: only the second piece comes off.
    const r = await unmark(staff, labor, [s2], false);
    expect(r.removed).toEqual([s2]);
    expect((await state(labor)).hand).toEqual([p]);
    // Not Billed After All (whole, the default) takes the shift off whole.
    await mark(staff, labor, [s2]);
    expect([...(await unmark(staff, labor, [s2])).removed].sort()).toEqual([p, s2].sort());
    expect((await state(labor)).hand).toEqual([]);
  });

  it("a piece the importer joins to an edited labor line stays the importer's claim: Not Billed After All never releases hours the line still charges for", async () => {
    if (!go()) return;
    const inv = await invoice(jobA, "sent");
    // Brian's edited labor:<person> line, bumped by hand to 4 h, holding nothing yet.
    const labor = await line(inv, { description: "Labor — TEST Tech", qty: 4, unit: "hr", price: 95, source: "labor", key: `labor:${tech}`, edited: true });
    await settleTotal(inv);
    const p = await shift(jobA, "2001-08-20");
    await as(staff);
    const cut = (await one("select public.split_time_entry($1, $2, $3, null, null, null) as r", [p, "2001-08-20T19:00:00Z", jobA])).r;
    await asServer();
    const s2 = cut.right_id as string;
    // The first piece held by hand (a mark made while the second piece was still running, or a claim
    // written by hand): the line holds 4 h by hand, the second piece is free.
    await c.query("update public.invoice_items set source_ids = array[$2::uuid], hand_claims = array[$2::uuid] where id = $1", [labor, p]);
    expect((await state(labor)).hand).toEqual([p]);
    // The importer joins the free piece the way joinLaborHours writes it: quantity and claims together.
    await as(staff);
    await c.query("update public.invoice_items set quantity = 8, source_ids = source_ids || $2::uuid where id = $1", [labor, s2]);
    await asServer();
    let st = await state(labor);
    expect(st.source_ids).toEqual([p, s2]);
    expect(st.hand).toEqual([p]);
    // Not Billed After All on the first piece takes that piece off, and only it.
    const r = await unmark(staff, labor, [p]);
    expect(r.removed).toEqual([p]);
    st = await state(labor);
    expect(st.source_ids).toEqual([s2]);
    expect(st.hand).toEqual([]);
  });

  it("Purple Sage: the kept GFCIs go on the shelf first, then the typed Materials line claims the receipt, after which the shelf refuses it until the claim comes off", async () => {
    if (!go()) return;
    const receipt = await bill(jobA, 186.93);
    const lines = [
      ["4-IN SQ FLAT BLANK COVER (752)", 1, 1.04, 1.04, "Materials"],
      ["SG BLANK PLATE (TP13W)", 3, 0.49, 1.48, "Materials"],
      ["15A 125V GFCI RCPT (1597TRW)", 8, 16.83, 134.64, "Materials"],
      ["15A 125V GFCI RCPT (1597TR)", 1, 16.33, 16.33, "Materials"],
      ["1G BRZ IN-USE CVR (ML450Z)", 1, 17.06, 17.06, "Materials"],
      ["2 GANG TOGGLE DECORA (TP126W)", 1, 0.95, 0.95, "Materials"],
      ["Sales Tax (Invoice 8802-1101475)", 1, 15.43, 15.43, "Tax"],
    ] as const;
    const ids: string[] = [];
    for (const [i, [desc, q, u, a, cat]] of lines.entries()) {
      ids.push(
        (
          await one(
            "insert into public.bill_line_items (org_id, bill_id, description, quantity, unit_price, amount, category, billable, sort_order) values ($1,$2,$3,$4,$5,$6,$7,true,$8) returning id",
            [org, receipt, desc, q, u, a, cat, i],
          )
        ).id,
      );
    }
    const inv = await invoice(jobA, "paid");
    const materials = await line(inv, { description: "Materials", price: 110 });
    await settleTotal(inv);
    const shelve = () =>
      c.query("select public.shelve_bill_lines($1, $2::jsonb, '[]'::jsonb)", [
        receipt,
        JSON.stringify([{ line_id: ids[2], billed_amount: 84.15, item_name: "TEST 15A GFCI 0357", unit: "ea", pieces: 3, cost: 55.03 }]),
      ]);
    // 1. Shelve the 3 kept GFCIs (the job keeps 5 at $84.15).
    await as(staff);
    await shelve();
    await asServer();
    expect(Number((await one("select billed_amount from public.bill_line_items where id = $1", [ids[2]])).billed_amount)).toBe(84.15);
    // 2. The typed Materials line claims the receipt: nothing on INV moves.
    const before = await state(materials);
    await mark(staff, materials, [receipt]);
    const after = await state(materials);
    expect(after.hand).toEqual([receipt]);
    expect(after.total).toBe(before.total);
    expect(after.line_total).toBe("110.00");
    // 3. Once a sent invoice bills the receipt, the shelf refuses the rest of it (0328): the order
    //    matters, which is why the sheet asks "Did J-010 Use All Of It?" before it marks.
    const shelvePlates = () =>
      c.query("select public.shelve_bill_lines($1, $2::jsonb, '[]'::jsonb)", [
        receipt,
        JSON.stringify([{ line_id: ids[1], billed_amount: 0.49, item_name: "TEST blank plate 0357", unit: "ea", pieces: 2, cost: 0.99 }]),
      ]);
    expect((await refusal(staff, shelvePlates))?.message).toMatch(/already bills this ticket/);
    // 4. Not Billed After All: the claim comes off, and the shelf opens again.
    await unmark(staff, materials, [receipt]);
    expect(await refusal(staff, shelvePlates)).toBeNull();
  });

  it("hours on no job billed by hand on an invoice with no job (TTUSD on INV-055): they land there, no customer needed, and every other guard holds", async () => {
    if (!go()) return;
    // INV-055's shape: no job (and here no customer either), a labor line typed by hand.
    const inv = await invoice(null, "paid", "standard", null);
    const labor = await line(inv, { description: "Labor - JP Prince", qty: 23, unit: "hr", price: 95 });
    const fee = await line(inv, { description: "Card fee", price: 12, kind: "other" });
    await settleTotal(inv);
    const d1 = await shift(null, "2001-10-01");
    const d2 = await shift(null, "2001-10-02");
    // A running clock on no job: the tech's last day here, so it overlaps none of his closed shifts (0360).
    const running = await shift(null, "2001-12-31", true);
    const onJob = await shift(jobA, "2001-10-04");
    // A job's invoice never holds a shift on no job: it would count as that job's work.
    const jobInv = await invoice(jobA, "paid");
    const jobLabor = await line(jobInv, { description: "Labor - TEST Tech", qty: 8, unit: "hr", price: 95 });
    await settleTotal(jobInv);
    // A customer's invoice with no job still takes it (the customer is not what decides).
    const custInv = await invoice(null, "sent", "standard", cust);
    const custLabor = await line(custInv, { description: "Labor", qty: 5, unit: "hr", price: 95 });
    await settleTotal(custInv);

    const before = await state(labor);
    const cases: [string, { message: string; code: string } | null, RegExp][] = [
      ["onto a job's invoice", await tryMark(staff, jobLabor, [d1]), /That shift is on no job, so only an invoice with no job can hold it, not TEST-AB-\d+\. Nothing was changed\./],
      ["a running shift", await tryMark(staff, labor, [running]), /still running/],
      ["a shift on a job, onto an invoice with no job and no customer", await tryMark(staff, labor, [onJob]), /on another job/],
      ["a tech", await tryMark(tech, labor, [d1]), /Only the office/],
      ["another company's office", await tryMark(stranger, labor, [d1]), /not found/],
      ["a line filed as Other", await tryMark(staff, fee, [d1]), /filed as Other/],
    ];
    for (const [name, r, re] of cases) {
      expect(r, name).not.toBeNull();
      expect(r!.message, name).toMatch(re);
    }
    expect(await state(labor)).toEqual(before);

    const r = await mark(staff, labor, [d1, d2]);
    expect(r.added).toEqual(expect.arrayContaining([d1, d2]));
    const after = await state(labor);
    expect(after.hand).toEqual(expect.arrayContaining([d1, d2]));
    expect(after.line_total).toBe(before.line_total);
    expect(after.total).toBe(before.total);
    expect(after.status).toBe("paid");
    expect(after.edited).toBe(before.edited);
    // Never twice: another invoice with no job can't hold the same day too.
    expect((await tryMark(staff, custLabor, [d1]))?.message).toMatch(/already billed on TEST-AB-\d+/);
    // Not Billed After All takes them back off, and nothing on the bill moves.
    const off = await unmark(staff, labor, [d1, d2]);
    expect(off.removed).toEqual(expect.arrayContaining([d1, d2]));
    const back = await state(labor);
    expect(back.source_ids).toEqual([]);
    expect(back.hand).toEqual([]);
    expect(back.total).toBe(before.total);
    // Then the customer's invoice with no job may hold them.
    expect((await mark(staff, custLabor, [d1])).added).toEqual([d1]);
  });

  it("a split shift on no job is marked whole, like one on a job", async () => {
    if (!go()) return;
    const inv = await invoice(null, "paid", "standard", null);
    const labor = await line(inv, { description: "Labor - TEST Tech", qty: 8, unit: "hr", price: 95 });
    await settleTotal(inv);
    const p = await shift(null, "2001-10-05");
    await as(staff);
    // The new part on no job needs a code to say what it was (split_time_entry asks for one).
    const s2 = (await one("select public.split_time_entry($1, $2, null, $3, null, null) as r", [p, "2001-10-05T19:00:00Z", "TEST-AB-ROUGH"])).r.right_id as string;
    await asServer();
    expect((await tryMark(staff, labor, [p]))?.message).toMatch(/A split shift is billed whole: tick every part of it, or none\. Nothing was changed\./);
    expect((await mark(staff, labor, [p, s2])).added).toEqual(expect.arrayContaining([p, s2]));
    const r = await unmark(staff, labor, [p]);
    expect(r.removed).toEqual(expect.arrayContaining([p, s2]));
  });
});
