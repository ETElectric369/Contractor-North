import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertTestDatabase, notOnThisDatabase } from "@/lib/db-guard";

/**
 * A BILL KNOWS HOW MUCH OF IT IS PAID (0383), WHERE IT MEETS THE DATABASE.
 *
 * The six triggers 0383 adds, the two it replaces, the replay of payments already sent, and the REAL
 * doors in front of them (recordSupplierPayment, voidSupplierPayment: requireStaff → the reads → the
 * writes) run against the test database through the PostgREST-shaped shim over one pg connection,
 * speaking as the company's office exactly as PostgREST does. Proven:
 *   · born paid is paid in full; a document the supplier part-paid carries its number; status is the
 *     number's, per purchase;
 *   · Mark Paid pays the whole purchase in full by his word; Mark On Account keeps what the payments
 *     paid and is refused when they cover it, naming the payment's day;
 *   · a payment's cash never exceeds the payment, the payments on a bill never exceed the bill, a
 *     credit and a set-aside copy cannot be paid, and the company must match;
 *   · Undo on a payment reopens exactly what it paid and leaves what he said was paid otherwise;
 *   · a correction is a purchase short by its difference until paid; marking it alone is refused in
 *     0382's own words; a credit correction nets inside its purchase;
 *   · a price change keeps a bill paid in full by his word paid in full, keeps what the payments
 *     paid, and refuses to go under them;
 *   · the replay matches payments already sent oldest first, paid bills first, never a bill dated
 *     after the payment, cash left ahead;
 *   · the door: no boxes pays oldest first and part-pays the last; boxes pay those first and the extra
 *     applies to the next oldest; the printed discount explains a short payment; Undo reopens.
 *
 * ONE transaction, BEGIN first, always rolled back, in TEST companies minted inside it; every fixture
 * is dated 2001 and named TEST. No DDL.
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run --project db <this file>
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

import { recordSupplierPayment, voidSupplierPayment } from "./supplier-actions";
import { sayMoney } from "@/lib/payroll-math";
import { mintOrgAndStranger } from "@/lib/throwaway-org.db-fixture";
import { PG_TYPES, postgrestShim } from "@/lib/postgrest-shim.db-fixture";

d("a bill knows how much of it is paid (0383): the triggers, the replay and the door", () => {
  let c: pg.Client;
  let ready = false;
  let orgId = "";
  let otherOrgId = "";
  let staffId = "";
  let acct = "";
  let otherAcct = "";
  let seq = 0;

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const rows = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;
  const asOffice = () => (state.member = { supabase: postgrestShim(c, staffId), userId: staffId, orgId, staff: true });
  const needs = () => ready || notOnThisDatabase("[bill-money] bills.amount_paid and 0383's triggers are not on this database; run node scripts/test-db/rebuild.cjs.");
  const refused = async (sql: string, params: unknown[] = []) => {
    await c.query("savepoint refused");
    try {
      await c.query(sql, params);
    } catch (e) {
      await c.query("rollback to savepoint refused");
      return e as { code?: string; message?: string; constraint?: string };
    }
    await c.query("release savepoint refused");
    return null;
  };
  const bill = async (o: { amount: number; status?: string; date?: string | null; corrects?: string | null; superseded?: string | null; account?: string | null; org?: string; amountPaid?: number; number?: string }) =>
    (
      await one(
        `insert into public.bills (org_id, supplier, supplier_account_id, bill_number, amount, status, bill_date, corrects_bill_id, superseded_by_bill_id${o.amountPaid !== undefined ? ", amount_paid" : ""})
         values ($1, 'TEST CED', $2, $3, $4, $5, $6, $7, $8${o.amountPaid !== undefined ? ", $9" : ""}) returning id`,
        [
          o.org ?? orgId,
          o.account === undefined ? acct : o.account,
          o.number ?? `TEST-BM-${++seq}`,
          o.amount,
          o.status ?? "unpaid",
          o.date === undefined ? "2001-05-01" : o.date,
          o.corrects ?? null,
          o.superseded ?? null,
          ...(o.amountPaid !== undefined ? [o.amountPaid] : []),
        ],
      )
    ).id as string;
  const money = async (id: string) => {
    const r = await one("select amount, amount_paid, status from public.bills where id = $1", [id]);
    return { amount: Number(r.amount), paid: Number(r.amount_paid), status: String(r.status) };
  };
  const payment = async (o: { amount: number; on: string; account?: string; org?: string }) =>
    (
      await one(
        "insert into public.supplier_payments (org_id, supplier_account_id, amount, paid_on, method) values ($1, $2, $3, $4, 'check') returning id",
        [o.org ?? orgId, o.account ?? acct, o.amount, o.on],
      )
    ).id as string;
  const allocate = (paymentId: string, billId: string, amount: number, discount = 0, org = orgId) =>
    refused("insert into public.supplier_payment_allocations (org_id, supplier_payment_id, bill_id, amount, discount) values ($1, $2, $3, $4, $5)", [org, paymentId, billId, amount, discount]);

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
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    const has = await one(
      `select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bills' and column_name = 'amount_paid') as col,
              exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = 'supplier_payment_allocations') as tbl,
              (select count(*)::int from pg_trigger where tgrelid = 'public.bills'::regclass and not tgisinternal
                 and tgname in ('bill_money_follows', 'bill_money_syncs')) as triggers`,
    );
    ready = has.col === true && has.tbl === true && has.triggers === 2;
    if (!ready) return;
    const fx = await mintOrgAndStranger(c, "bill-money");
    orgId = fx.orgId;
    otherOrgId = fx.otherOrgId;
    staffId = fx.staffId;
    acct = (await one("insert into public.supplier_accounts (org_id, name, on_account) values ($1, 'TEST CED', true) returning id", [orgId])).id;
    otherAcct = (await one("insert into public.supplier_accounts (org_id, name, on_account) values ($1, 'TEST CED', true) returning id", [otherOrgId])).id;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("born paid is paid in full; the supplier's part-paid number is kept; status is the number's", async () => {
    needs();
    expect(await money(await bill({ amount: 44.44, status: "paid" }))).toEqual({ amount: 44.44, paid: 44.44, status: "paid" });
    expect(await money(await bill({ amount: 100, status: "unpaid" }))).toEqual({ amount: 100, paid: 0, status: "unpaid" });
    // Record It As A Bill: the supplier says $30 of it is still open.
    expect(await money(await bill({ amount: 100, status: "unpaid", amountPaid: 70 }))).toEqual({ amount: 100, paid: 70, status: "unpaid" });
    expect(await money(await bill({ amount: 100, status: "unpaid", amountPaid: 100 }))).toEqual({ amount: 100, paid: 100, status: "paid" });
    // A credit is negative both ways.
    expect(await money(await bill({ amount: -51.58, status: "paid" }))).toEqual({ amount: -51.58, paid: -51.58, status: "paid" });
    // Over the amount is refused by the constraint, never clamped in silence.
    expect((await refused("insert into public.bills (org_id, supplier, amount, status, amount_paid) values ($1, 'TEST CED', 10, 'unpaid', 11)", [orgId]))?.constraint).toBe("bills_amount_paid_within_amount");
  });

  it("Mark Paid pays in full by his word; Mark On Account puts it back; the number drives both", async () => {
    needs();
    const b = await bill({ amount: 250 });
    await c.query("update public.bills set status = 'paid' where id = $1", [b]);
    expect(await money(b)).toEqual({ amount: 250, paid: 250, status: "paid" });
    await c.query("update public.bills set status = 'unpaid' where id = $1", [b]);
    expect(await money(b)).toEqual({ amount: 250, paid: 0, status: "unpaid" });
    // Writing the number directly derives the word.
    await c.query("update public.bills set amount_paid = 250 where id = $1", [b]);
    expect((await money(b)).status).toBe("paid");
  });

  it("a payment pays bills: the guards, the roll-up, Undo and the refusal that names the payment's day", async () => {
    needs();
    const a = await bill({ amount: 100, number: "TEST-BM-A" });
    const b = await bill({ amount: 80, number: "TEST-BM-B" });
    const p = await payment({ amount: 150, on: "2001-06-05" });
    expect(await allocate(p, a, 100)).toBeNull();
    expect(await money(a)).toEqual({ amount: 100, paid: 100, status: "paid" });
    expect(await allocate(p, b, 50)).toBeNull();
    expect(await money(b)).toEqual({ amount: 80, paid: 50, status: "unpaid" });

    // The cash never exceeds the payment; the payments on a bill never exceed the bill.
    expect((await allocate(p, b, 10))?.message).toBe("That puts $160.00 on bills out of the $150.00 payment of Jun 5. Nothing was changed.");
    const p2 = await payment({ amount: 100, on: "2001-06-06" });
    expect((await allocate(p2, b, 40))?.message).toBe("TEST-BM-B is $80.00; the payments on it would come to $90.00. Nothing was changed.");
    // The unique pair: a second row for the same payment and bill is refused by the index.
    expect((await allocate(p2, a, 1))?.message).toBe("TEST-BM-A is $100.00; the payments on it would come to $101.00. Nothing was changed.");
    // A credit, a set-aside copy, another company: none can be paid.
    const credit = await bill({ amount: -20, number: "TEST-BM-CR" });
    expect((await allocate(p2, credit, 5))?.message).toBe("TEST-BM-CR is a credit, not a bill to pay. Nothing was changed.");
    const copy = await bill({ amount: 30, superseded: a, number: "TEST-BM-DUP" });
    expect((await allocate(p2, copy, 5))?.message).toBe("TEST-BM-DUP was set aside as a duplicate. Pay the bill that was kept. Nothing was changed.");
    const theirs = await bill({ amount: 30, org: otherOrgId, account: otherAcct });
    expect((await allocate(p2, theirs, 5))?.message).toBe("That bill is not on the books. Nothing was changed.");
    const theirPayment = await payment({ amount: 30, on: "2001-06-06", org: otherOrgId, account: otherAcct });
    expect((await allocate(theirPayment, b, 5))?.message).toBe("That payment is not on the books. Nothing was changed.");

    // Marking a bill the payment covers back On Account is refused, naming the payment's day.
    expect((await refused("update public.bills set status = 'unpaid' where id = $1", [a]))?.message).toBe(
      "TEST-BM-A is paid by the payment of Jun 5. Undo that payment to put it back on account. Nothing was changed.",
    );
    // The part-paid one marked paid is paid in full by his word; marked back, the payment's $50 stays.
    await c.query("update public.bills set status = 'paid' where id = $1", [b]);
    expect(await money(b)).toEqual({ amount: 80, paid: 80, status: "paid" });
    await c.query("update public.bills set status = 'unpaid' where id = $1", [b]);
    expect(await money(b)).toEqual({ amount: 80, paid: 50, status: "unpaid" });

    // Undo reopens exactly what the payment paid; what he said was paid otherwise stays.
    await c.query("update public.bills set status = 'paid' where id = $1", [b]); // $30 paid otherwise
    await c.query("update public.supplier_payments set voided_at = now() where id = $1", [p]);
    expect(await money(a)).toEqual({ amount: 100, paid: 0, status: "unpaid" });
    expect(await money(b)).toEqual({ amount: 80, paid: 30, status: "unpaid" });
    expect((await allocate(p, a, 1))?.message).toBe("The payment of Jun 5 was undone, so it cannot pay a bill. Nothing was changed.");
    await c.query("update public.supplier_payments set voided_at = null where id = $1", [p]);
    expect(await money(a)).toEqual({ amount: 100, paid: 100, status: "paid" });
    expect(await money(b)).toEqual({ amount: 80, paid: 80, status: "paid" });
    // Deleting an allocation rolls the bill back too.
    await c.query("delete from public.supplier_payment_allocations where supplier_payment_id = $1 and bill_id = $2", [p, a]);
    expect(await money(a)).toEqual({ amount: 100, paid: 0, status: "unpaid" });
  });

  it("a correction is a purchase short by its difference; marking it alone is refused; a credit correction nets inside", async () => {
    needs();
    const o = await bill({ amount: 613.19, status: "paid", number: "TEST-BM-O", date: "2001-09-29" });
    const cr = await bill({ amount: 95.99, status: "paid", corrects: o, number: "TEST-BM-C", date: "2001-10-01" });
    // Born under a paid ticket, its money is its own: the purchase is $95.99 short, so both read open.
    expect(await money(cr)).toEqual({ amount: 95.99, paid: 0, status: "unpaid" });
    expect(await money(o)).toEqual({ amount: 613.19, paid: 613.19, status: "unpaid" });
    expect((await refused("update public.bills set status = 'paid' where id = $1", [cr]))?.message).toBe(
      "A correction is settled with the bill it corrects (TEST-BM-O). Mark that bill and this one follows. Nothing was changed.",
    );
    // Mark the original paid: the whole purchase is paid in full by his word.
    await c.query("update public.bills set status = 'paid' where id = $1", [o]);
    expect(await money(cr)).toEqual({ amount: 95.99, paid: 95.99, status: "paid" });
    expect(await money(o)).toEqual({ amount: 613.19, paid: 613.19, status: "paid" });
    // And back: both open, nothing paid.
    await c.query("update public.bills set status = 'unpaid' where id = $1", [o]);
    expect(await money(cr)).toEqual({ amount: 95.99, paid: 0, status: "unpaid" });
    expect(await money(o)).toEqual({ amount: 613.19, paid: 0, status: "unpaid" });
    // A payment on both members pays the purchase; on one, the purchase stays open on both.
    const p = await payment({ amount: 709.18, on: "2001-10-05" });
    expect(await allocate(p, o, 613.19)).toBeNull();
    expect(await money(o)).toEqual({ amount: 613.19, paid: 613.19, status: "unpaid" });
    expect(await allocate(p, cr, 95.99)).toBeNull();
    expect(await money(o)).toEqual({ amount: 613.19, paid: 613.19, status: "paid" });
    expect(await money(cr)).toEqual({ amount: 95.99, paid: 95.99, status: "paid" });
    expect((await refused("update public.bills set status = 'unpaid' where id = $1", [o]))?.message).toBe(
      "TEST-BM-O is paid by the payment of Oct 5. Undo that payment to put it back on account. Nothing was changed.",
    );
    // A credit correction: a paid $100 ticket with $20 back is a purchase that owes him $20 until applied.
    const o2 = await bill({ amount: 100, status: "paid", number: "TEST-BM-O2" });
    const c2 = await bill({ amount: -20, corrects: o2, number: "TEST-BM-C2" });
    expect(await money(o2)).toEqual({ amount: 100, paid: 100, status: "unpaid" });
    await c.query("update public.bills set status = 'paid' where id = $1", [o2]);
    expect(await money(c2)).toEqual({ amount: -20, paid: -20, status: "paid" });
    expect((await money(o2)).status).toBe("paid");
    // Deleting the correction re-derives the original on its own.
    const o3 = await bill({ amount: 50, status: "paid", number: "TEST-BM-O3" });
    const c3 = await bill({ amount: 5, corrects: o3, number: "TEST-BM-C3" });
    expect((await money(o3)).status).toBe("unpaid");
    await c.query("delete from public.bills where id = $1", [c3]);
    expect((await money(o3)).status).toBe("paid");
  });

  it("a price change: paid in full by his word stays paid in full; the payments' share stays theirs; never under them", async () => {
    needs();
    const word = await bill({ amount: 100, status: "paid", number: "TEST-BM-W" });
    await c.query("update public.bills set amount = 120 where id = $1", [word]);
    expect(await money(word)).toEqual({ amount: 120, paid: 120, status: "paid" });
    const byPay = await bill({ amount: 100, number: "TEST-BM-P" });
    const p = await payment({ amount: 100, on: "2001-07-07" });
    expect(await allocate(p, byPay, 100)).toBeNull();
    await c.query("update public.bills set amount = 120 where id = $1", [byPay]);
    expect(await money(byPay)).toEqual({ amount: 120, paid: 100, status: "unpaid" });
    expect((await refused("update public.bills set amount = 90 where id = $1", [byPay]))?.message).toBe(
      "The payment of Jul 7 paid $100.00 of TEST-BM-P, more than its new amount. Undo that payment before changing the amount. Nothing was changed.",
    );
    // Part-paid by the supplier's word, lowered under the number: paid in full.
    const part = await bill({ amount: 100, amountPaid: 70, number: "TEST-BM-PP" });
    await c.query("update public.bills set amount = 60 where id = $1", [part]);
    expect(await money(part)).toEqual({ amount: 60, paid: 60, status: "paid" });
  });

  it("the replay matches payments already sent oldest first, paid bills first, never a bill dated after the payment", async () => {
    needs();
    // Its own account, so the bills above stay out of it.
    const replayAcct = (await one("insert into public.supplier_accounts (org_id, name, on_account) values ($1, 'TEST Replay Supply', true) returning id", [orgId])).id;
    // An alias and the account's own name place a bill, as the app's resolver does.
    await c.query("insert into public.supplier_aliases (org_id, supplier_account_id, alias) values ($1, $2, 'TEST REPLAY SUP.')", [orgId, replayAcct]);
    const paid1 = await bill({ amount: 100, status: "paid", date: "2001-01-10", account: replayAcct, number: "TEST-RP-1" });
    const paid2 = await bill({ amount: 100, status: "paid", date: "2001-02-10", account: null, number: "TEST-RP-2" });
    await c.query("update public.bills set supplier = 'TEST REPLAY SUP.' where id = $1", [paid2]);
    const paid3 = await bill({ amount: 100, status: "paid", date: "2001-03-10", account: null, number: "TEST-RP-3" });
    await c.query("update public.bills set supplier = 'TEST Replay Supply' where id = $1", [paid3]);
    const open1 = await bill({ amount: 100, date: "2001-01-20", account: replayAcct, number: "TEST-RP-OPEN" });
    const later = await bill({ amount: 100, status: "paid", date: "2001-04-10", account: replayAcct, number: "TEST-RP-LATER" });
    // The payments earlier tests left unmatched (a refused allocation leaves none) are not this
    // replay's: undone, so the function sees only this account's two.
    await c.query(
      "update public.supplier_payments set voided_at = now() where org_id in ($1, $2) and voided_at is null and not exists (select 1 from public.supplier_payment_allocations a where a.supplier_payment_id = supplier_payments.id)",
      [orgId, otherOrgId],
    );
    const pA = await payment({ amount: 150, on: "2001-02-15", account: replayAcct });
    const pB = await payment({ amount: 200, on: "2001-03-15", account: replayAcct });
    const r = await one("select * from public.supplier_payments_match_oldest_first()");
    expect(r).toEqual({ payments_matched: 2, bills_matched: 5, left_ahead: 0 });
    const got = async (p: string) =>
      (await rows("select b.bill_number, a.amount from public.supplier_payment_allocations a join public.bills b on b.id = a.bill_id where a.supplier_payment_id = $1 order by b.bill_date", [p])).map((x) => [x.bill_number, Number(x.amount)]);
    // Feb 15: the paid bills dated by then first ($100 Jan, $100 Feb), then nothing left for the open one.
    expect(await got(pA)).toEqual([
      ["TEST-RP-1", 100],
      ["TEST-RP-2", 50],
    ]);
    // Mar 15: the rest of Feb's, March's by the account's own name, then the open Jan bill. April's is after the payment.
    expect(await got(pB)).toEqual([
      ["TEST-RP-OPEN", 50],
      ["TEST-RP-2", 50],
      ["TEST-RP-3", 100],
    ]);
    expect(await money(open1)).toEqual({ amount: 100, paid: 50, status: "unpaid" });
    expect(await money(later)).toEqual({ amount: 100, paid: 100, status: "paid" });
    expect((await money(paid1)).paid).toBe(100);
    // Idempotent: a second run matches nothing new.
    expect(await one("select * from public.supplier_payments_match_oldest_first()")).toEqual({ payments_matched: 0, bills_matched: 0, left_ahead: 0 });
  });

  it("the backfill runs over a book that already has corrected purchases (what rolled the first live run back)", async () => {
    needs();
    // Two corrected purchases in the book: a paid pair ticked by his word, and an open pair.
    const po = await bill({ amount: 300, status: "paid", number: "TEST-BF-PO", date: "2001-03-01" });
    const pc = await bill({ amount: 25, corrects: po, number: "TEST-BF-PC", date: "2001-03-02" });
    await c.query("update public.bills set status = 'paid' where id = $1", [po]);
    const oo = await bill({ amount: 613.19, number: "TEST-BF-OO", date: "2001-03-03" });
    const oc = await bill({ amount: 95.99, corrects: oo, number: "TEST-BF-OC", date: "2001-03-04" });
    // (A paid bill with no number, as every bill before 0383, cannot be minted here: the trigger
    // derives the word from the number on every write. Step a's own statement is plain SQL.)
    // THE BACKFILL, verbatim from the migration file, inside this suite's transaction.
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/0383_a_bill_knows_how_much_of_it_is_paid.sql"), "utf8");
    const start = sql.indexOf("do $$\ndeclare\n  n_word     int;");
    const end = sql.indexOf("end $$;", start) + "end $$;".length;
    expect(start, "the backfill block is where the suite expects it").toBeGreaterThan(0);
    expect(await refused(sql.slice(start, end))).toBeNull();
    expect(await money(po)).toEqual({ amount: 300, paid: 300, status: "paid" });
    expect(await money(pc)).toEqual({ amount: 25, paid: 25, status: "paid" });
    expect(await money(oo)).toEqual({ amount: 613.19, paid: 0, status: "unpaid" });
    expect(await money(oc)).toEqual({ amount: 95.99, paid: 0, status: "unpaid" });
    // Nothing in the book carries a number outside its amount or under its live payments.
    expect(
      await rows(
        `select b.bill_number, b.amount, b.amount_paid, b.status, public.bill_live_allocated(b.id) as allocated
           from public.bills b where b.org_id in ($1, $2)
            and (b.amount_paid < least(0, b.amount) or b.amount_paid > greatest(0, b.amount) or (b.amount > 0 and b.amount_paid + 0.005 < public.bill_live_allocated(b.id)))`,
        [orgId, otherOrgId],
      ),
    ).toEqual([]);
    // And the file's own end-of-run checks pass over this book.
    const checks = sql.indexOf("-- ── 8. VERIFY, OR FAIL THE RUN");
    const cStart = sql.indexOf("do $$", checks);
    const cEnd = sql.indexOf("end $$;", cStart) + "end $$;".length;
    expect(await refused(sql.slice(cStart, cEnd))).toBeNull();
  });

  it("the skeptic's cases: the word is one of two, a $0 bill is paid, a paid bill cannot be set aside, void twice is void once, money ahead takes the next bill, nothing is an RPC", async () => {
    needs();
    // "Paid " spelled any way is the word; sending it again is not a flip that resets the number.
    const w = await bill({ amount: 40, number: "TEST-SK-W" });
    await c.query("update public.bills set status = 'Paid ' where id = $1", [w]);
    expect(await money(w)).toEqual({ amount: 40, paid: 40, status: "paid" });
    await c.query("update public.bills set status = 'PAID' where id = $1", [w]);
    expect(await money(w)).toEqual({ amount: 40, paid: 40, status: "paid" });
    expect((await money(await bill({ amount: 0, status: "unpaid", number: "TEST-SK-0" }))).status).toBe("paid");
    // A bill a payment paid cannot be set aside as a duplicate: Undo the payment first.
    const kept = await bill({ amount: 20, number: "TEST-SK-KEPT" });
    const dup = await bill({ amount: 20, number: "TEST-SK-DUP" });
    const sp = await payment({ amount: 20, on: "2001-08-08" });
    expect(await allocate(sp, dup, 20)).toBeNull();
    expect((await refused("update public.bills set superseded_by_bill_id = $2 where id = $1", [dup, kept]))?.message).toBe(
      "TEST-SK-DUP is paid by the payment of Aug 8. Undo that payment before setting this bill aside. Nothing was changed.",
    );
    // Voiding twice (a second timestamp) takes the payment off once.
    const twice = await bill({ amount: 50, status: "paid", number: "TEST-SK-TW" }); // $50 by his word
    const sp2 = await payment({ amount: 30, on: "2001-08-09" });
    expect(await allocate(sp2, twice, 30)).toBeNull();
    await c.query("update public.supplier_payments set voided_at = now() where id = $1", [sp2]);
    await c.query("update public.supplier_payments set voided_at = now() + interval '1 minute' where id = $1", [sp2]);
    expect(await money(twice)).toEqual({ amount: 50, paid: 20, status: "unpaid" });
    // Money ahead comes off the next bill recorded on that account, oldest payment first.
    const aheadAcct = (await one("insert into public.supplier_accounts (org_id, name, on_account) values ($1, 'TEST Ahead Supply', true) returning id", [orgId])).id;
    const ahead = await payment({ amount: 100, on: "2001-09-01", account: aheadAcct });
    const n1 = await bill({ amount: 60, date: "2001-09-10", account: aheadAcct, number: "TEST-SK-N1" });
    expect(await money(n1)).toEqual({ amount: 60, paid: 60, status: "paid" });
    const n2 = await bill({ amount: 70, date: "2001-09-12", account: aheadAcct, number: "TEST-SK-N2" });
    expect(await money(n2)).toEqual({ amount: 70, paid: 40, status: "unpaid" });
    expect(await one("select coalesce(sum(amount), 0)::numeric as cash from public.supplier_payment_allocations where supplier_payment_id = $1", [ahead])).toEqual({ cash: 100 });
    // A ticket born paid at the counter takes nothing.
    const counter = await bill({ amount: 15, status: "paid", date: "2001-09-13", account: aheadAcct, number: "TEST-SK-CT" });
    expect(await money(counter)).toEqual({ amount: 15, paid: 15, status: "paid" });
    // None of the helpers is an RPC a signed-in user can call.
    for (const fn of ["public.bill_roll_up(uuid, numeric)", "public.bill_family_sync(uuid)", "public.supplier_payments_match_oldest_first()", "public.supplier_apply_ahead(uuid, uuid)", "public.supplier_account_of_bill(uuid, uuid, text)"]) {
      expect(await one("select has_function_privilege('authenticated', $1, 'execute') as a, has_function_privilege('anon', $1, 'execute') as b", [fn])).toEqual({ a: false, b: false });
    }
  });

  it("the door: no boxes pays oldest first; boxes pay those first and the extra applies next; the discount explains a short payment; Undo reopens", async () => {
    needs();
    asOffice();
    const doorAcct = (await one("insert into public.supplier_accounts (org_id, name, on_account) values ($1, 'TEST Door Supply', true) returning id", [orgId])).id;
    const a = await bill({ amount: 100, date: "2001-01-01", account: doorAcct, number: "TEST-DR-A" });
    const b = await bill({ amount: 80, date: "2001-02-01", account: doorAcct, number: "TEST-DR-B" });
    const cBill = await bill({ amount: 70, date: "2001-03-01", account: doorAcct, number: "TEST-DR-C" });
    const credit = await bill({ amount: -15, date: "2001-03-02", account: doorAcct, number: "TEST-DR-CR" });

    const first = await recordSupplierPayment({ accountId: doorAcct, amount: 150, paidOn: "2001-06-01", method: "check" });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(first.message).toContain(`Recorded ${sayMoney(150)} to TEST Door Supply`);
    expect(first.message).toContain("Paid TEST-DR-A in full");
    expect(first.message).toContain(`TEST-DR-B part-paid ${sayMoney(50)}, ${sayMoney(30)} still open`);
    expect(await money(a)).toEqual({ amount: 100, paid: 100, status: "paid" });
    expect(await money(b)).toEqual({ amount: 80, paid: 50, status: "unpaid" });
    expect(await money(cBill)).toEqual({ amount: 70, paid: 0, status: "unpaid" });
    expect(await money(credit)).toEqual({ amount: -15, paid: 0, status: "unpaid" });

    // Boxes: C checked, $80 sent. C paid in full, the extra $10 goes on B (the next oldest open).
    const second = await recordSupplierPayment({ accountId: doorAcct, amount: 80, paidOn: "2001-06-02", method: "transfer", billIds: [cBill] });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    expect(second.message).toContain("Paid TEST-DR-C in full");
    expect(second.message).toContain(`${sayMoney(10)} over the boxes went on TEST-DR-B`);
    expect(await money(cBill)).toEqual({ amount: 70, paid: 70, status: "paid" });
    expect(await money(b)).toEqual({ amount: 80, paid: 60, status: "unpaid" });

    // Money past every open purchase is ahead, said out loud.
    const third = await recordSupplierPayment({ accountId: doorAcct, amount: 25, paidOn: "2001-06-03", method: "cash" });
    expect(third.ok).toBe(true);
    // B had $20 open: paid in full, and the $5 past every open purchase is ahead.
    expect(third.message).toContain("Paid TEST-DR-B in full");
    expect(third.message).toContain(`${sayMoney(5)} is not matched to a bill yet`);
    expect(await money(b)).toEqual({ amount: 80, paid: 80, status: "paid" });

    // The $5 ahead comes off the next bill recorded on that account (bill_takes_ahead_cash).
    const next = await bill({ amount: 12, date: "2001-06-04", account: doorAcct, number: "TEST-DR-NEXT" });
    expect(await money(next)).toEqual({ amount: 12, paid: 5, status: "unpaid" });

    // The discount: on an account with nothing ahead, a bill linked to a document with $2.00 off
    // until June 10, paid $98 on June 5.
    const discAcct = (await one("insert into public.supplier_accounts (org_id, name, on_account) values ($1, 'TEST Discount Supply', true) returning id", [orgId])).id;
    const dBill = await bill({ amount: 100, date: "2001-05-01", account: discAcct, number: "TEST-DR-D" });
    const doc = (
      await one(
        `insert into public.supplier_invoices (org_id, supplier_account_id, invoice_number, kind, invoice_date, total, open_balance, closed, discount_amount, discount_by)
         values ($1, $2, 'TEST-DR-D', 'invoice', '2001-05-01', 100, 100, false, 2, '2001-06-10') returning id`,
        [orgId, discAcct],
      )
    ).id;
    await c.query("insert into public.bill_supplier_invoices (org_id, bill_id, supplier_invoice_id) values ($1, $2, $3)", [orgId, dBill, doc]);
    const fourth = await recordSupplierPayment({ accountId: discAcct, amount: 98, paidOn: "2001-06-05", method: "check", billIds: [dBill] });
    expect(fourth.ok, JSON.stringify(fourth)).toBe(true);
    expect(fourth.message).toContain(`${sayMoney(2)} of that is TEST Discount Supply's prompt-pay discount, so TEST-DR-D is paid in full`);
    expect(await money(dBill)).toEqual({ amount: 100, paid: 100, status: "paid" });
    expect(await one("select amount, discount from public.supplier_payment_allocations where bill_id = $1", [dBill])).toEqual({ amount: 98, discount: 2 });

    // Undo through the door: what the payment paid is back on account, in its words.
    const undo = await voidSupplierPayment(String(second.paymentId));
    expect(undo.ok, JSON.stringify(undo)).toBe(true);
    expect(undo.message).toContain("any bills it paid are back on account");
    expect(await money(cBill)).toEqual({ amount: 70, paid: 0, status: "unpaid" });
    expect(await money(b)).toEqual({ amount: 80, paid: 70, status: "unpaid" });

    // Another company's bill in the boxes is refused before anything is written.
    const stranger = await bill({ amount: 30, org: otherOrgId, account: otherAcct, number: "TEST-DR-X" });
    const before = Number((await one("select count(*)::int as n from public.supplier_payments where org_id = $1", [orgId])).n);
    const bad = await recordSupplierPayment({ accountId: doorAcct, amount: 30, paidOn: "2001-06-06", billIds: [stranger] });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("not on this account");
    expect(Number((await one("select count(*)::int as n from public.supplier_payments where org_id = $1", [orgId])).n)).toBe(before);
    expect(state.reported).toEqual([]);
  });
});
