import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

// Integration test of the draw-billing invariants the H1/H3/H4 guards rely on,
// exercised against the REAL schema in a rolled-back transaction — the SQL behaviour
// behind activeDrawOnJob, the H4 "one billing path" guard, the H3 one-open-draft
// rule, and the progress reconciliation, which the pure unit tests can't reach.
//
// Gated on DB creds (no infra committed); skips cleanly without them:
//   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npm test
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("billing draw invariants (DB integration)", () => {
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
  });
  afterAll(async () => {
    await client?.end();
  });

  it("detects the draw path, reconciles invoiced/collected, and flags the H4 + H3 conditions", async () => {
    await client.query("begin");
    try {
      const { rows: [org] } = await client.query("select id from organizations limit 1");
      const orgId = org.id;
      const { rows: [cust] } = await client.query(
        "insert into customers (org_id, name) values ($1,'TEST integ cust') returning id",
        [orgId],
      );
      const { rows: [job] } = await client.query(
        `insert into jobs (org_id, name, job_number, status, billing_type, customer_id)
         values ($1,'TEST integ job','TEST-J1','scheduled','tm',$2) returning id`,
        [orgId, cust.id],
      );

      // A SENT progress draw: $10,000 billed, $10,000 paid.
      const { rows: [draw] } = await client.query(
        `insert into invoices (org_id, customer_id, job_id, invoice_number, status, invoice_kind, total, amount_paid)
         values ($1,$2,$3,'TEST-INV-1','sent','progress',10000,10000) returning id`,
        [orgId, cust.id, job.id],
      );
      await client.query(
        // line_total is a generated column (quantity * unit_price) — don't insert it.
        `insert into invoice_items (org_id, invoice_id, description, quantity, unit_price)
         values ($1,$2,'Progress draw',1,10000)`,
        [orgId, draw.id],
      );
      await client.query("insert into payments (org_id, invoice_id, amount) values ($1,$2,10000)", [orgId, draw.id]);

      // 1. activeDrawOnJob: the job is on the draw path.
      const { rows: draws } = await client.query(
        `select id from invoices where job_id=$1 and status<>'void' and invoice_kind in ('deposit','progress','final')`,
        [job.id],
      );
      expect(draws.length).toBe(1);

      // 2. Progress reconciliation: invoiced excludes void+draft; collected excludes only void.
      const { rows: [recon] } = await client.query(
        `select coalesce(sum(total) filter (where status not in ('void','draft')),0)::float as invoiced,
                coalesce(sum(amount_paid) filter (where status<>'void'),0)::float as collected
         from invoices where job_id=$1`,
        [job.id],
      );
      expect(recon.invoiced).toBe(10000);
      expect(recon.collected).toBe(10000);

      // 3. H4 (one billing path): a STANDARD invoice on this draw-job is the double-bill
      //    condition the import/create guards must block.
      const { rows: [std] } = await client.query(
        `insert into invoices (org_id, customer_id, job_id, invoice_number, status, invoice_kind, total, amount_paid)
         values ($1,$2,$3,'TEST-INV-2','draft','standard',0,0) returning id`,
        [orgId, cust.id, job.id],
      );
      const { rows: blockers } = await client.query(
        `select id from invoices where job_id=$1 and id<>$2 and status<>'void'
           and invoice_kind in ('deposit','progress','final') limit 1`,
        [job.id, std.id],
      );
      expect(blockers.length).toBe(1); // standardInvoiceOnDrawJob would block content on std

      // 4. H3 (one open draft draw): a draft draw is found by the existing-draft check.
      const { rows: [draft] } = await client.query(
        `insert into invoices (org_id, customer_id, job_id, invoice_number, status, invoice_kind, total, amount_paid)
         values ($1,$2,$3,'TEST-INV-3','draft','progress',0,0) returning id`,
        [orgId, cust.id, job.id],
      );
      const { rows: openDrafts } = await client.query(
        `select id from invoices where job_id=$1 and status='draft' and invoice_kind in ('deposit','progress','final')`,
        [job.id],
      );
      expect(openDrafts.map((r: any) => r.id)).toContain(draft.id);
    } finally {
      await client.query("rollback");
    }
  });
});
