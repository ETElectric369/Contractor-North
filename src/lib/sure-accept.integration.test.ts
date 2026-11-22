import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { sureCustomerMatch, type DupCustomer } from "@/lib/crm/duplicates";
import { usualBillingKind } from "@/lib/schedule-options";

/**
 * WHO SAID YES (0413; cn-v1176), proven on the database it lives on, inside ONE transaction that is
 * always rolled back. A customer taps Accept on an estimate written for a lead before anybody was a
 * customer (fragment first), and accept_public_quote decides who the customer is:
 *
 *   the match     the SQL twin of sureCustomerMatch (src/lib/crm/duplicates.ts) with the lead's own
 *                 customer first, as the office's door customerForInquiry has it: a phone or an
 *                 e-mail is one person; a name only when it is the one such name in the company, not a
 *                 placeholder, and nothing on file contradicts it; otherwise a NEW customer. Each case
 *                 is asked of the database AND of the app's matcher over the same book, and the two
 *                 answers must be one;
 *   who said yes  the accepted row says customer_link and names nobody, even when the office had
 *                 marked it accepted and walked it back; the two checks refuse what they forbid;
 *   the job       is born with the company's usual billing kind (usualBillingKind's arithmetic), in
 *                 both directions, and time and material for a company with no jobs;
 *   twice         a second tap answers ok and writes nothing.
 *
 * 0413 is applied here ONLY when it is not on the database yet. The owner applies it on the test
 * database before the deploy, so on CI that branch is not taken; on a database without it the file
 * runs TWICE (a first run, then the second run it promises is safe).
 *
 * Every company here is a TEST company minted inside the transaction (throwaway-org.db-fixture.ts),
 * one per case, so no case's book is another's. No person and no street here is anybody's. Never run
 * outside CI by hand; it skips without the test database's credentials.
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run --project db src/lib/sure-accept.integration.test.ts
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const M0413 = fileURLToPath(new URL("../../supabase/migrations/0413_who_said_yes.sql", import.meta.url));

const OLD = "2026-01-01T00:00:00.000Z";
const NEW = "2026-06-01T00:00:00.000Z";
const NBSP = String.fromCharCode(160);

/** A customer already in the book, by the key the case calls it. */
type BookRow = { key: string; name: string; phone?: string | null; email?: string | null; created_at: string };
/** The lead the estimate was written for; customer is the key of a book row it is already tied to. */
type LeadIn = { name: string; phone?: string | null; email?: string | null; customer?: string | null };
type Case = { why: string; book: BookRow[]; lead: LeadIn; want: string | null };

/** The cases (want: the key of the customer taken, or null for a NEW customer). */
const CASES: Case[] = [
  {
    why: "a same-name stranger with another phone gives a NEW customer",
    book: [{ key: "stranger", name: "Sam Tillery", phone: "530-555-0101", created_at: OLD }],
    lead: { name: "Sam Tillery", phone: "(530) 555-0199" },
    want: null,
  },
  {
    why: "a phone match under another spelling is taken",
    book: [{ key: "dana", name: "Dana Rook", phone: "(530) 555-0102", created_at: OLD }],
    lead: { name: "Dana R.", phone: "+1 530.555.0102" },
    want: "dana",
  },
  {
    why: "a phone on a younger record wins over an older stranger of the same name",
    book: [
      { key: "older", name: "Theo Vance", phone: "530-555-0103", created_at: OLD },
      { key: "younger", name: "Theo Vance", phone: "530-555-0104", created_at: NEW },
    ],
    lead: { name: "Theo Vance", phone: "5305550104" },
    want: "younger",
  },
  {
    why: "an e-mail match is taken, case and plain spaces aside",
    book: [{ key: "casey", name: "Casey Loam", email: "casey.loam@example.test", created_at: OLD }],
    lead: { name: "C. Loam", email: "  Casey.Loam@Example.TEST " },
    want: "casey",
  },
  {
    why: "the only such name, with nothing on file to contradict it, is taken",
    book: [{ key: "dana", name: "Dana Rook", created_at: OLD }],
    lead: { name: "dana  rook", phone: "530-555-0105", email: "dana@example.test" },
    want: "dana",
  },
  {
    why: "two of the same name give a NEW customer",
    book: [
      { key: "first", name: "Sam Tillery", created_at: OLD },
      { key: "second", name: "Sam Tillery", created_at: NEW },
    ],
    lead: { name: "Sam Tillery" },
    want: null,
  },
  {
    why: "an e-mail on file that contradicts the lead's gives a NEW customer",
    book: [{ key: "casey", name: "Casey Loam", email: "casey@example.test", created_at: OLD }],
    lead: { name: "Casey Loam", email: "other.casey@example.test" },
    want: null,
  },
  {
    why: "Unknown caller is a placeholder, never a name: a NEW customer",
    book: [{ key: "placeholder", name: "Unknown caller", created_at: OLD }],
    lead: { name: "Unknown Caller" },
    want: null,
  },
  {
    why: "a name of digits alone is a placeholder: a NEW customer",
    book: [{ key: "digits", name: "530-555-0111", created_at: OLD }],
    lead: { name: "530 555 0111" },
    want: null,
  },
  {
    why: "a lead already tied to a customer keeps it, even when its phone is another record's",
    book: [
      { key: "casey", name: "Casey Loam", created_at: OLD },
      { key: "dana", name: "Dana Rook", phone: "530-555-0106", created_at: OLD },
    ],
    lead: { name: "Casey Loam", phone: "530-555-0106", customer: "casey" },
    want: "casey",
  },
];

