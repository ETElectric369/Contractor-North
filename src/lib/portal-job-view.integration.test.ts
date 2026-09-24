import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { buildJobLedger } from "./portal/stretch-ledger";

/**
 * Migrations 0300 + 0301: what the customer sees on a job, and the one door that reads it.
 *
 * The invariants the portal stands on, spoken to the database the way PostgREST would (a tech, an
 * office member, anon) and the way the portal page does (the service role, the direct connection
 * here), inside ONE transaction that is always rolled back. It borrows an active tech and an active
 * office member of one org, and makes its own customers, jobs, bills, entries and documents dated
 * 2001-01-01, so no real row is read or touched. Read-back is the assertion, never the absence of
 * an error (the silent-write law).
 *
 * Before 0300/0301 are applied, each case says so on the console and returns: loud, not green.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npm test
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

/** The job page's building blocks, exactly (0301). A new key is a decision, not an accident. */
const VIEW_KEYS = ["billing", "customer", "invoices", "job", "lines", "org", "payments", "photos", "picks", "scope", "stretches"];
/** public_invoice's document, the one /i renders; the portal must hand over the same one. */
const DOC_KEYS = ["customer", "invoice", "items", "org", "payments", "site_candidates"];

d("what the customer sees on a job (0300/0301)", { timeout: 30_000 }, () => {
  let c: pg.Client;
  let ready = false;
  let orgId = "";
  let orgName = "";
  let techId = "";
  let staffId = "";
  let otherStaffId = "";
  let custA = "";
  let custB = "";
  let jobA = "";
  let jobB = "";
  let jobEstimate = "";
  let invA = "";
  let photoShared = "";
  let photoUnshared = "";
  let receipt = "";
  let tokenA = "";
  let tokenB = "";

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const as = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  const asAnon = async () => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
    await c.query("set local role anon");
  };
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  const refused = async (fn: () => Promise<unknown>): Promise<string | null> => {
    await c.query("savepoint attempt");
    try {
      await fn();
      await c.query("rollback to savepoint attempt");
      return null;
    } catch (e) {
      await c.query("rollback to savepoint attempt");
      return String((e as { code?: string }).code ?? (e as Error).message);
    } finally {
      await asServer();
    }
  };
  /** Run fn as someone, read what it returned, and undo it: for reads through RLS. */
  const lookAs = async <T,>(who: () => Promise<void>, fn: () => Promise<T>): Promise<T> => {
    await c.query("savepoint look");
    try {
      await who();
      return await fn();
    } finally {
      await c.query("rollback to savepoint look");
      await asServer();
    }
  };
  const needs = () => {
    if (!ready) console.warn("[portal-job-view] migrations 0300/0301 are not on this database yet; apply them to exercise this case.");
    return ready;
  };
  const view = async (token: string, jobId: string) => (await one("select public.portal_job_view($1, $2) as j", [token, jobId])).j;

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await c.query("begin");
    ready = (
      await one(
        `select to_regclass('public.job_stretches') is not null
            and to_regclass('public.job_picks') is not null
            and to_regclass('public.job_shared_photos') is not null
            and to_regprocedure('public.portal_job_view(text, uuid)') is not null
            and to_regprocedure('public.invoice_document_projection(uuid)') is not null as ok`,
      )
    ).ok;
    if (!ready) return;

    const fx = await one(
      `select t.org_id, t.id as tech_id, s.id as staff_id, o.name as org_name
         from public.profiles t
         join public.profiles s on s.org_id = t.org_id and s.role in ('owner','admin','office') and coalesce(s.active, true)
         join public.organizations o on o.id = t.org_id
        where t.role = 'tech' and coalesce(t.active, true)
        limit 1`,
    );
    if (!fx) throw new Error("0301 test fixture: no org has both an active tech and active office staff.");
    orgId = fx.org_id;
    techId = fx.tech_id;
    staffId = fx.staff_id;
    orgName = fx.org_name;
    otherStaffId =
      (await one("select id from public.profiles where org_id <> $1 and role in ('owner','admin','office') and coalesce(active, true) limit 1", [orgId]))?.id ?? "";

    const cust = async (name: string) =>
      (await one("insert into public.customers (org_id, name, notes) values ($1, $2, 'SECRET CUSTOMER NOTE') returning id", [orgId, name])).id as string;
    custA = await cust("TEST 0301 A");
    custB = await cust("TEST 0301 B");
    const job = async (customerId: string, number: string, status: string) =>
      (
        await one(
          `insert into public.jobs (org_id, name, job_number, status, billing_type, customer_id, notes, description)
           values ($1, $2, $2, $3, 'tm', $4, 'SECRET JOB NOTE', 'SECRET JOB DESCRIPTION') returning id`,
          [orgId, number, status, customerId],
        )
      ).id as string;
    jobA = await job(custA, "TEST-0301-A", "in_progress");
    jobB = await job(custB, "TEST-0301-B", "in_progress");
    jobEstimate = await job(custA, "TEST-0301-E", "estimate");

    // Two hours, one a day, in Pacific afternoons (the second crosses midnight UTC).
    const entry = async (inAt: string, outAt: string) =>
      (
        await one(
          `insert into public.time_entries (org_id, profile_id, job_id, clock_in, clock_out, status, notes, gps_in)
           values ($1, $2, $3, $4, $5, 'closed', 'SECRET ENTRY NOTE', '{"lat": 39.1, "lng": -120.2}') returning id`,
          [orgId, techId, jobA, inAt, outAt],
        )
      ).id as string;
    const e1 = await entry("2001-01-01T20:00:00Z", "2001-01-01T21:00:00Z");
    const e2 = await entry("2001-01-03T00:30:00Z", "2001-01-03T01:30:00Z"); // Jan 2, 4:30 PM Pacific
    const bill = (
      await one(
        `insert into public.bills (org_id, job_id, supplier, amount, status, bill_date, notes)
         values ($1, $2, 'TEST SECRET SUPPLIER', 40, 'unpaid', '2001-01-02', 'SECRET BILL NOTE') returning id`,
        [orgId, jobA],
      )
    ).id as string;

    const invoice = async (customerId: string, number: string, status: string) =>
      (
        await one(
          `insert into public.invoices (org_id, customer_id, job_id, invoice_number, status, invoice_kind, total, subtotal, amount_paid, notes)
           values ($1, $2, $3, $4, $5, 'standard', 0, 0, 0, null) returning id`,
          [orgId, customerId, jobA, number, status],
        )
      ).id as string;
    invA = await invoice(custA, "TEST-0301-1", "draft");
    await c.query(
      `insert into public.invoice_items (org_id, invoice_id, description, quantity, unit, unit_price, import_source, import_key, source_ids, sort_order)
       values ($1, $2, 'Labor - Tech', 2, 'hr', 100, 'labor', 'labor:test-0301', $3::uuid[], 0),
              ($1, $2, 'Wire', 1, 'ea', 50, 'costs', $4, $5::uuid[], 1)`,
      [orgId, invA, [e1, e2], `bill:${bill}:remainder`, [bill]],
    );
    await c.query("update public.invoices set subtotal = 250, total = 250, amount_paid = 100 where id = $1", [invA]);
    await c.query(
      "insert into public.payments (org_id, invoice_id, amount, method, paid_at, note) values ($1, $2, 100, 'cash', '2001-01-02T20:00:00Z', 'SECRET PAY NOTE')",
      [orgId, invA],
    );
    // Paper on the same job that is NOT this customer's: void, and billed to someone else.
    const invVoid = await invoice(custA, "TEST-0301-V", "void");
    await c.query("insert into public.invoice_items (org_id, invoice_id, description, quantity, unit_price) values ($1, $2, 'VOIDED LINE', 1, 999)", [orgId, invVoid]);
    const invOther = await invoice(custB, "TEST-0301-O", "sent");
    await c.query("insert into public.invoice_items (org_id, invoice_id, description, quantity, unit_price) values ($1, $2, 'SOMEONE ELSES LINE', 1, 777)", [orgId, invOther]);

    const doc = async (name: string, category: string) =>
      (
        await one("insert into public.documents (org_id, job_id, name, kind, category, file_url) values ($1, $2, $3, 'other', $4, $5) returning id", [
          orgId,
          jobA,
          name,
          category,
          `${orgId}/${jobA}/${name}`,
        ])
      ).id as string;
    photoShared = await doc("test-0301-panel.jpg", "Photo");
    photoUnshared = await doc("test-0301-other.jpg", "Photo");
    receipt = await doc("test-0301-receipt.jpg", "Receipt");

    tokenA = (await one("select token from public.customer_portal_access where customer_id = $1", [custA])).token;
    tokenB = (await one("select token from public.customer_portal_access where customer_id = $1", [custB])).token;

    // The office's choices, made as the office.
    await as(staffId);
    await c.query("insert into public.job_stretches (job_id, label, starts_on, ends_on) values ($1, 'Rough-in', '2001-01-01', '2001-01-01'), ($1, 'Trim', '2001-01-02', '2001-01-03')", [jobA]);
    await c.query(
      `insert into public.job_picks (job_id, category, brand, name, location, color_hex, link_url)
       values ($1, 'Paint Color', 'Benjamin Moore', 'Swiss Coffee', 'Kitchen', '#F2EFE6', 'https://example.com/oc-45')`,
      [jobA],
    );
    await c.query("insert into public.job_picks (job_id, category, name, removed_at) values ($1, 'Fixture', 'REMOVED PICK', now())", [jobA]);
    await c.query("insert into public.job_shared_photos (document_id, org_id, job_id, file_url_at_share) values ($1, $2, $3, 'whatever the request said')", [
      photoShared,
      orgId,
      jobA,
    ]);
    await asServer();
  });
  afterAll(async () => {
    await c?.query("rollback").catch(() => undefined);
    await c?.end();
  });

  it("the share row describes the document it names, whatever the request said", async () => {
    if (!needs()) return;
    const row = await one("select org_id, job_id, file_url_at_share, shared_by from public.job_shared_photos where document_id = $1", [photoShared]);
    expect(row).toMatchObject({ org_id: orgId, job_id: jobA, file_url_at_share: `${orgId}/${jobA}/test-0301-panel.jpg`, shared_by: staffId });
  });

  it("a receipt can't be shown to the customer, even by the office", async () => {
    if (!needs()) return;
    expect(
      await refused(async () => {
        await as(staffId);
        await c.query("insert into public.job_shared_photos (document_id, org_id, job_id, file_url_at_share) values ($1, $2, $3, '')", [receipt, orgId, jobA]);
      }),
    ).toBe("23514");
  });

  it("the crew reads the stretches and picks but writes none of it, and never sees the share rows", async () => {
    if (!needs()) return;
    const seen = await lookAs(
      () => as(techId),
      async () => ({
        stretches: (await c.query("select label from public.job_stretches where job_id = $1", [jobA])).rows.length,
        picks: (await c.query("select name from public.job_picks where job_id = $1 and removed_at is null", [jobA])).rows.length,
        shares: (await c.query("select document_id from public.job_shared_photos where job_id = $1", [jobA])).rows.length,
      }),
    );
    expect(seen).toEqual({ stretches: 2, picks: 1, shares: 0 });

    expect(await refused(async () => { await as(techId); await c.query("insert into public.job_stretches (job_id, label, starts_on, ends_on) values ($1, 'X', '2001-01-05', '2001-01-05')", [jobA]); })).toBe("42501");
    expect(await refused(async () => { await as(techId); await c.query("insert into public.job_picks (job_id, category) values ($1, 'Paint Color')", [jobA]); })).toBe("42501");
    expect(await refused(async () => { await as(techId); await c.query("insert into public.job_shared_photos (document_id, org_id, job_id, file_url_at_share) values ($1, $2, $3, '')", [photoUnshared, orgId, jobA]); })).toBe("42501");
    // An update the policy hides is zero rows, not an error: read it back.
    const n = await lookAs(
      () => as(techId),
      async () => (await c.query("update public.job_picks set name = 'TECH EDIT' where job_id = $1 returning id", [jobA])).rowCount,
    );
    expect(n).toBe(0);
    const unshared = await lookAs(
      () => as(techId),
      async () => (await c.query("delete from public.job_shared_photos where document_id = $1 returning document_id", [photoShared])).rowCount,
    );
    expect(unshared).toBe(0);
  });

  it("nobody signed out reads the tables, and another org's office sees none of it", async () => {
    if (!needs()) return;
    for (const t of ["job_stretches", "job_picks", "job_shared_photos"]) {
      expect(await refused(async () => { await asAnon(); await c.query(`select 1 from public.${t} limit 1`); })).toBe("42501");
    }
    if (!otherStaffId) return;
    const seen = await lookAs(
      () => as(otherStaffId),
      async () =>
        (await c.query("select 1 from public.job_stretches where job_id = $1 union all select 1 from public.job_picks where job_id = $1", [jobA])).rows.length,
    );
    expect(seen).toBe(0);
    expect(
      await refused(async () => {
        await as(otherStaffId);
        await c.query("insert into public.job_stretches (job_id, label, starts_on, ends_on) values ($1, 'X', '2001-01-05', '2001-01-05')", [jobA]);
      }),
    ).toBe("42501");
  });

  it("a pick's file must be its own job's, under the office's folder", async () => {
    if (!needs()) return;
    expect(
      await refused(async () => {
        await as(staffId);
        await c.query("insert into public.job_picks (job_id, category, file_path, file_kind) values ($1, 'Tile', $2, 'image')", [jobA, `${orgId}/${jobA}/test-0301-receipt.jpg`]);
      }),
    ).toBe("23514");
    expect(
      await refused(async () => {
        await as(staffId);
        await c.query("insert into public.job_picks (job_id, category, file_path, file_kind) values ($1, 'Tile', $2, 'image')", [jobA, `${orgId}/picks/${jobB}/x.jpg`]);
      }),
    ).toBe("23514");
    expect((await one("select public.docs_path_is_staff_only($1) as s", [`${orgId}/picks/${jobA}/x.jpg`])).s).toBe(true);
    expect((await one("select public.docs_path_is_staff_only($1) as s", [`${orgId}/${jobA}/x.jpg`])).s).toBe(false);
  });

  it("only the service role can run the door or the document projection", async () => {
    if (!needs()) return;
    for (const who of [() => as(techId), () => as(staffId), () => asAnon()]) {
      expect(await refused(async () => { await who(); await c.query("select public.portal_job_view($1, $2)", [tokenA, jobA]); })).toBe("42501");
      expect(await refused(async () => { await who(); await c.query("select public.invoice_document_projection($1)", [invA]); })).toBe("42501");
    }
  });

  it("the customer's job: an allowlist of building blocks, their paper only, their photos only", async () => {
    if (!needs()) return;
    const v = await view(tokenA, jobA);
    expect(Object.keys(v).sort()).toEqual(VIEW_KEYS);
    expect(v.scope).toEqual({ org_id: orgId, job_id: jobA, customer_id: custA });
    expect(Object.keys(v.job).sort()).toEqual(["address", "city", "id", "job_number", "name", "state", "status", "unit", "zip"]);

    // Their bill only: not the void one, not the one billed to someone else. A draft has no pay door.
    expect(v.invoices.map((i: any) => i.invoice_number)).toEqual(["TEST-0301-1"]);
    expect(v.invoices[0].public_token).toBeNull();
    expect(Object.keys(v.invoices[0].doc).sort()).toEqual(DOC_KEYS);

    // A labor line gives who and the clock, nothing else; a material line gives its dates only.
    const labor = v.lines.find((l: any) => l.import_source === "labor");
    expect(labor.entries).toHaveLength(2);
    for (const e of labor.entries) expect(Object.keys(e).sort()).toEqual(["clock_in", "clock_out", "lunch_minutes", "person"]);
    const wire = v.lines.find((l: any) => l.import_source === "costs");
    expect(wire.sources).toEqual([{ date: "2001-01-02", at: expect.any(String) }]);

    expect(v.picks.map((p: any) => p.name)).toEqual(["Swiss Coffee"]);
    expect(v.photos.map((p: any) => p.id)).toEqual([photoShared]);

    const text = JSON.stringify(v);
    for (const secret of ["SECRET", "SOMEONE ELSES LINE", "VOIDED LINE", "TEST 0301 B", "test-0301-receipt", "test-0301-other", "gps", "buy_price", "hourly_rate", "bill_rate", "rate_override", "recorded_by", "stripe"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("the stretches built from those rows reconcile to the bill, in the org's days", async () => {
    if (!needs()) return;
    const v = await view(tokenA, jobA);
    const ledger = buildJobLedger({ stretches: v.stretches, invoices: v.invoices, lines: v.lines, payments: v.payments, tz: v.org.timezone || "America/Los_Angeles" });
    expect(ledger.reconciles).toBe(true);
    expect(ledger.stretches.map((s) => [s.label, s.workTotal, s.paidTotal, s.balanceAfter])).toEqual([
      ["Rough-in", 100, 0, 100],
      ["Trim", 150, 100, 150],
    ]);
  });

  it("a photo whose document was repointed stops showing instead of showing the new file", async () => {
    if (!needs()) return;
    await c.query("savepoint repoint");
    await c.query("update public.documents set file_url = $1 where id = $2", [`${orgId}/${jobA}/test-0301-receipt.jpg`, photoShared]);
    const v = await view(tokenA, jobA);
    await c.query("rollback to savepoint repoint");
    expect(v.photos).toEqual([]);
  });

  it("the door opens nothing else: another customer's job, a job not shown to customers, another link", async () => {
    if (!needs()) return;
    expect(await view(tokenA, jobB)).toBeNull();
    expect(await view(tokenA, jobEstimate)).toBeNull();
    expect(await view(tokenB, jobA)).toBeNull();
    expect(await view("0".repeat(32), jobA)).toBeNull();
    expect(await view("short", jobA)).toBeNull();
  });

  it("a turned-off or replaced link says so with the business name, and nothing else", async () => {
    if (!needs()) return;
    await c.query("savepoint off");
    await as(staffId);
    await c.query("select public.portal_link_set_enabled($1, false)", [custA]);
    await asServer();
    const off = await view(tokenA, jobA);
    expect(Object.keys(off).sort()).toEqual(["disabled", "org"]);
    expect(off.org).toEqual({ name: orgName });
    await as(staffId);
    const fresh = (await one("select public.portal_link_rotate($1) as t", [custA])).t as string;
    await asServer();
    const old = await view(tokenA, jobA);
    const now = await view(fresh, jobA);
    await c.query("rollback to savepoint off");
    expect(old).toEqual({ disabled: true, org: { name: orgName } });
    expect(now.scope.job_id).toBe(jobA);
  });

  it("the portal's job list links to the job by id, and still hides a job customers aren't shown", async () => {
    if (!needs()) return;
    const p = (await one("select public.customer_portal($1) as j", [tokenA])).j;
    const ids = p.jobs.map((j: any) => j.id);
    expect(ids).toContain(jobA);
    expect(ids).not.toContain(jobEstimate);
    expect(Object.keys(p.jobs[0]).sort()).toEqual(["id", "job_number", "name", "status"]);
  });

  it("/i and the portal hand over the same document; /i still opens only a sent bill", async () => {
    if (!needs()) return;
    await c.query("savepoint sent");
    await c.query("update public.invoices set status = 'sent', public_token = repeat('d', 32) where id = $1", [invA]);
    const viaI = (await one("select public.public_invoice(repeat('d', 32))::text as t")).t;
    const viaPortal = (await one("select public.invoice_document_projection($1)::text as t", [invA])).t;
    const v = await view(tokenA, jobA);
    await c.query("rollback to savepoint sent");
    expect(viaI).toBe(viaPortal);
    expect(v.invoices[0].public_token).toBe("d".repeat(32));
    expect((await one("select public.public_invoice(public_token) as j from public.invoices where id = $1", [invA])).j).toBeNull();
  });
});
