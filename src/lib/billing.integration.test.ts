import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { assertTestDatabase } from "@/lib/db-guard";
// audit v921: the draw kinds and the blocker predicate come from the APP's own module, not
// re-typed here. This test used to hand-write `invoice_kind in ('deposit','progress','final')`
// and the `total > 0.005 or exists(items)` predicate — copies that stayed green no matter how
// far the real guards drifted from them.
import { DRAW_KINDS, isStandardBillingBlocker } from "./invoice-math";
import { foldClaims } from "./unbilled-work";
import { isActualsDraw } from "./actuals-draw";
import { planLaborOffer } from "./labor-offer";
import { computeJobLaborBilling, withoutClaimedLabor } from "./labor-billing";

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
    await assertTestDatabase(client);
  });
  afterAll(async () => {
    await client?.end();
  });

  /** A throwaway TEST org (owner + tech), customer and T&M job, inside the caller's open transaction. */
  async function scaffold() {
    const { orgId } = await mintThrowawayOrg(client, { label: "billing", techs: 1 });
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
      const { rows: [person] } = await client.query("select id from profiles where org_id=$1 order by (role = 'tech') desc limit 1", [orgId]);
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
      // A third shift nobody bills until the edited-line step below offers it.
      const { rows: [e3] } = await client.query(
        `insert into time_entries (org_id, profile_id, job_id, clock_in, clock_out, status)
         values ($1,$2,$3,'2026-09-11T15:00:00Z','2026-09-11T19:00:00Z','closed') returning id`,
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

      // CLAIMS ARE PER ROW, NOT PER JOB. This case used to MOVE e1 to a second job after INV-A billed
      // it, to prove the org-wide read by id still saw the claim. Since 0288 that move is itself a
      // database refusal (a billed shift cannot change jobs, or the hour would be billable twice),
      // so the case now pins the boundary instead. Under a savepoint so the refusal doesn't abort
      // the transaction the rest of this case runs in.
      const { rows: [job2] } = await client.query(
        `insert into jobs (org_id, name, job_number, status, billing_type, customer_id)
         values ($1,'TEST integ job 2','TEST-J2','scheduled','tm',$2) returning id`,
        [orgId, custId],
      );
      await client.query("savepoint move_billed");
      let moveRefusal: { message?: string } | null = null;
      try {
        await client.query(`update time_entries set job_id=$1 where id=$2`, [job2.id, e1.id]);
      } catch (e) {
        moveRefusal = e as { message?: string };
      }
      await client.query("rollback to savepoint move_billed");
      expect(moveRefusal?.message).toMatch(/TEST-INV-A already bills this shift/);

      // INV-B imports the unclaimed row and claims it; INV-A's claim is untouched.
      await client.query(`select public.upsert_imported_invoice_items($1, 'labor', $2::jsonb)`, [invB.id, laborRow([e2.id], 5.25)]);
      claims = await claimsFor("00000000-0000-0000-0000-000000000000");
      expect(claims.owner.get(e1.id)?.invoice_number).toBe("TEST-INV-A");
      expect(claims.owner.get(e2.id)?.invoice_number).toBe("TEST-INV-B");

      // THE BOUNDARY (0258): a row another live invoice holds cannot be claimed here even by a caller
      // that skipped the app's claim read — the RPC's own write is refused, naming the holder. Under
      // a savepoint so the refusal doesn't abort the transaction the rest of this case runs in.
      await client.query("savepoint offer_held");
      let refusal: { code?: string; message?: string } | null = null;
      try {
        await client.query(`select public.upsert_imported_invoice_items($1, 'labor', $2::jsonb)`, [invB.id, laborRow([e1.id, e2.id], 13.25)]);
      } catch (e) {
        refusal = e as { code?: string; message?: string };
      }
      await client.query("rollback to savepoint offer_held");
      expect(refusal?.code).toBe("P0001");
      expect(refusal?.message).toMatch(/hours already billed on TEST-INV-A/);
      expect((await claimsFor("00000000-0000-0000-0000-000000000000")).owner.get(e1.id)?.invoice_number).toBe("TEST-INV-A"); // still INV-A's, untouched by the refusal

      // An EDITED line keeps the claims it has and takes no new ones: a re-import offering e2+e3 (both
      // free of any OTHER invoice) leaves it at [e2] — the office's figure on that line stands.
      await client.query(`update invoice_items set quantity = 4, edited = true where invoice_id=$1 and import_key=$2`, [invB.id, `labor:${person.id}`]);
      const { rows: [rep3] } = await client.query(
        `select public.upsert_imported_invoice_items($1, 'labor', $2::jsonb) as r`,
        [invB.id, laborRow([e2.id, e3.id], 9.25)],
      );
      expect(rep3.r.kept_edited).toBe(1);
      const { rows: [lineB] } = await client.query(`select source_ids, edited from invoice_items where invoice_id=$1`, [invB.id]);
      expect(lineB.edited).toBe(true);
      expect(lineB.source_ids).toEqual([e2.id]);
      expect((await claimsFor(invB.id)).owner.has(e3.id)).toBe(false); // e3 stays free — the edited line took nothing new

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

  it("J-011: a T&M progress draft takes the new hour and bill on the SAME draft, with claims; a fixed draw is not refreshable", async () => {
    const { rows: col } = await client.query(
      `select 1 from information_schema.columns
        where table_schema='public' and table_name='invoice_items' and column_name='source_ids'`,
    );
    if (!col.length) {
      console.warn("[billing.integration] invoice_items.source_ids is not on this database yet — apply migration 0255 to exercise J-011.");
      return;
    }
    await client.query("begin");
    try {
      const { orgId, custId, jobId } = await scaffold();
      const { rows: [person] } = await client.query("select id, full_name from profiles where org_id=$1 order by (role = 'tech') desc limit 1", [orgId]);

      // The draw as createProgressReportInvoice builds it: a draft 'progress' invoice itemizing the
      // job's actuals — one shift at the person's rate and one supplier bill.
      const { rows: [e1] } = await client.query(
        `insert into time_entries (org_id, profile_id, job_id, clock_in, clock_out, status)
         values ($1,$2,$3,'2026-08-20T15:00:00Z','2026-08-20T23:00:00Z','closed') returning id, clock_in, clock_out`,
        [orgId, person.id, jobId],
      );
      const { rows: [b1] } = await client.query(
        `insert into bills (org_id, job_id, supplier, amount) values ($1,$2,'TEST CED',100) returning id`,
        [orgId, jobId],
      );
      const { rows: [draw] } = await client.query(
        `insert into invoices (org_id, customer_id, job_id, invoice_number, status, invoice_kind, total, amount_paid)
         values ($1,$2,$3,'TEST-INV-078','draft','progress',0,0) returning id`,
        [orgId, custId, jobId],
      );
      const laborKey = `labor:${person.id}`;
      await client.query(`select public.upsert_imported_invoice_items($1, 'labor', $2::jsonb)`, [
        draw.id,
        JSON.stringify([{ import_key: laborKey, description: "Labor - Test", quantity: 8, unit: "hr", unit_price: 115, source_ids: [e1.id] }]),
      ]);
      const costRow = (id: string, amt: number) => ({ import_key: `bill:${id}`, description: "Materials — TEST CED", quantity: 1, unit: "lot", unit_price: amt, source_ids: [id] });
      await client.query(`select public.upsert_imported_invoice_items($1, 'costs', $2::jsonb)`, [draw.id, JSON.stringify([costRow(b1.id, 115)])]);
      // Andrew's personal rate: the office negotiates the labor line by hand (INV-078's three lines).
      await client.query(`update invoice_items set unit_price = 100, edited = true where invoice_id=$1 and import_key=$2`, [draw.id, laborKey]);

      // THE SERVER'S RULE, fed what the database says about this draw.
      const shapeOf = async (invoiceId: string, jid: string) => {
        const { rows: lines } = await client.query(`select import_source from invoice_items where invoice_id=$1`, [invoiceId]);
        const { rows: sched } = await client.query(`select id from payment_milestones where job_id=$1 limit 1`, [jid]);
        const { rows: [inv] } = await client.query(`select invoice_kind, dismissed_import_keys from invoices where id=$1`, [invoiceId]);
        return { invoiceKind: inv.invoice_kind, scheduleActive: sched.length > 0, lineSources: lines.map((l: any) => l.import_source), dismissedKeys: inv.dismissed_import_keys ?? [] };
      };
      expect(isActualsDraw(await shapeOf(draw.id, jobId))).toBe(true);

      // New work since: a 6-hour shift and a $323.71 bill.
      const { rows: [e2] } = await client.query(
        `insert into time_entries (org_id, profile_id, job_id, clock_in, clock_out, status)
         values ($1,$2,$3,'2026-09-22T15:00:00Z','2026-09-22T21:00:00Z','closed') returning id, clock_in, clock_out`,
        [orgId, person.id, jobId],
      );
      const { rows: [b2] } = await client.query(
        `insert into bills (org_id, job_id, supplier, amount) values ($1,$2,'TEST CED',323.71) returning id`,
        [orgId, jobId],
      );

      // What "Add to TEST-INV-078" offers, built by the app's own planner over the database's rows:
      // the entries no OTHER invoice claims, this draw's own lines, its tombstones.
      const claimsSql = `select i.id, i.invoice_number, i.status, i.created_at::text as created_at,
                                json_agg(json_build_object('import_key', it.import_key, 'source_ids', it.source_ids)) as invoice_items
                           from invoices i join invoice_items it on it.invoice_id = i.id
                          where i.job_id=$1 and i.status<>'void' and i.id<>$2
                          group by i.id`;
      const others = foldClaims((await client.query(claimsSql, [jobId, draw.id])).rows, true);
      const entries = [e1, e2].map((e: any) => ({ ...e, lunch_minutes: 0, job_code: null, profiles: { id: person.id, full_name: person.full_name, bill_rate: 115 } }));
      const free = withoutClaimedLabor(entries, new Set(others.owner.keys()));
      const { rows: own } = await client.query(
        `select id, import_key, edited, source_ids, quantity, unit_price, unit, description from invoice_items where invoice_id=$1 and import_source='labor'`,
        [draw.id],
      );
      const plan = planLaborOffer({ entries: free.jobEntries, ownLines: own, dismissed: new Set(), bill: (es) => computeJobLaborBilling(es, 95, null).lines });
      const laborRows = plan.offer.map(({ importKey, line }) => ({ import_key: importKey, description: `Labor - ${line.name}`, quantity: line.quantity, unit: "hr", unit_price: line.rate, source_ids: line.sourceIds }));
      const { rows: [repL] } = await client.query(`select public.upsert_imported_invoice_items($1, 'labor', $2::jsonb) as r`, [draw.id, JSON.stringify(laborRows)]);
      expect(repL.r.kept_edited).toBe(1); // the negotiated line is left alone by the RPC
      expect(repL.r.inserted).toBe(0);    // no second line for the same person (Erik's INV-078 rule)
      // THE JOIN, exactly as joinLaborHours writes it: guarded on the quantity the plan read.
      expect(plan.joins).toHaveLength(1);
      const j = plan.joins[0];
      const { rowCount: joinedRows } = await client.query(
        `update invoice_items set quantity = $2, source_ids = $3::uuid[] where id = $1 and edited and quantity = $4`,
        [j.lineId, j.fromQuantity + j.addHours, [...j.heldIds, ...j.addIds], j.fromQuantity],
      );
      expect(joinedRows).toBe(1);
      await client.query(`select public.upsert_imported_invoice_items($1, 'costs', $2::jsonb)`, [draw.id, JSON.stringify([costRow(b1.id, 115), costRow(b2.id, 372.27)])]);

      // Landed on the SAME draft and the SAME line: 8 + 6 h at the negotiated $100, both shifts claimed.
      const { rows: after } = await client.query(
        `select import_key, edited, source_ids, unit_price::float as unit_price, quantity::float as quantity from invoice_items where invoice_id=$1 order by sort_order`,
        [draw.id],
      );
      const byKey = Object.fromEntries(after.map((r: any) => [r.import_key, r]));
      expect(byKey[laborKey]).toMatchObject({ edited: true, quantity: 14, unit_price: 100 });
      expect([...byKey[laborKey].source_ids].sort()).toEqual([e1.id, e2.id].sort());
      expect(byKey[`${laborKey}:2`]).toBeUndefined();
      // A stale write (someone changed the line since the plan read it) lands on zero rows.
      const { rowCount: staleRows } = await client.query(
        `update invoice_items set quantity = $2 where id = $1 and edited and quantity = $3`,
        [j.lineId, 99, j.fromQuantity],
      );
      expect(staleRows).toBe(0);
      expect(byKey[`bill:${b2.id}`]).toMatchObject({ source_ids: [b2.id], unit_price: 372.27 });
      const { rows: invoicesNow } = await client.query(`select id, status from invoices where job_id=$1`, [jobId]);
      expect(invoicesNow).toEqual([{ id: draw.id, status: "draft" }]); // one document, still a draft

      // Never the same hour twice: another invoice on the job cannot claim e2 now (0258 trigger).
      const { rows: [std] } = await client.query(
        `insert into invoices (org_id, customer_id, job_id, invoice_number, status, invoice_kind, total, amount_paid)
         values ($1,$2,$3,'TEST-INV-079','draft','standard',0,0) returning id`,
        [orgId, custId, jobId],
      );
      await client.query("savepoint twice");
      let refusal: { code?: string; message?: string } | null = null;
      try {
        await client.query(`select public.upsert_imported_invoice_items($1, 'labor', $2::jsonb)`, [
          std.id,
          JSON.stringify([{ import_key: laborKey, description: "Labor - Test", quantity: 6, unit: "hr", unit_price: 115, source_ids: [e2.id] }]),
        ]);
      } catch (e) {
        refusal = e as { code?: string; message?: string };
      }
      await client.query("rollback to savepoint twice");
      expect(refusal?.code).toBe("P0001");
      expect(refusal?.message).toMatch(/TEST-INV-078/);

      // A FIXED-PRICE percent draw on another job (createProgressInvoice's shape: one hand line) is
      // not refreshable, so the importers refuse it and the card offers "Open", not "Add to".
      const { rows: [job2] } = await client.query(
        `insert into jobs (org_id, name, job_number, status, billing_type, customer_id)
         values ($1,'TEST integ fixed','TEST-J3','scheduled','fixed',$2) returning id`,
        [orgId, custId],
      );
      const { rows: [pct] } = await client.query(
        `insert into invoices (org_id, customer_id, job_id, invoice_number, status, invoice_kind, total, amount_paid)
         values ($1,$2,$3,'TEST-INV-080','draft','progress',5000,0) returning id`,
        [orgId, custId, job2.id],
      );
      await client.query(
        `insert into invoice_items (org_id, invoice_id, description, quantity, unit_price) values ($1,$2,'Progress payment — 50% of remaining estimate',1,5000)`,
        [orgId, pct.id],
      );
      expect(isActualsDraw(await shapeOf(pct.id, job2.id))).toBe(false);
    } finally {
      await client.query("rollback");
    }
  });
});
