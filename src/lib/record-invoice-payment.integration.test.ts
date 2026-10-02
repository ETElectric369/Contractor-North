import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { assertTestDatabase } from "@/lib/db-guard";
import { ACTIVE_JOB_STATUSES, JOB_STATUSES } from "./job-status";
import { tapPaymentKey } from "./record-invoice-payment";

/**
 * THE SCHEMA BEHIND "TAP TO PAY TELLS THE TRUTH" (0e2cb937 / 209451e1, 2026-09-30), against the
 * REAL tables in a rolled-back transaction — the facts the two new server paths lean on and the
 * unit fakes can only assume:
 *
 *   1. payments.stripe_event_id is UNIQUE where not null (0060): the lock both tap writers (the
 *      webhook and tapPaymentOutcome) share, under one PaymentIntent-derived key. The second
 *      insert is a 23505 at the database, not a convention.
 *   2. payments.stripe_payment_intent (0220) is there to look a prior row up by, with org_id.
 *   3. invoices carries job_id, invoice_kind (standard | deposit | progress | final) and status —
 *      the three completeJobWhenPaid reads.
 *   4. jobs.status is the job_status enum and takes every value ACTIVE_JOB_STATUSES names, plus
 *      'complete'; the checked update (status in the active set, returning id) moves an active
 *      job and leaves a complete one alone.
 *   5. jobs.customer_id is nullable and the settleUp backfill's shape (set only where null,
 *      returning id) is honoured by the schema.
 *
 * Gated on DB creds (no infra committed); skips cleanly without them:
 *   CI=true TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

d("the payment writer's and the job-completion gate's schema (DB integration)", () => {
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

  async function scaffold() {
    const { orgId } = await mintThrowawayOrg(client, { label: "tap-truth", techs: 0 });
    const { rows: [cust] } = await client.query("insert into customers (org_id, name) values ($1,'TEST Rich Siskin') returning id", [orgId]);
    const { rows: [job] } = await client.query(
      `insert into jobs (org_id, name, job_number, status, billing_type)
       values ($1,'700 North Juniper Boulevard','TEST-J83','in_progress','tm') returning id`,
      [orgId],
    );
    const { rows: [inv] } = await client.query(
      `insert into invoices (org_id, customer_id, job_id, invoice_number, status, invoice_kind, total, amount_paid)
       values ($1,$2,$3,'TEST-INV-083','sent','standard',420,0) returning id`,
      [orgId, cust.id, job.id],
    );
    return { orgId, custId: cust.id as string, jobId: job.id as string, invoiceId: inv.id as string };
  }

  it("one PaymentIntent, one row: the second writer under the tap key is a 23505, and the row is findable by its intent", async () => {
    await client.query("begin");
    try {
      const { orgId, invoiceId } = await scaffold();
      const key = tapPaymentKey("pi_test_420");
      await client.query(
        `insert into payments (org_id, invoice_id, amount, method, note, stripe_event_id, stripe_payment_intent)
         values ($1,$2,420,'card','Tap to Pay on iPhone',$3,'pi_test_420')`,
        [orgId, invoiceId, key],
      );
      // The other writer (the webhook a beat later, or the sheet a beat later) — same key.
      await client.query("savepoint second_writer");
      let code = "";
      try {
        await client.query(
          `insert into payments (org_id, invoice_id, amount, method, note, stripe_event_id, stripe_payment_intent)
           values ($1,$2,420,'card','Tap to Pay on iPhone',$3,'pi_test_420')`,
          [orgId, invoiceId, key],
        );
      } catch (e) {
        code = String((e as { code?: string }).code ?? "");
        await client.query("rollback to savepoint second_writer");
      }
      expect(code).toBe("23505");
      // Lock 2: the prior-row lookup the shared writer runs first.
      const { rows } = await client.query("select id from payments where stripe_payment_intent = $1 and org_id = $2 limit 1", ["pi_test_420", orgId]);
      expect(rows).toHaveLength(1);
      const { rows: all } = await client.query("select count(*)::int as n from payments where invoice_id = $1", [invoiceId]);
      expect(all[0].n).toBe(1);
    } finally {
      await client.query("rollback");
    }
  });

  it("the three invoice columns the completion gate reads, and the enum values it gates on, are real", async () => {
    await client.query("begin");
    try {
      const { invoiceId } = await scaffold();
      const { rows: [inv] } = await client.query("select id, job_id, invoice_kind, status from invoices where id = $1", [invoiceId]);
      expect(inv.invoice_kind).toBe("standard");
      expect(inv.job_id).toBeTruthy();
      const { rows: kinds } = await client.query(
        "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'invoices_invoice_kind_check'",
      );
      for (const k of ["standard", "deposit", "progress", "final"]) expect(kinds[0].def).toContain(`'${k}'`);
      const { rows: enumRows } = await client.query(
        "select enumlabel from pg_enum where enumtypid = 'public.job_status'::regtype",
      );
      const labels = enumRows.map((r) => r.enumlabel as string);
      for (const s of JOB_STATUSES) expect(labels).toContain(s);
    } finally {
      await client.query("rollback");
    }
  });

  it("the checked completion update moves an active job and leaves a complete one exactly as it is", async () => {
    await client.query("begin");
    try {
      const { jobId } = await scaffold();
      const first = await client.query(
        "update jobs set status = 'complete' where id = $1 and status = any($2::job_status[]) returning id",
        [jobId, ACTIVE_JOB_STATUSES],
      );
      expect(first.rows).toHaveLength(1);
      // Already complete: a zero-row update, which the app reads as "the job moved", never as done again.
      const again = await client.query(
        "update jobs set status = 'complete' where id = $1 and status = any($2::job_status[]) returning id",
        [jobId, ACTIVE_JOB_STATUSES],
      );
      expect(again.rows).toHaveLength(0);
      const { rows: [job] } = await client.query("select status from jobs where id = $1", [jobId]);
      expect(job.status).toBe("complete");
    } finally {
      await client.query("rollback");
    }
  });

  it("settleUp's backfill points only a job with no customer at the one it just made", async () => {
    await client.query("begin");
    try {
      const { jobId, custId } = await scaffold();
      const { rows: [other] } = await client.query("select id from customers where id <> $1 limit 1", [custId]);
      const pointed = await client.query(
        "update jobs set customer_id = $2 where id = $1 and customer_id is null returning id",
        [jobId, custId],
      );
      expect(pointed.rows).toHaveLength(1);
      // Has one now: never re-pointed by a later payment.
      const repointed = await client.query(
        "update jobs set customer_id = $2 where id = $1 and customer_id is null returning id",
        [jobId, other?.id ?? custId],
      );
      expect(repointed.rows).toHaveLength(0);
      const { rows: [job] } = await client.query("select customer_id from jobs where id = $1", [jobId]);
      expect(job.customer_id).toBe(custId);
    } finally {
      await client.query("rollback");
    }
  });
});
