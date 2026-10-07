import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { assertTestDatabase, notOnThisDatabase } from "@/lib/db-guard";

/**
 * A BILL MAY CORRECT AN EARLIER BILL (0381), WHERE IT MEETS THE DATABASE.
 *
 * The three triggers 0381 adds, and the REAL doors in front of them (correctBill, deleteBill:
 * requireStaff → the reads → the writes), run against the test database through the PostgREST-shaped
 * shim over one pg connection, speaking as the company's office exactly as PostgREST does. Proven:
 *   · Correct This Bill writes its own bill UNDER the original, with its own line, and the sentence;
 *     an attach TAKES the original's job and status whatever is sent;
 *   · one level only: a correction of a correction is refused, at the door and at the database;
 *   · never on or as a bill set aside as a duplicate, and a bill carrying a correction cannot be set
 *     aside;
 *   · a claimed bill keeps its figure (guard_claimed_bill_amount), in the Edit Bill door's own words;
 *     an unclaimed correction's figure can still be fixed;
 *   · the original moves or settles and its correction follows; the correction cannot leave on its
 *     own; a claimed correction refuses the whole move, naming its invoice;
 *   · an original under a correction cannot be deleted: the FK refuses (dbError says it), and the
 *     Delete door refuses first, naming the correction; delete the correction, then the original goes.
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

import { correctBill, deleteBill } from "./actions";
import { billRepricedRefusal, planBillEdit } from "./bill-claims";
import { correctionOfCorrectionRefusal, setAsideOriginalRefusal } from "@/lib/bill-correction";
import { dbError } from "@/lib/db-error";
import { mintOrgAndStranger } from "@/lib/throwaway-org.db-fixture";
import { PG_TYPES, postgrestShim } from "@/lib/postgrest-shim.db-fixture";

d("a bill may correct an earlier bill (0381): the door and the three triggers", () => {
  let c: pg.Client;
  let ready = false;
  let orgId = "";
  let staffId = "";
  let jobA = "";
  let jobB = "";
  let custId = "";
  /** The counter ticket an invoice already bills. */
  let ticket = "";
  /** Its correction, written by the real door. */
  let fixture = "";

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const rows = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;
  const asOffice = () => (state.member = { supabase: postgrestShim(c, staffId), userId: staffId, orgId, staff: true });
  const needs = () => ready || notOnThisDatabase("[bill-correction] bills.corrects_bill_id and 0381's triggers are not on this database; run node scripts/test-db/rebuild.cjs.");
  /** A statement the database must refuse, under a savepoint so the suite's one transaction lives on. */
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
  const bill = async (o: { job?: string | null; number: string; amount: number; status?: string; corrects?: string | null; superseded?: string | null }) =>
    (
      await one(
        `insert into public.bills (org_id, job_id, supplier, bill_number, amount, status, bill_date, corrects_bill_id, superseded_by_bill_id)
         values ($1, $2, 'TEST CED', $3, $4, $5, '2001-09-29', $6, $7) returning id`,
        [orgId, o.job === undefined ? jobA : o.job, o.number, o.amount, o.status ?? "unpaid", o.corrects ?? null, o.superseded ?? null],
      )
    ).id as string;
  const lines = async (billId: string, ls: { description: string; amount: number; billable?: boolean; category?: string | null }[]) => {
    let i = 0;
    for (const l of ls) {
      await c.query(
        `insert into public.bill_line_items (org_id, bill_id, description, quantity, unit_price, amount, billable, category, sort_order)
         values ($1, $2, $3, 1, $4, $4, $5, $6, $7)`,
        [orgId, billId, l.description, l.amount, l.billable ?? true, l.category ?? null, i++],
      );
    }
  };
  let invSeq = 0;
  /** An invoice on `job` whose one materials line claims `billIds` (0255), then sent and paid. */
  const claim = async (job: string, billIds: string[]) => {
    const number = `TEST-BC-INV-${++invSeq}`;
    const inv = await one(
      `insert into public.invoices (org_id, customer_id, job_id, invoice_number, status, invoice_kind, total, amount_paid)
       values ($1, $2, $3, $4, 'draft', 'progress', 0, 0) returning id`,
      [orgId, custId, job, number],
    );
    await c.query(
      `insert into public.invoice_items (org_id, invoice_id, description, quantity, unit_price, import_source, import_key, source_ids)
       values ($1, $2, 'TEST materials', 1, 100, 'costs', $3, $4::uuid[])`,
      [orgId, inv.id, `bill:${billIds[0]}`, billIds],
    );
    await c.query("update public.invoices set status = 'paid', total = 100, amount_paid = 100 where id = $1", [inv.id]);
    return number;
  };

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
      `select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bills' and column_name = 'corrects_bill_id') as col,
              (select count(*)::int from pg_trigger where tgrelid = 'public.bills'::regclass and not tgisinternal
                 and tgname in ('guard_bill_correction', 'bill_corrections_follow', 'guard_claimed_bill_amount', 'guard_bill_claim')) as triggers`,
    );
    ready = has.col === true && has.triggers === 4;
    if (!ready) return;
    const fx = await mintOrgAndStranger(c, "bill-correction");
    orgId = fx.orgId;
    staffId = fx.staffId;
    custId = (await one("insert into public.customers (org_id, name) values ($1, 'TEST correction customer') returning id", [orgId])).id;
    const job = async (num: string, name: string) =>
      (
        await one(
          "insert into public.jobs (org_id, name, job_number, status, billing_type, customer_id) values ($1, $2, $3, 'in_progress', 'tm', $4) returning id",
          [orgId, name, num, custId],
        )
      ).id as string;
    jobA = await job("TEST-BC-J1", "TEST Correction Job");
    jobB = await job("TEST-BC-J2", "TEST Other Job");
    // The counter ticket: five lines, the fixture priced at $0.00, already billed on a paid invoice.
    ticket = await bill({ number: "TEST-SO-257899", amount: 613.19 });
    await lines(ticket, [
      { description: "LUT DVELV300PWH", amount: 487.85 },
      { description: "WAC EN1260RAR", amount: 42.11 },
      { description: "RAB KNOOKFA32 UNDERCAB LED", amount: 0 },
      { description: "SYL LED6MR16", amount: 32.6 },
      { description: "Tax", amount: 50.63, category: "Tax" },
    ]);
    await claim(jobA, [ticket]);
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("Correct This Bill writes its own bill under the original, with its own line, and says the pair is one purchase", async () => {
    if (!needs()) return;
    asOffice();
    const res = await correctBill({
      billId: ticket,
      paperNumber: "TEST-1109100",
      paperTotal: 709.18,
      billDate: "2001-09-30",
      lines: [{ description: "RAB KNOOKFA32 UNDERCAB LED", amount: null }],
    });
    expect(res).toEqual({
      ok: true,
      id: expect.any(String),
      sentence:
        "TEST-1109100 corrects TEST-SO-257899: +$95.99 (RAB KNOOKFA32 UNDERCAB LED). The pair is one purchase, $709.18. " +
        "The next invoice on TEST-BC-J1 · TEST Correction Job carries the $95.99.",
    });
    fixture = String(res.id);
    const row = await one(
      "select org_id, job_id, status, amount, bill_number, bill_date, corrects_bill_id, supplier, created_by from public.bills where id = $1",
      [fixture],
    );
    expect(row).toEqual({
      org_id: orgId,
      job_id: jobA,
      status: "unpaid",
      amount: 95.99,
      bill_number: "TEST-1109100",
      bill_date: "2001-09-30",
      corrects_bill_id: ticket,
      supplier: "TEST CED",
      created_by: staffId,
    });
    expect(await rows("select description, quantity, unit_price, amount, billable from public.bill_line_items where bill_id = $1", [fixture])).toEqual([
      { description: "RAB KNOOKFA32 UNDERCAB LED", quantity: 1, unit_price: 95.99, amount: 95.99, billable: true },
    ]);
    // The original stays exactly as filed.
    expect(await one("select amount, corrects_bill_id from public.bills where id = $1", [ticket])).toEqual({ amount: 613.19, corrects_bill_id: null });
    // The same paper twice is one tap too many, never a second row.
    const again = await correctBill({ billId: ticket, paperNumber: "test-1109100", paperTotal: 805.17, billDate: "2001-09-30", lines: [{ description: "x" }] });
    expect(again).toEqual({ ok: false, error: "test-1109100 is already attached to TEST-SO-257899. Nothing was attached." });
  });

  it("an attach TAKES the original's job and status, whatever the writer sent", async () => {
    if (!needs()) return;
    const loose = await bill({ number: "TEST-O-LOOSE", amount: 10, status: "paid" });
    const attached = await one(
      `insert into public.bills (org_id, job_id, supplier, bill_number, amount, status, corrects_bill_id)
       values ($1, $2, 'TEST CED', 'TEST-C-LOOSE', 1, 'unpaid', $3) returning job_id, status`,
      [orgId, jobB, loose],
    );
    expect(attached).toEqual({ job_id: jobA, status: "paid" });
  });

  it("one level only: a correction of a correction is refused, at the door and at the database", async () => {
    if (!needs()) return;
    const e = await refused(
      "insert into public.bills (org_id, job_id, supplier, bill_number, amount, corrects_bill_id) values ($1, $2, 'TEST CED', 'TEST-CHAIN', 5, $3)",
      [orgId, jobA, fixture],
    );
    expect(e?.code).toBe("P0001");
    expect(e?.message).toBe(correctionOfCorrectionRefusal("TEST-1109100"));
    asOffice();
    expect(await correctBill({ billId: fixture, paperNumber: "TEST-CHAIN", paperTotal: 100, lines: [{ description: "x" }] })).toEqual({
      ok: false,
      error: correctionOfCorrectionRefusal("TEST-1109100"),
    });
    expect((await refused("update public.bills set corrects_bill_id = id where id = $1", [ticket]))?.message).toBe("A bill cannot correct itself. Nothing was changed.");
  });

  it("never on, and never as, a bill set aside as a duplicate; and a bill carrying a correction cannot be set aside", async () => {
    if (!needs()) return;
    const keeper = await bill({ number: "TEST-KEEP", amount: 95.27 });
    const copy = await bill({ number: "TEST-COPY", amount: 95.27, superseded: keeper });
    const onCopy = await refused(
      "insert into public.bills (org_id, job_id, supplier, bill_number, amount, corrects_bill_id) values ($1, $2, 'TEST CED', 'TEST-ON-COPY', 5, $3)",
      [orgId, jobA, copy],
    );
    expect(onCopy?.message).toBe(setAsideOriginalRefusal("TEST-COPY"));
    asOffice();
    expect(await correctBill({ billId: copy, paperNumber: "TEST-ON-COPY", paperTotal: 100, lines: [{ description: "x" }] })).toEqual({
      ok: false,
      error: setAsideOriginalRefusal("TEST-COPY"),
    });
    expect((await refused("update public.bills set superseded_by_bill_id = $1 where id = $2", [keeper, ticket]))?.message).toBe(
      "This bill carries a correction, so it cannot be set aside as a duplicate. Delete the correction first. Nothing was changed.",
    );
    expect((await refused("update public.bills set superseded_by_bill_id = $1 where id = $2", [keeper, fixture]))?.message).toBe(
      "A correction cannot be set aside as a duplicate: it belongs to the bill it corrects. Nothing was changed.",
    );
  });

  it("a claimed bill keeps its figure, in the Edit Bill door's own words; an unclaimed correction's figure can still be fixed", async () => {
    if (!needs()) return;
    const e = await refused("update public.bills set amount = 700 where id = $1", [ticket]);
    expect(e?.code).toBe("P0001");
    expect(e?.message).toBe(billRepricedRefusal({ invoice_number: "TEST-BC-INV-1" }, 613.19));
    // The door refuses first with the same sentence, so nothing is ever sent that the database refuses.
    const plan = planBillEdit({ storedJobId: jobA, storedAmount: 613.19, nextAmount: 700 }, { invoice_number: "TEST-BC-INV-1" });
    expect(plan).toEqual({ ok: false, error: e?.message });
    // Saving the same figure (the Edit Bill box sends amount on every save) is no change at all.
    expect(await refused("update public.bills set amount = 613.19, notes = 'TEST note' where id = $1", [ticket])).toBeNull();
    // The correction nobody bills yet may be fixed, then put back.
    expect(await refused("update public.bills set amount = 96 where id = $1", [fixture])).toBeNull();
    expect(await refused("update public.bills set amount = 95.99 where id = $1", [fixture])).toBeNull();
  });

  it("the original moves and settles and its correction follows; the correction cannot leave alone; a claimed correction refuses the move", async () => {
    if (!needs()) return;
    const orig = await bill({ number: "TEST-O2", amount: 50 });
    const corr = await bill({ number: "TEST-C2", amount: 5, corrects: orig });
    await c.query("update public.bills set status = 'paid' where id = $1", [orig]);
    expect(await one("select status from public.bills where id = $1", [corr])).toEqual({ status: "paid" });
    await c.query("update public.bills set job_id = $1 where id = $2", [jobB, orig]);
    expect(await one("select job_id from public.bills where id = $1", [corr])).toEqual({ job_id: jobB });
    expect((await refused("update public.bills set status = 'unpaid' where id = $1", [corr]))?.message).toBe(
      "A correction is settled with the bill it corrects (TEST-O2). Mark that bill and this one follows. Nothing was changed.",
    );
    expect((await refused("update public.bills set job_id = $1 where id = $2", [jobA, corr]))?.message).toBe(
      "A correction stays on the job of the bill it corrects (TEST-O2). Move that bill and this one follows. Nothing was changed.",
    );
    // An invoice bills the correction: moving the original would carry a billed receipt off its job,
    // so the WHOLE move fails and names that invoice (0280's guard_bill_claim, fired on the correction).
    const holder = await claim(jobB, [corr]);
    const move = await refused("update public.bills set job_id = $1 where id = $2", [jobA, orig]);
    expect(move?.message).toMatch(new RegExp(`^${holder} already bills this receipt on the job it is on`));
    expect(await one("select (select job_id from public.bills where id = $1) as orig, (select job_id from public.bills where id = $2) as corr", [orig, corr])).toEqual({
      orig: jobB,
      corr: jobB,
    });
  });

  it("an original under a correction cannot be deleted: the FK refuses, the Delete door says so first, and the correction goes first", async () => {
    if (!needs()) return;
    asOffice();
    const orig = await bill({ number: "TEST-O3", amount: 40 });
    await lines(orig, [{ description: "TEST 3/4 EMT", amount: 40 }]);
    const made = await correctBill({ billId: orig, paperNumber: "TEST-C3", paperTotal: 45, billDate: "2001-09-30", lines: [{ description: "TEST Freight" }] });
    expect(made.ok).toBe(true);
    const fk = await refused("delete from public.bills where id = $1", [orig]);
    expect(fk?.code).toBe("23503");
    expect(fk?.constraint).toBe("bills_corrects_bill_id_fkey");
    expect(dbError(fk)).toBe("This bill carries a correction. Delete the correction first, then this bill. Nothing was deleted.");
    expect(await deleteBill(orig, jobA)).toEqual({
      ok: false,
      error: "This bill carries a correction (TEST-C3). Delete the correction first, then delete it again. Nothing was deleted.",
    });
    expect(await one("select count(*)::int as n from public.bills where id = $1", [orig])).toEqual({ n: 1 });
    expect((await deleteBill(String(made.id), jobA)).ok).toBe(true);
    expect((await deleteBill(orig, jobA)).ok).toBe(true);
    expect(await one("select count(*)::int as n from public.bills where id = any($1::uuid[])", [[orig, made.id]])).toEqual({ n: 0 });
  });

  it("a credit takes back lines the bill has, following their switch and category; one that names no line is refused", async () => {
    if (!needs()) return;
    asOffice();
    const credit = await correctBill({
      billId: ticket,
      paperNumber: "TEST-1109300",
      // The purchase now counts the ticket and its first correction: $709.18. The credit memo takes $51.58 off.
      paperTotal: 657.6,
      billDate: "2001-10-02",
      lines: [{ description: "wac en1260rar", amount: -42.11 }, { description: "Tax" }],
    });
    expect(credit.ok).toBe(true);
    expect(await rows("select description, amount, billable, category from public.bill_line_items where bill_id = $1 order by sort_order", [credit.id])).toEqual([
      { description: "WAC EN1260RAR", amount: -42.11, billable: true, category: null },
      { description: "Tax", amount: -9.47, billable: true, category: "Tax" },
    ]);
    expect(await one("select amount, job_id, status from public.bills where id = $1", [credit.id])).toEqual({ amount: -51.58, job_id: jobA, status: "unpaid" });
    const stray = await correctBill({ billId: ticket, paperNumber: "TEST-1109400", paperTotal: 600, lines: [{ description: "Returned housings", amount: null }] });
    expect(stray).toEqual({
      ok: false,
      error:
        "Returned housings is not a line on TEST-SO-257899. A credit takes back a line the purchase has: pick it from the bill's lines. Nothing was attached.",
    });
  });
});