d("0413: the customer's own Accept finds the right customer, and says who said yes", () => {
  let c: pg.Client;
  const tag = randomUUID().slice(0, 8);

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  /** Someone holding a link and nothing else: the anon key, no session. */
  const asAnon = async () => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
    await c.query("set local role anon");
  };
  /** The server: no claims, the pooler's own role. */
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  /** The customer taps Accept on their link, and what it did is KEPT for the server to read. */
  const tap = async (token: string): Promise<{ ok: boolean; error?: string }> => {
    await c.query("savepoint the_link");
    try {
      await asAnon();
      const row = await one("select public.accept_public_quote($1)::text as answer", [token]);
      await asServer();
      await c.query("release savepoint the_link");
      return JSON.parse(String(row.answer));
    } catch (e) {
      await c.query("rollback to savepoint the_link");
      await asServer();
      throw e;
    }
  };
  /** The SQLSTATE a statement is refused with, as the server, or null when it went through (then undone). */
  const refused = async (sql: string, params: unknown[] = []): Promise<string | null> => {
    await c.query("savepoint attempt");
    try {
      await c.query(sql, params);
      return null;
    } catch (e) {
      return String((e as { code?: string }).code ?? e);
    } finally {
      await c.query("rollback to savepoint attempt");
    }
  };

  /** A company of its own, with an owner. */
  const company = async (label: string) => {
    const org = await mintThrowawayOrg(c, { label: `0413 ${label}`, techs: 0 });
    return { orgId: org.orgId, ownerId: org.owner.id };
  };
  const addCustomer = async (orgId: string, ownerId: string, r: BookRow): Promise<string> => {
    const id = randomUUID();
    const res = await c.query(
      `insert into public.customers (id, org_id, name, type, status, phone, email, created_at, created_by)
       values ($1, $2, $3, 'residential'::customer_type, 'active'::customer_status, $4, $5, $6::timestamptz, $7)`,
      [id, orgId, r.name, r.phone ?? null, r.email ?? null, r.created_at, ownerId],
    );
    expect(res.rowCount).toBe(1);
    return id;
  };
  const addLead = async (orgId: string, l: LeadIn, customerId: string | null): Promise<string> => {
    const id = randomUUID();
    const res = await c.query(
      `insert into public.inquiries (id, org_id, name, status, phone, email, customer_id) values ($1, $2, $3, 'new', $4, $5, $6)`,
      [id, orgId, l.name, l.phone ?? null, l.email ?? null, customerId],
    );
    expect(res.rowCount).toBe(1);
    return id;
  };
  /** An estimate sent for the lead, with no customer yet. */
  const addEstimate = async (orgId: string, ownerId: string, leadId: string | null, o: { customerId?: string | null; how?: string | null; by?: string | null } = {}) => {
    const id = randomUUID();
    const token = `test-0413-${tag}-${randomUUID()}`;
    const res = await c.query(
      `insert into public.quotes (id, org_id, inquiry_id, customer_id, title, status, public_token, accepted_how, accepted_by, created_by)
       values ($1, $2, $3, $4, $5, 'sent'::quote_status, $6, $7, $8, $9)`,
      [id, orgId, leadId, o.customerId ?? null, `TEST 0413 estimate ${tag}`, token, o.how ?? null, o.by ?? null, ownerId],
    );
    expect(res.rowCount).toBe(1);
    return { id, token };
  };
  type After = {
    status: string;
    customer_id: string | null;
    accepted_how: string | null;
    accepted_by: string | null;
    accepted: boolean;
    job_id: string | null;
    job_customer: string | null;
    billing_type: string | null;
    lead_customer: string | null;
    lead_status: string | null;
  };
  const after = async (quoteId: string): Promise<After> =>
    (await one(
      `select q.status::text as status, q.customer_id::text as customer_id, q.accepted_how, q.accepted_by::text as accepted_by,
              (q.accepted_at is not null) as accepted, q.job_id::text as job_id, j.customer_id::text as job_customer, j.billing_type,
              i.customer_id::text as lead_customer, i.status as lead_status
         from public.quotes q
         left join public.jobs j on j.id = q.job_id
         left join public.inquiries i on i.id = q.inquiry_id
        where q.id = $1`,
      [quoteId],
    )) as After;
  const customersIn = async (orgId: string) => (await one("select count(*)::int as n from public.customers where org_id = $1", [orgId])).n as number;

  beforeAll(async () => {
    c = new pg.Client({
      host: TEST_DB_HOST,
      port: 5432,
      user: TEST_DB_USER,
      password: TEST_DBPW,
      database: "postgres",
      ssl: { rejectUnauthorized: false },
    });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    // Is 0413 here? By what it left (the column and the sure match), never by a ledger this suite cannot see.
    const carried = await one(
      `select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'quotes' and column_name = 'accepted_how') as column_there,
              position('having count(*) = 1' in (select p.prosrc from pg_proc p where p.oid = 'public.accept_public_quote(text)'::regprocedure)) > 0 as match_there`,
    );
    if (carried.column_there !== true || carried.match_there !== true) {
      const sql = readFileSync(M0413, "utf8");
      await c.query(sql); // a first run: the ground check, the columns and checks, the function, the self-check
      await c.query(sql); // and the second run the file says is safe
      console.warn("[sure-accept] 0413 was applied inside this suite's transaction (twice: it is twice-safe) and is rolled back with it.");
    }
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("the door is granted and made as it was: the link and a signed-in person may call it, it runs as its owner", async () => {
    const p = await one(
      `select has_function_privilege('anon', 'public.accept_public_quote(text)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.accept_public_quote(text)', 'execute') as authed,
              (select p.prosecdef from pg_proc p where p.oid = 'public.accept_public_quote(text)'::regprocedure) as definer,
              (select count(*)::int from pg_proc p where p.proname = 'accept_public_quote' and p.pronamespace = 'public'::regnamespace) as made`,
    );
    expect(p).toEqual({ anon: true, authed: true, definer: true, made: 1 });
  });

  for (const k of CASES) {
    it(`the match: ${k.why}`, async () => {
      const { orgId, ownerId } = await company(k.why.slice(0, 40));
      const ids = new Map<string, string>();
      for (const r of k.book) ids.set(r.key, await addCustomer(orgId, ownerId, r));
      const leadCustomer = k.lead.customer ? ids.get(k.lead.customer)! : null;
      const leadId = await addLead(orgId, k.lead, leadCustomer);
      const quote = await addEstimate(orgId, ownerId, leadId);
      const before = await customersIn(orgId);

      expect(await tap(quote.token)).toEqual({ ok: true });
      const now = await after(quote.id);
      expect(now.status).toBe("accepted");
      expect(now.customer_id).not.toBeNull();
      // The estimate, its lead and its job carry the same customer; the lead is won.
      expect({ lead: now.lead_customer, job: now.job_customer }).toEqual({ lead: now.customer_id, job: now.customer_id });
      expect(now.lead_status).toBe("won");

      const taken = [...ids.entries()].find(([, id]) => id === now.customer_id)?.[0] ?? null;
      expect({ why: k.why, taken }).toEqual({ why: k.why, taken: k.want });
      if (k.want === null) {
        // A NEW customer, in this company, made from the lead.
        expect(await customersIn(orgId)).toBe(before + 1);
        const made = await one("select org_id::text as org_id, name from public.customers where id = $1", [now.customer_id]);
        expect(made).toEqual({ org_id: orgId, name: k.lead.name });
      } else {
        expect(await customersIn(orgId)).toBe(before);
      }

      // THE APP'S OWN ANSWER over the same book (customerForInquiry: the lead's customer, else
      // sureCustomerMatch) is the database's.
      const book: DupCustomer[] = k.book.map((r) => ({ id: ids.get(r.key)!, name: r.name, company_name: null, phone: r.phone ?? null, email: r.email ?? null, created_at: r.created_at }));
      const app = leadCustomer ?? sureCustomerMatch({ name: k.lead.name, phone: k.lead.phone ?? null, email: k.lead.email ?? null }, book)?.id ?? null;
      expect({ why: k.why, app: app ? [...ids.entries()].find(([, id]) => id === app)![0] : null }).toEqual({ why: k.why, app: k.want });
    });
  }

  it("the match reads one company: another company's customer with the same phone, e-mail and name is never taken", async () => {
    const theirs = await company("another company");
    const strangerId = await addCustomer(theirs.orgId, theirs.ownerId, { key: "x", name: "Dana Rook", phone: "530-555-0120", email: "dana.rook@example.test", created_at: OLD });
    const ours = await company("this company");
    const leadId = await addLead(ours.orgId, { name: "Dana Rook", phone: "530-555-0120", email: "dana.rook@example.test" }, null);
    const quote = await addEstimate(ours.orgId, ours.ownerId, leadId);
    expect(await tap(quote.token)).toEqual({ ok: true });
    const now = await after(quote.id);
    expect(now.customer_id).not.toBe(strangerId);
    expect((await one("select org_id::text as org_id from public.customers where id = $1", [now.customer_id])).org_id).toBe(ours.orgId);
    // A lead tied to another company's customer does not hand that customer over either.
    const tiedElsewhere = await addLead(ours.orgId, { name: "Theo Vance" }, strangerId);
    const q2 = await addEstimate(ours.orgId, ours.ownerId, tiedElsewhere);
    expect(await tap(q2.token)).toEqual({ ok: true });
    const n2 = await after(q2.id);
    expect(n2.customer_id).not.toBe(strangerId);
    expect((await one("select org_id::text as org_id from public.customers where id = $1", [n2.customer_id])).org_id).toBe(ours.orgId);
  });

  it("a trailing no-break space on the lead's e-mail is the one place the app and the database read it differently (said in 0413's header)", async () => {
    const { orgId, ownerId } = await company("no-break space");
    const casey = await addCustomer(orgId, ownerId, { key: "casey", name: "Casey Loam", email: "casey@example.test", created_at: OLD });
    const leadId = await addLead(orgId, { name: "Casey Loam", email: `casey@example.test${NBSP}` }, null);
    const quote = await addEstimate(orgId, ownerId, leadId);
    expect(await tap(quote.token)).toEqual({ ok: true });
    // The database keeps the no-break space, so the e-mails differ and the name is contradicted: new.
    expect((await after(quote.id)).customer_id).not.toBe(casey);
    // The app's trim() strips it, and takes the record.
    expect(sureCustomerMatch({ name: "Casey Loam", email: `casey@example.test${NBSP}` }, [{ id: casey, name: "Casey Loam", company_name: null, phone: null, email: "casey@example.test" }])?.id).toBe(casey);
  });

  it("who said yes: the customer on their link, named nobody, even after the office's acceptance was walked back", async () => {
    const { orgId, ownerId } = await company("who said yes");
    const dana = await addCustomer(orgId, ownerId, { key: "dana", name: "Dana Rook", created_at: OLD });
    // A fresh one.
    const fresh = await addEstimate(orgId, ownerId, null, { customerId: dana });
    expect(await tap(fresh.token)).toEqual({ ok: true });
    expect(await after(fresh.id)).toMatchObject({ status: "accepted", accepted: true, accepted_how: "customer_link", accepted_by: null });
    // One the office marked accepted (in person, by its owner) and walked back to sent: the columns
    // were left as they were, which the check allows; the customer's tap must still go through.
    const walked = await addEstimate(orgId, ownerId, null, { customerId: dana, how: "in_person", by: ownerId });
    expect(await tap(walked.token)).toEqual({ ok: true });
    expect(await after(walked.id)).toMatchObject({ status: "accepted", accepted_how: "customer_link", accepted_by: null });
  });

  it("the two checks refuse what they forbid, and allow what the doors write", async () => {
    const { orgId, ownerId } = await company("the checks");
    const q = await addEstimate(orgId, ownerId, null);
    expect(await refused("update public.quotes set accepted_how = 'customer_link', accepted_by = $2 where id = $1", [q.id, ownerId])).toBe("23514");
    expect(await refused("update public.quotes set accepted_how = 'by_phone' where id = $1", [q.id])).toBe("23514");
    for (const how of ["in_person", "office"]) expect(await refused("update public.quotes set accepted_how = $2, accepted_by = $3 where id = $1", [q.id, how, ownerId])).toBeNull();
    expect(await refused("update public.quotes set accepted_how = 'customer_link', accepted_by = null where id = $1", [q.id])).toBeNull();
    expect(await refused("update public.quotes set accepted_how = null, accepted_by = null where id = $1", [q.id])).toBeNull();
    // The person is a profile: an id that is no profile is refused.
    expect(await refused("update public.quotes set accepted_how = 'office', accepted_by = $2 where id = $1", [q.id, randomUUID()])).toBe("23503");
  });

  it("the job is born with the company's usual billing kind, in both directions, and time and material with no jobs", async () => {
    const shapes: { label: string; tm: number; fixed: number }[] = [
      { label: "mostly fixed", tm: 1, fixed: 2 },
      { label: "mostly time and material", tm: 2, fixed: 1 },
      { label: "a tie", tm: 1, fixed: 1 },
      { label: "no jobs yet", tm: 0, fixed: 0 },
    ];
    for (const s of shapes) {
      const { orgId, ownerId } = await company(`billing ${s.label}`);
      for (const [kind, n] of [["tm", s.tm], ["fixed", s.fixed]] as const) {
        for (let i = 0; i < n; i++) {
          const res = await c.query(`insert into public.jobs (org_id, name, status, billing_type) values ($1, $2, 'to_be_scheduled'::job_status, $3)`, [orgId, `TEST 0413 ${kind} ${i}`, kind]);
          expect(res.rowCount).toBe(1);
        }
      }
      const dana = await addCustomer(orgId, ownerId, { key: "dana", name: "Dana Rook", created_at: OLD });
      const q = await addEstimate(orgId, ownerId, null, { customerId: dana });
      expect(await tap(q.token)).toEqual({ ok: true });
      const now = await after(q.id);
      expect(now.job_id).not.toBeNull();
      expect({ company: s.label, kind: now.billing_type }).toEqual({ company: s.label, kind: usualBillingKind({ tm: s.tm, fixed: s.fixed }) });
    }
  });

  it("a second tap answers ok and changes nothing", async () => {
    const { orgId, ownerId } = await company("a second tap");
    const leadId = await addLead(orgId, { name: "Sam Tillery", phone: "530-555-0130" }, null);
    const q = await addEstimate(orgId, ownerId, leadId);
    expect(await tap(q.token)).toEqual({ ok: true });
    const rows = async () =>
      one(
        `select (select ctid::text from public.quotes where id = $1) as quote,
                (select ctid::text from public.inquiries where id = $2) as lead,
                (select count(*)::int from public.customers where org_id = $3) as customers,
                (select count(*)::int from public.jobs where org_id = $3) as jobs`,
        [q.id, leadId, orgId],
      );
    const first = await rows();
    expect(first.customers).toBe(1);
    expect(first.jobs).toBe(1);
    expect(await tap(q.token)).toEqual({ ok: true });
    expect(await rows()).toEqual(first);
    // And a token no estimate has is answered as it always was.
    expect(await tap(`test-0413-${tag}-nobody`)).toEqual({ ok: false, error: "Quote not found." });
  });
});
