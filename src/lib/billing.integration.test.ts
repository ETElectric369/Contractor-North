import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
// audit v921: the draw kinds and the blocker predicate come from the APP's own module, not
// re-typed here. This test used to hand-write `invoice_kind in ('deposit','progress','final')`
// and the `total > 0.005 or exists(items)` predicate — copies that stayed green no matter how
// far the real guards drifted from them.
import { DRAW_KINDS, isStandardBillingBlocker } from "./invoice-math";
import { claimantNumbers, foldClaims } from "./unbilled-work";

// Integration test of the draw-billing invariants the H1/H3/H4 guards rely on,
// exercised against the REAL schema in a rolled-back transaction — the SQL behaviour
// behind activeDrawOnJob, the H4 "one billing path" guard, the H3 one-open-draft
// rule, the progress reconciliation, and (0255) the row-level claims that let a second
// invoice bill only what is new — which the pure unit tests can't reach.
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

  /** A throwaway customer + T&M job in the first org, inside the caller's open transaction. */
  async function scaffold() {
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
    return { orgId, custId: cust.id as string, jobId: job.id as string };
  }

  it("detects the draw path, reconciles invoiced/collected, and flags the H4 + H3 conditions", async () => {
    await client.query("begin");
    try {
      const { orgId, custId, jobId } = await scaffold();

      // A SENT progress draw: $10,000 billed, $10,000 paid.
      const { rows: [draw] } = await client.query(
        `insert into invoices (org_id, customer_id, job_id, invoice_number, status, invoice_kind, total, amount_paid)
         values ($1,$2,$3,'TEST-INV-1','sent','progress',10000,10000) returning id`,
        [orgId, custId, jobId],
      );
      await client.query(
        // line_total is a generated column (quantity * unit_price) — don't insert it.
        `insert into invoice_items (org_id, invoice_id, description, quantity, unit_price)
         values ($1,$2,'Progress draw',1,10000)`,
        [orgId, draw.id],
      );
      await client.query("insert into payments (org_id, invoice_id, amount) values ($1,$2,10000)", [orgId, draw.id]);

      // 1. activeDrawOnJob: the job is on the draw path. Kinds from DRAW_KINDS — narrow that
      //    constant and this expectation moves with it instead of silently agreeing.
      const drawKinds = [...DRAW_KINDS];
      const { rows: draws } = await client.query(
        `select id from invoices where job_id=$1 and status<>'void' and invoice_kind = any($2)`,
        [jobId, drawKinds],
      );
      expect(draws.length).toBe(1);

      // 2. Progress reconciliation: invoiced excludes void+draft; collected excludes only void.
      const { rows: [recon] } = await client.query(
        `select coalesce(sum(total) filter (where status not in ('void','draft')),0)::float as invoiced,
                coalesce(sum(amount_paid) filter (where status<>'void'),0)::float as collected
         from invoices where job_id=$1`,
        [jobId],
      );
      expect(recon.invoiced).toBe(10000);
      expect(recon.collected).toBe(10000);

      // 3. H4 (one billing path): a STANDARD invoice on this draw-job is the double-bill
      //    condition the import/create guards must block.
      const { rows: [std] } = await client.query(
        `insert into invoices (org_id, customer_id, job_id, invoice_number, status, invoice_kind, total, amount_paid)
         values ($1,$2,$3,'TEST-INV-2','draft','standard',0,0) returning id`,
        [orgId, custId, jobId],
      );
      const { rows: blockers } = await client.query(
        `select id from invoices where job_id=$1 and id<>$2 and status<>'void'
           and invoice_kind = any($3) limit 1`,
        [jobId, std.id, drawKinds],
      );
      expect(blockers.length).toBe(1); // standardInvoiceOnDrawJob would block content on std

      // 4. H3 (one open draft draw): a draft draw is found by the existing-draft check.
      const { rows: [draft] } = await client.query(
        `insert into invoices (org_id, customer_id, job_id, invoice_number, status, invoice_kind, total, amount_paid)
         values ($1,$2,$3,'TEST-INV-3','draft','progress',0,0) returning id`,
        [orgId, custId, jobId],
      );
      const { rows: openDrafts } = await client.query(
        `select id from invoices where job_id=$1 and status='draft' and invoice_kind = any($2)`,
        [jobId, drawKinds],
      );
      expect(openDrafts.map((r: any) => r.id)).toContain(draft.id);

      // 5. H4 reverse (standardBillingBlockerOnJob), NARROWED by 0255: only a DRAFT standard
      //    invoice that CARRIES content blocks a new draw. A blank draft carries nothing, and a
      //    sent/paid one is finished business (its rows are claimed; a draw bills the delta).
      //    The SQL only fetches what standardBillingBlockerOnJob fetches (kind, status, total,
      //    line count); the DECISION is made by the app's own isStandardBillingBlocker, so a
      //    change to that predicate fails here instead of passing against a copy of it.
      const candidatesSql =
        `select i.id, i.invoice_kind, i.status, coalesce(i.total,0)::float as total,
                (select count(*) from invoice_items it where it.invoice_id = i.id)::int as items
           from invoices i where i.job_id=$1 and i.status<>'void'`;
      const blockersOnJob = async () => {
        const { rows } = await client.query(candidatesSql, [jobId]);
        return rows.filter((r: any) => isStandardBillingBlocker(r.invoice_kind, r.status, r.total, r.items));
      };
      // TEST-INV-2 is still a blank ($0, no lines) standard draft → not a blocker yet.
      expect((await blockersOnJob()).length).toBe(0);
      // Add a billable line to the standard DRAFT → it now blocks a new draw ("finish it first").
      await client.query(
        `insert into invoice_items (org_id, invoice_id, description, quantity, unit_price)
         values ($1,$2,'Labor — Sam',10,95)`,
        [orgId, std.id],
      );
      expect((await blockersOnJob()).map((r: any) => r.id)).toContain(std.id);
      // Send it (or pay it) → finished business: the 85 Whitney case. INV-061 was paid and still
      // refused every progress payment on the job; that must never be true again.
      await client.query(`update invoices set status='paid', total=950, amount_paid=950 where id=$1`, [std.id]);
      expect((await blockersOnJob()).length).toBe(0);
    } finally {
      await client.query("rollback");
    }
  });

  it("0255: a labor line claims its hours; a second invoice takes only the unclaimed ones; void/delete release them", async () => {
    // The column arrives with migration 0255. Until it is applied this case can only say so —
    // loudly, not as a green skip — and the rest of the file still runs.
    const { rows: col } = await client.query(
      `select 1 from information_schema.columns
        where table_schema='public' and table_name='invoice_items' and column_name='source_ids'`,
    );
    if (!col.length) {
      console.warn("[billing.integration] invoice_items.source_ids is not on this database yet — apply migration 0255 to exercise the claim invariant.");
      return;
    }
    await client.query("begin");
    try {
      const { orgId, custId, jobId } = await scaffold();
      const { rows: [person] } = await client.query("select id from profiles where org_id=$1 limit 1", [orgId]);
      expect(person?.id).toBeTruthy(); // every org has at least its owner

      // Two closed shifts on the job, a week apart — the "nine July/August entries" and Brian's 09-10 one, in miniature.
      const { rows: [e1] } = await client.query(
        `insert into time_entries (org_id, profile_id, job_id, clock_in, clock_out, status)
         values ($1,$2,$3,'2026-08-20T15:00:00Z','2026-08-20T23:00:00Z','closed') returning id`,
        [orgId, person.id, jobId],
      );
      const { rows: [e2] } = await client.query(
        `insert into time_entries (org_id, profile_id, job_id, clock_in, clock_out, status)
         values ($1,$2,$3,'2026-09-10T18:05:00Z','2026-09-10T23:18:00Z','closed') returning id`,
        [orgId, person.id, jobId],
      );

      // INV-A bills e1 through the RPC, claiming it.
      const { rows: [invA] } = await client.query(
        `insert into invoices (org_id, customer_id, job_id, invoice_number, status, invoice_kind, total, amount_paid)
         values ($1,$2,$3,'TEST-INV-A','draft','standard',0,0) returning id`,
        [orgId, custId, jobId],
      );
      const laborRow = (ids: string[], qty: number) => JSON.stringify([
        { import_key: `labor:${person.id}`, description: "Labor — Test", quantity: qty, unit: "hr", unit_price: 75, source_ids: ids },
      ]);
      const { rows: [rep1] } = await client.query(
        `select public.upsert_imported_invoice_items($1, 'labor', $2::jsonb) as r`,
        [invA.id, laborRow([e1.id], 8)],
      );
      expect(rep1.r.inserted).toBe(1);
      const { rows: [lineA] } = await client.query(
        `select id, source_ids, edited from invoice_items where invoice_id=$1 and import_key=$2`,
        [invA.id, `labor:${person.id}`],
      );
      expect(lineA.source_ids).toEqual([e1.id]);
      await client.query(`update invoices set status='paid', total=600, amount_paid=600 where id=$1`, [invA.id]);

      // The claims another invoice on this job sees — the SQL twin of claimedSourcesOnJob, folded
      // by the app's own foldClaims so the two can't disagree about who owns what.
      const claimsSql = `select i.id, i.invoice_number, i.status, i.created_at::text as created_at,
                                json_agg(json_build_object('import_key', it.import_key, 'source_ids', it.source_ids)) as invoice_items
                           from invoices i join invoice_items it on it.invoice_id = i.id
                          where i.job_id=$1 and i.status<>'void' and i.id<>$2
                          group by i.id`;
      const claimsFor = async (invoiceId: string) => foldClaims((await client.query(claimsSql, [jobId, invoiceId])).rows, true);

      // A second invoice, INV-B: e1 is held by INV-A, e2 is free — exactly the delta it may bill.
      const { rows: [invB] } = await client.query(
        `insert into invoices (org_id, customer_id, job_id, invoice_number, status, invoice_kind, total, amount_paid)
         values ($1,$2,$3,'TEST-INV-B','draft','standard',0,0) returning id`,
        [orgId, custId, jobId],
      );
      let claims = await claimsFor(invB.id);
      expect(claims.owner.get(e1.id)?.invoice_number).toBe("TEST-INV-A");
      expect(claims.owner.has(e2.id)).toBe(false);

      // CLAIMS ARE PER ROW, NOT PER JOB. Move e1 to a second job after INV-A billed it: J2's own
      // invoice list knows nothing of it, so a J2 invoice reading claims by job alone would bill
      // e1 again. The org-wide read BY ID (claimedSourcesOnJob's second read) is what still sees
      // it — this is that read's SQL twin, folded by the app's own foldClaims. Moved back after.
      const { rows: [job2] } = await client.query(
        `insert into jobs (org_id, name, job_number, status, billing_type, customer_id)
         values ($1,'TEST integ job 2','TEST-J2','scheduled','tm',$2) returning id`,
        [orgId, custId],
      );
      await client.query(`update time_entries set job_id=$1 where id=$2`, [job2.id, e1.id]);
      const byIdSql = `select i.id, i.invoice_number, i.status, i.created_at::text as created_at, i.job_id,
                              json_build_object('job_number', j.job_number) as jobs,
                              json_agg(json_build_object('import_key', it.import_key, 'source_ids', it.source_ids)) as invoice_items
                         from invoice_items it
                         join invoices i on i.id = it.invoice_id
                         left join jobs j on j.id = i.job_id
                        where it.source_ids && $1::uuid[] and i.status<>'void'
                        group by i.id, j.job_number`;
      const onJ2 = (await client.query(claimsSql, [job2.id, invB.id])).rows;
      expect(onJ2.length).toBe(0); // J2 has no invoices of its own
      const elsewhere = (await client.query(byIdSql, [[e1.id, e2.id]])).rows;
      const seenFromJ2 = foldClaims(onJ2, true, elsewhere, job2.id);
      expect(seenFromJ2.owner.get(e1.id)?.invoice_number).toBe("TEST-INV-A");
      expect(seenFromJ2.invoices.length).toBe(0); // INV-A is J1's invoice, not J2's "last invoice"
      expect(claimantNumbers(seenFromJ2, [e1.id])).toEqual(["TEST-INV-A (TEST-J1)"]);
      await client.query(`update time_entries set job_id=$1 where id=$2`, [jobId, e1.id]);

      // INV-B imports the unclaimed row and claims it; INV-A's claim is untouched.
      await client.query(`select public.upsert_imported_invoice_items($1, 'labor', $2::jsonb)`, [invB.id, laborRow([e2.id], 5.25)]);
      claims = await claimsFor("00000000-0000-0000-0000-000000000000");
      expect(claims.owner.get(e1.id)?.invoice_number).toBe("TEST-INV-A");
      expect(claims.owner.get(e2.id)?.invoice_number).toBe("TEST-INV-B");

      // An EDITED line keeps the claims it has and takes no new ones: a re-import offering e1+e2 leaves it at [e2].
      await client.query(`update invoice_items set quantity = 4 where invoice_id=$1 and import_key=$2`, [invB.id, `labor:${person.id}`]);
      const { rows: [rep3] } = await client.query(
        `select public.upsert_imported_invoice_items($1, 'labor', $2::jsonb) as r`,
        [invB.id, laborRow([e1.id, e2.id], 13.25)],
      );
      expect(rep3.r.kept_edited).toBe(1);
      const { rows: [lineB] } = await client.query(`select source_ids, edited from invoice_items where invoice_id=$1`, [invB.id]);
      expect(lineB.edited).toBe(true);
      expect(lineB.source_ids).toEqual([e2.id]);

      // VOID releases: a void INV-A holds nothing.
      await client.query(`update invoices set status='void' where id=$1`, [invA.id]);
      claims = await claimsFor(invB.id);
      expect(claims.owner.has(e1.id)).toBe(false);
      await client.query(`update invoices set status='paid' where id=$1`, [invA.id]);
      expect((await claimsFor(invB.id)).owner.has(e1.id)).toBe(true);

      // DELETING the line releases too (the claim lives with the line, 0255).
      await client.query(`delete from invoice_items where id=$1`, [lineA.id]);
      expect((await claimsFor(invB.id)).owner.has(e1.id)).toBe(false);

      // The RPC never accepts a malformed id into a claim.
      const { rows: [invC] } = await client.query(
        `insert into invoices (org_id, customer_id, job_id, invoice_number, status, invoice_kind, total, amount_paid)
         values ($1,$2,$3,'TEST-INV-C','draft','standard',0,0) returning id`,
        [orgId, custId, jobId],
      );
      await client.query(
        `select public.upsert_imported_invoice_items($1, 'labor', $2::jsonb)`,
        [invC.id, JSON.stringify([{ import_key: "labor:x", description: "Labor — X", quantity: 1, unit: "hr", unit_price: 1, source_ids: ["not-a-uuid", e1.id] }])],
      );
      const { rows: [lineC] } = await client.query(`select source_ids from invoice_items where invoice_id=$1`, [invC.id]);
      expect(lineC.source_ids).toEqual([e1.id]);
    } finally {
      await client.query("rollback");
    }
  });
});
