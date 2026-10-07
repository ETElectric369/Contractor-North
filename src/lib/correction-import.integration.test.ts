import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { assertTestDatabase, notOnThisDatabase } from "@/lib/db-guard";
import { foldClaims } from "./unbilled-work";
import { billItemisation } from "./bill-itemisation";
import { isReturnBill, returnCreditRows, returnLinesAgainstPurchases } from "./supplier-returns";

/**
 * THE IMPORTER TRIPWIRE FOR CORRECTIONS (0381): a correction reaches the next invoice because it IS
 * a bill on the job, with no importer change at all. If that stops being true, this fails.
 *
 * The rows are the database's, read with the importer's own projections (importCostsCore's bills
 * read: on the job, not set aside; readBillLines' line read; claimedSourcesOnJob's claims, folded by
 * the app's foldClaims). The arithmetic is the app's own (billItemisation for a purchase,
 * returnLinesAgainstPurchases + returnCreditRows for a credit), walked in the importer's order: a
 * claimed bill is skipped, a bill below zero is a return, the rest are itemized. The offer is then
 * written through the REAL RPC (upsert_imported_invoice_items), so the claim boundary is the
 * database's, not this file's. Proven, at the job's 11% markup:
 *   · the ticket an earlier invoice holds is skipped, and offering it anyway is refused by the RPC;
 *   · its correction is offered as exactly its own line, at markup, and lands claimed by its own id;
 *   · a credit that names a line the customer was billed for credits it back, at markup;
 *   · a credit that names a line the customer was never billed for credits nothing.
 *
 * Gated on DB creds (no infra committed); skips cleanly without them, inside one transaction that is
 * always rolled back, in a TEST company minted inside it:
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

const MARKUP = 11;

d("a correction reaches the next invoice as a bill on the job (0381 importer tripwire)", () => {
  let client: pg.Client;
  beforeAll(async () => {
    client = new pg.Client({
      host: TEST_DB_HOST,
      port: 5432,
      user: TEST_DB_USER,
      password: TEST_DBPW,
      database: "postgres",
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    await assertTestDatabase(client);
  });
  afterAll(async () => {
    await client?.end();
  });

  it("the claimed ticket is skipped, its correction is offered at markup, and a credit follows the line it names", async () => {
    const { rows: col } = await client.query(
      `select 1 from information_schema.columns where table_schema = 'public' and table_name = 'bills' and column_name = 'corrects_bill_id'`,
    );
    if (!col.length) {
      notOnThisDatabase("[correction-import] bills.corrects_bill_id is not on this database yet; apply migration 0381 to exercise the importer tripwire.");
      return;
    }
    await client.query("begin");
    try {
      const { orgId } = await mintThrowawayOrg(client, { label: "correction-import", techs: 0 });
      const one = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows[0];
      const custId = (await one("insert into customers (org_id, name) values ($1, 'TEST correction cust') returning id", [orgId])).id;
      const jobId = (
        await one(
          `insert into jobs (org_id, name, job_number, status, billing_type, customer_id)
           values ($1, 'TEST correction job', 'TEST-CI-J1', 'in_progress', 'tm', $2) returning id`,
          [orgId, custId],
        )
      ).id;
      const bill = async (number: string, amount: number, at: string, corrects: string | null = null) =>
        (
          await one(
            `insert into bills (org_id, job_id, supplier, bill_number, amount, status, bill_date, corrects_bill_id, created_at)
             values ($1, $2, 'TEST CED', $3, $4, 'unpaid', '2001-09-29', $5, $6::timestamptz) returning id`,
            [orgId, jobId, number, amount, corrects, at],
          )
        ).id as string;
      const lines = async (billId: string, ls: [string, number, boolean, string | null][]) => {
        let i = 0;
        for (const [description, amount, billable, category] of ls) {
          await client.query(
            `insert into bill_line_items (org_id, bill_id, description, quantity, unit_price, amount, billable, category, sort_order)
             values ($1, $2, $3, 1, $4, $4, $5, $6, $7)`,
            [orgId, billId, description, amount, billable, category, i++],
          );
        }
      };

      // THE COUNTER TICKET: the fixture at $0.00, a snack that was the company's own, and tax.
      const ticket = await bill("TEST-SO-257899", 615.28, "2001-09-29T18:00:00Z");
      await lines(ticket, [
        ["LUT DVELV300PWH", 487.85, true, null],
        ["WAC EN1260RAR", 42.11, true, null],
        ["RAB KNOOKFA32 UNDERCAB LED", 0, true, null],
        ["SYL LED6MR16", 32.6, true, null],
        ["Kettle Chips", 2.09, false, "Other"],
        ["Tax", 50.63, true, "Tax"],
      ]);
      // INV-1 bills the ticket and claims it (the progress invoice that went out).
      const invoice = async (number: string) =>
        (
          await one(
            `insert into invoices (org_id, customer_id, job_id, invoice_number, status, invoice_kind, total, amount_paid)
             values ($1, $2, $3, $4, 'draft', 'progress', 0, 0) returning id`,
            [orgId, custId, jobId, number],
          )
        ).id as string;
      const inv1 = await invoice("TEST-CI-INV-1");
      await client.query(`select public.upsert_imported_invoice_items($1, 'costs', $2::jsonb)`, [
        inv1,
        JSON.stringify([{ import_key: `bill:${ticket}`, description: "Materials — TEST CED", quantity: 1, unit: "lot", unit_price: 682.96, source_ids: [ticket] }]),
      ]);
      await client.query(`update invoices set status = 'paid', total = 682.96, amount_paid = 682.96 where id = $1`, [inv1]);

      // THE SUPPLIER'S LATER PAPERS, each its own bill under the ticket.
      const fixture = await bill("TEST-1109100", 95.99, "2001-09-30T18:00:00Z", ticket);
      await lines(fixture, [["RAB KNOOKFA32 UNDERCAB LED", 95.99, true, null]]);
      const creditBilled = await bill("TEST-1109300", -42.11, "2001-10-01T18:00:00Z", ticket);
      await lines(creditBilled, [["WAC EN1260RAR", -42.11, true, null]]);
      // Written past the door on purpose (the door would have followed the snack's switch): the
      // importer's own cap is what is held here, so a credit naming a line nobody billed credits nothing
      // whatever its own switch says.
      const creditUnbilled = await bill("TEST-1109400", -2.09, "2001-10-02T18:00:00Z", ticket);
      await lines(creditUnbilled, [["Kettle Chips", -2.09, true, "Other"]]);
      // Attached: each took the ticket's job and status (0381).
      const { rows: attached } = await client.query(`select job_id, status from bills where corrects_bill_id = $1`, [ticket]);
      expect(attached).toEqual([0, 1, 2].map(() => ({ job_id: jobId, status: "unpaid" })));

      const inv2 = await invoice("TEST-CI-INV-2");

      // ── THE IMPORTER'S READS, AS IT ASKS THEM ────────────────────────────────────────────────
      const { rows: bills } = await client.query(
        // Money arrives as text, the way PostgREST hands numeric to the importer; created_at as its text.
        `select id, supplier, bill_number, amount, po_id, pricing_provisional, created_at::text as created_at
           from bills where job_id = $1 and superseded_by_bill_id is null`,
        [jobId],
      );
      expect(bills.map((b: any) => b.id).sort()).toEqual([ticket, fixture, creditBilled, creditUnbilled].sort());
      const { rows: blis } = await client.query(
        `select id, bill_id, description, quantity, unit_price, amount, category, sort_order, billable, billed_amount
           from bill_line_items where bill_id = any($1::uuid[]) order by sort_order`,
        [bills.map((b: any) => b.id)],
      );
      const linesOf = (id: string) => blis.filter((l: any) => l.bill_id === id);
      const claimsSql = `select i.id, i.invoice_number, i.status, i.created_at::text as created_at,
                                json_agg(json_build_object('import_key', it.import_key, 'source_ids', it.source_ids)) as invoice_items
                           from invoices i join invoice_items it on it.invoice_id = i.id
                          where i.job_id = $1 and i.status <> 'void' and i.id <> $2
                          group by i.id`;
      const claims = foldClaims((await client.query(claimsSql, [jobId, inv2])).rows, true);
      expect(claims.owner.get(ticket)?.invoice_number).toBe("TEST-CI-INV-1");
      expect(claims.owner.has(fixture)).toBe(false);

      // ── THE IMPORTER'S WALK, ITS ARITHMETIC THE APP'S OWN ────────────────────────────────────
      const returns = returnLinesAgainstPurchases(bills, (b: any) => linesOf(String(b.id)), new Set(claims.owner.keys()));
      const skipped: string[] = [];
      const offer = new Map<string, { import_key: string; description: string; quantity: number; unit: string; unit_price: number }[]>();
      for (const b of bills as any[]) {
        const id = String(b.id);
        if (claims.owner.has(id)) {
          skipped.push(id);
          continue;
        }
        if (isReturnBill(b.amount)) offer.set(id, returnCreditRows(b, returns.get(b) ?? linesOf(id), MARKUP));
        else if (Number(b.amount) > 0) offer.set(id, billItemisation(b, linesOf(id), MARKUP));
      }
      const total = (rs: { quantity: number; unit_price: number }[] = []) => Math.round(rs.reduce((s, r) => s + r.quantity * r.unit_price, 0) * 100) / 100;

      // The ticket INV-1 holds is skipped.
      expect(skipped).toEqual([ticket]);
      // The correction is exactly its own itemized line, at 11%: 95.99 → 106.55.
      expect(offer.get(fixture)).toEqual([
        { import_key: `bli:${linesOf(fixture)[0].id}`, description: "RAB KNOOKFA32 UNDERCAB LED", quantity: 1, unit: "ea", unit_price: 106.55 },
      ]);
      // A credit on a line the customer was billed for comes back at markup: 42.11 → −46.74.
      expect(offer.get(creditBilled)?.map((r) => r.description)).toEqual(["Returned: WAC EN1260RAR"]);
      expect(total(offer.get(creditBilled))).toBe(-46.74);
      // A credit on the line that was the company's own credits nothing.
      expect(offer.get(creditUnbilled)).toEqual([]);

      // ── WRITTEN THROUGH THE REAL RPC: THE CLAIM BOUNDARY IS THE DATABASE'S ───────────────────
      const rows = [...offer.entries()].flatMap(([id, rs]) => rs.map((r) => ({ ...r, source_ids: [id] })));
      await client.query(`select public.upsert_imported_invoice_items($1, 'costs', $2::jsonb)`, [inv2, JSON.stringify(rows)]);
      const { rows: landed } = await client.query(
        `select description, unit_price::float8 as unit_price, source_ids from invoice_items where invoice_id = $1 order by unit_price desc`,
        [inv2],
      );
      expect(landed).toEqual([
        { description: "RAB KNOOKFA32 UNDERCAB LED", unit_price: 106.55, source_ids: [fixture] },
        { description: "Returned: WAC EN1260RAR", unit_price: -46.74, source_ids: [creditBilled] },
      ]);
      // INV-1 still holds the ticket, untouched.
      expect(foldClaims((await client.query(claimsSql, [jobId, inv2])).rows, true).owner.get(ticket)?.invoice_number).toBe("TEST-CI-INV-1");
      // And offering the ticket here anyway is refused by the database (0258), naming INV-1.
      await client.query("savepoint offer_ticket");
      let refusal: { code?: string; message?: string } | null = null;
      try {
        await client.query(`select public.upsert_imported_invoice_items($1, 'costs', $2::jsonb)`, [
          inv2,
          JSON.stringify([...rows, { import_key: `bill:${ticket}`, description: "Materials — TEST CED", quantity: 1, unit: "lot", unit_price: 1, source_ids: [ticket] }]),
        ]);
      } catch (e) {
        refusal = e as { code?: string; message?: string };
      }
      await client.query("rollback to savepoint offer_ticket");
      expect(refusal?.code).toBe("P0001");
      expect(refusal?.message).toMatch(/TEST-CI-INV-1/);
    } finally {
      await client.query("rollback");
    }
  });
});
