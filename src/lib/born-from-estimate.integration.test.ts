import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { jobTakesScope, scopeForJob } from "@/lib/estimate/job-scope";
import { jobNameFrom } from "@/lib/job-name";
import { bornFromEstimateCandidates } from "@/lib/quote-site";
import { pickSite, type SiteParts } from "@/lib/site-address";

/**
 * BORN FROM AN ESTIMATE (0409; cn-v1160. The owner, 2026-11-10: "the scope remains empty when that can
 * be filled from the estimate description all the way through we already have the information
 * right?"), proven on the database it lives on, inside ONE transaction that is always rolled back:
 *
 *   the rule      what the database calls blank is what the app calls blank. One table of strings is
 *                 asked of the database, as the migration spells the trim, and of scopeForJob and
 *                 jobTakesScope (src/lib/estimate/job-scope.ts): a space, a tab, a line feed and a
 *                 carriage return go from the ends, and a no-break space does NOT;
 *   the door      a customer taps Accept (accept_public_quote). The job it makes is born with the
 *                 estimate's trimmed description as its Description, and with none when the estimate
 *                 has none; a job that was ALREADY there (the estimate was on it, or it is the job of
 *                 the estimate this one revises) takes it only where its own Description is empty, and
 *                 words a person typed stay exactly as typed; where the job is born, and what it is
 *                 called, are what they were before 0409;
 *   the bill      public.invoice_document_projection's site list is the app's own list (lib/quote-site
 *                 bornFromEstimateCandidates) less its last entry, the customer, which the projection
 *                 carries beside the list: the job, then the address of the estimate the bill was made
 *                 from, then that estimate's lead's. A record that is not there is a null in its place;
 *                 another company's estimate, lead or job is never read; the customer's link reads the
 *                 list through public_invoice and nobody outside the database calls the projection;
 *   the backfill  the migration's own block, cut out of the file and run on rows made here: an empty
 *                 job takes its EARLIEST accepted estimate's words, a job with words is not written at
 *                 all, an estimate that was only sent, has no words, was superseded or is another
 *                 company's fills nothing, every job it fills is stamped as changed (and no other),
 *                 and a second run writes no row.
 *
 * 0409 is applied here ONLY when it is not on the database yet. The owner applies it on the test
 * database before the deploy, so on CI that branch is not taken and the suite reads the functions as
 * they are deployed; on a database without it the file runs TWICE (a first run, then the second run it
 * promises is safe).
 *
 * Two TEST companies and everything under them are minted inside the transaction
 * (throwaway-org.db-fixture.ts); every row is this suite's own and none outlives it. No person and no
 * street here is anybody's. Never run outside CI by hand; it skips without the test database's
 * credentials.
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run --project db src/lib/born-from-estimate.integration.test.ts
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const M0409 = fileURLToPath(new URL("../../supabase/migrations/0409_born_from_an_estimate.sql", import.meta.url));

/** The characters the rule is about, spelled by number so that no editor and no tool can swap one for
 *  another, or read an escape into this file. */
const BS = String.fromCharCode(92);
const TAB = String.fromCharCode(9);
const LF = String.fromCharCode(10);
const VT = String.fromCharCode(11);
const FF = String.fromCharCode(12);
const CR = String.fromCharCode(13);
const NBSP = String.fromCharCode(160);
/** The four blank characters as migration 0409 spells them in SQL: E, a quote, a space, backslash-t,
 *  backslash-n, backslash-r, a quote. */
const BLANK = `E' ${BS}t${BS}n${BS}r'`;

// ── The descriptions the rule is asked about ────────────────────────────────────────────────────
const SCOPE = "Replace the main panel";
/** AN ESTIMATE'S DESCRIPTION, and what a job takes from it. `want` is said in full, so the app and the
 *  database cannot agree on a wrong answer together. */
const WORDS: { why: string; given: string | null; want: string | null }[] = [
  { why: "words are taken as they are", given: SCOPE, want: SCOPE },
  { why: "spaces before the words go", given: `   ${SCOPE}`, want: SCOPE },
  { why: "spaces after the words go", given: `${SCOPE}  `, want: SCOPE },
  { why: "a tab at each end goes", given: `${TAB}${SCOPE}${TAB}`, want: SCOPE },
  { why: "a line feed at each end goes", given: `${LF}${SCOPE}${LF}${LF}`, want: SCOPE },
  { why: "a carriage return at each end goes", given: `${CR}${SCOPE}${CR}`, want: SCOPE },
  { why: "the line ending a pasted paragraph leaves (a carriage return, then a line feed) goes", given: `${SCOPE}${CR}${LF}`, want: SCOPE },
  { why: "all four at both ends, mixed, go", given: `${TAB}${CR}${LF} ${SCOPE} ${LF}${CR}${TAB}`, want: SCOPE },
  {
    why: "what is blank between the words stays",
    given: ` Replace the main panel.${LF}${LF}${TAB}Patch  the drywall.${CR}${LF}`,
    want: `Replace the main panel.${LF}${LF}${TAB}Patch  the drywall.`,
  },
  { why: "a no-break space is NOT blank: it stays, and so does the space inside it", given: ` ${NBSP} ${SCOPE} ${NBSP} `, want: `${NBSP} ${SCOPE} ${NBSP}` },
  { why: "a no-break space alone is words", given: NBSP, want: NBSP },
  { why: "a vertical tab and a form feed are not blank either", given: `${VT}${SCOPE}${FF}`, want: `${VT}${SCOPE}${FF}` },
  { why: "only blank space is no scope", given: ` ${TAB}${CR}${LF} `, want: null },
  { why: "an empty description is no scope", given: "", want: null },
  { why: "no description is no scope", given: null, want: null },
];

const TYPED = "Call before arriving";
/** A JOB'S OWN DESCRIPTION, and whether an estimate accepted onto that job may fill it. */
const HAS: { why: string; has: string | null; takes: boolean }[] = [
  { why: "a job with no Description takes the scope", has: null, takes: true },
  { why: "an empty Description takes it", has: "", takes: true },
  { why: "a Description of blank space takes it", has: ` ${TAB}${CR}${LF}`, takes: true },
  { why: "words a person typed are left", has: TYPED, takes: false },
  { why: "typed words are left as typed, the blank space at their ends and all", has: `  ${TYPED}${LF}`, takes: false },
  { why: "a no-break space is something a person left: it stays", has: NBSP, takes: false },
];

// ── The places (nobody's: the suite's own stand-ins) ────────────────────────────────────────────
/** A record's five address columns, every one named, as the database holds them. */
type Site = { address: string | null; unit: string | null; city: string | null; state: string | null; zip: string | null };
const at = (address: string, unit: string | null = null): Site => ({ address, unit, city: "Thistlewood", state: "CA", zip: "96100" });
const NOWHERE: Site = { address: null, unit: null, city: null, state: null, zip: null };
const LARKSPUR = at("14 TEST Larkspur Way"); // where a job is
const SNOWBELL = at("9 TEST Snowbell Ct", "4B"); // an estimate's own job site
const BAYBERRY = at("31 TEST Bayberry Ln"); // where a lead said the work is
const HOME = at("70 TEST Thistlewood Rd", "2"); // the customer's own address
const DANA = "TEST Dana Rook";
const SAM = "TEST Sam Tillery";

/** A day long before this run, for a row that must be seen to keep its stamp. */
const LONG_AGO = "2026-01-01T00:00:00.000Z";

type CustomerRow = Site & { id: string; org_id: string; name: string; created_by: string };
type LeadRow = Site & { id: string; org_id: string; name: string };
type JobRow = Site & { id: string; org_id: string; customer_id: string | null; name: string; status: string; description: string | null; updated_at: string | null };
type QuoteRow = Site & {
  id: string;
  org_id: string;
  customer_id: string | null;
  inquiry_id: string | null;
  job_id: string | null;
  title: string | null;
  description: string | null;
  status: string;
  public_token: string;
  revises_quote_id: string | null;
  accepted_at: string | null;
  created_at: string | null;
  created_by: string;
};
type InvoiceRow = { id: string; org_id: string; customer_id: string | null; job_id: string | null; quote_id: string | null; invoice_number: string; status: string; public_token: string };

/** One entry of the projection's site list: a record with its five columns, or null when the invoice
 *  has no such record (json_build_array keeps a sub-select with no row as a literal null). */
type Candidate = { source: string; parts: Site } | null;
/** What public.invoice_document_projection answers, as far as this suite reads it. */
type Doc = {
  invoice: Record<string, unknown>;
  items: unknown[];
  payments: unknown[];
  customer: (Site & { name: string; company_name: string | null }) | null;
  site_candidates: Candidate[];
  org: Record<string, unknown> | null;
};
/** The records the app's list is built from: what each of them holds in its five columns. */
type Records = Parameters<typeof bornFromEstimateCandidates>[0];

/** THE APP'S LIST FOR THE SAME RECORDS, AS THE PROJECTION CARRIES IT: less its last entry (the
 *  customer, which the projection hands over beside the list, under its own key), and with a record
 *  that is not there as the null json_build_array leaves in its place. */
const appList = (of: Records) =>
  bornFromEstimateCandidates(of)
    .slice(0, -1)
    .map((c) => (c.parts ? c : null));
/** What a reader does with a document (lib/doc-place projectionPlace, the page's own pickSite): the
 *  list in order, then the customer. */
const readerPick = (doc: Doc) => pickSite([...doc.site_candidates, { source: "customer", parts: doc.customer }] as { source: string; parts?: SiteParts | null }[]);
const five = (row: Site | null | undefined): Site | null => (row ? { address: row.address, unit: row.unit, city: row.city, state: row.state, zip: row.zip } : null);

d("0409: born from an estimate", () => {
  let c: pg.Client;
  let orgId = "";
  let ownerId = "";
  let otherOrgId = "";
  let otherOwnerId = "";
  let danaId = "";
  let seq = 0;
  const tag = randomUUID().slice(0, 8);

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  /** PostgREST's own mechanism: the person's claims under the authenticated role. */
  const as = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  /** Someone holding a link and nothing else: the anon key, no session. */
  const asAnon = async () => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
    await c.query("set local role anon");
  };
  /** The server: no claims, the pooler's own role (the functions' owner; RLS does not bind it). */
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  /** The SQLSTATE a statement is refused with, or null when it went through (then undone). */
  const refused = async (who: "anon" | { uid: string }, sql: string, params: unknown[] = []): Promise<string | null> => {
    await c.query("savepoint attempt");
    try {
      if (who === "anon") await asAnon();
      else await as(who.uid);
      await c.query(sql, params);
      return null;
    } catch (e) {
      return String((e as { code?: string }).code ?? e);
    } finally {
      await c.query("rollback to savepoint attempt");
      await asServer();
    }
  };
  /** Run as somebody holding a link and nothing else, and KEEP what it did (the server reads it after). */
  const throughTheLink = async <T>(fn: () => Promise<T>): Promise<T> => {
    await c.query("savepoint the_link");
    try {
      await asAnon();
      const out = await fn();
      await asServer();
      await c.query("release savepoint the_link");
      return out;
    } catch (e) {
      await c.query("rollback to savepoint the_link");
      await asServer();
      throw e;
    }
  };

  // ── The rows: every id is minted here, so a case knows its rows before it writes them ──────────
  const customerRow = (o: Partial<CustomerRow> = {}): CustomerRow => ({ id: randomUUID(), org_id: orgId, name: DANA, created_by: ownerId, ...NOWHERE, ...o });
  const leadRow = (o: Partial<LeadRow> = {}): LeadRow => ({ id: randomUUID(), org_id: orgId, name: SAM, ...NOWHERE, ...o });
  const jobRow = (o: Partial<JobRow> = {}): JobRow => ({
    id: randomUUID(),
    org_id: orgId,
    customer_id: null,
    name: `TEST 0409 job ${++seq}`,
    status: "to_be_scheduled",
    description: null,
    updated_at: null,
    ...NOWHERE,
    ...o,
  });
  const quoteRow = (o: Partial<QuoteRow> = {}): QuoteRow => ({
    id: randomUUID(),
    org_id: orgId,
    customer_id: null,
    inquiry_id: null,
    job_id: null,
    title: `TEST 0409 estimate ${++seq}`,
    description: null,
    status: "sent",
    public_token: `test-0409-${randomUUID()}`,
    revises_quote_id: null,
    accepted_at: null,
    created_at: null,
    created_by: ownerId,
    ...NOWHERE,
    ...o,
  });
  const invoiceRow = (o: Partial<InvoiceRow> = {}): InvoiceRow => ({
    id: randomUUID(),
    org_id: orgId,
    customer_id: null,
    job_id: null,
    quote_id: null,
    invoice_number: `TEST-0409-${tag}-${++seq}`,
    status: "sent",
    public_token: `test-0409-bill-${randomUUID()}`,
    ...o,
  });

  /** One statement for a whole list of rows. Read back, never assumed (the silent-write law): every
   *  row asked for was written. */
  const write = async (sql: string, rows: unknown[]) => {
    const res = await c.query(sql, [JSON.stringify(rows)]);
    expect(res.rowCount).toBe(rows.length);
  };
  const insertCustomers = (rows: CustomerRow[]) =>
    write(
      `insert into public.customers (id, org_id, name, type, status, address, unit, city, state, zip, created_by)
       select r.id, r.org_id, r.name, 'residential'::customer_type, 'active'::customer_status, r.address, r.unit, r.city, r.state, r.zip, r.created_by
         from jsonb_to_recordset($1::jsonb) as r(id uuid, org_id uuid, name text, address text, unit text, city text, state text, zip text, created_by uuid)`,
      rows,
    );
  const insertLeads = (rows: LeadRow[]) =>
    write(
      `insert into public.inquiries (id, org_id, name, status, address, unit, city, state, zip)
       select r.id, r.org_id, r.name, 'new', r.address, r.unit, r.city, r.state, r.zip
         from jsonb_to_recordset($1::jsonb) as r(id uuid, org_id uuid, name text, address text, unit text, city text, state text, zip text)`,
      rows,
    );
  const insertJobs = (rows: JobRow[]) =>
    write(
      `insert into public.jobs (id, org_id, customer_id, name, status, description, address, unit, city, state, zip, updated_at)
       select r.id, r.org_id, r.customer_id, r.name, r.status::job_status, r.description, r.address, r.unit, r.city, r.state, r.zip, coalesce(r.updated_at, now())
         from jsonb_to_recordset($1::jsonb)
              as r(id uuid, org_id uuid, customer_id uuid, name text, status text, description text,
                   address text, unit text, city text, state text, zip text, updated_at timestamptz)`,
      rows,
    );
  const insertQuotes = (rows: QuoteRow[]) =>
    write(
      `insert into public.quotes (id, org_id, customer_id, inquiry_id, job_id, title, description, status, public_token,
                                  address, unit, city, state, zip, revises_quote_id, accepted_at, created_at, created_by)
       select r.id, r.org_id, r.customer_id, r.inquiry_id, r.job_id, r.title, r.description, r.status::quote_status, r.public_token,
              r.address, r.unit, r.city, r.state, r.zip, r.revises_quote_id, r.accepted_at, coalesce(r.created_at, now()), r.created_by
         from jsonb_to_recordset($1::jsonb)
              as r(id uuid, org_id uuid, customer_id uuid, inquiry_id uuid, job_id uuid, title text, description text, status text, public_token text,
                   address text, unit text, city text, state text, zip text, revises_quote_id uuid, accepted_at timestamptz, created_at timestamptz, created_by uuid)`,
      rows,
    );
  const insertInvoices = (rows: InvoiceRow[]) =>
    write(
      `insert into public.invoices (id, org_id, customer_id, job_id, quote_id, invoice_number, status, invoice_kind, total, public_token)
       select r.id, r.org_id, r.customer_id, r.job_id, r.quote_id, r.invoice_number, r.status::invoice_status, 'standard', 100, r.public_token
         from jsonb_to_recordset($1::jsonb)
              as r(id uuid, org_id uuid, customer_id uuid, job_id uuid, quote_id uuid, invoice_number text, status text, public_token text)`,
      rows,
    );

  // ── The door and what it left ─────────────────────────────────────────────────────────────────
  type Answer = { ok: boolean; error?: string };
  /** The customer taps Accept on each link: one statement, one call for each token, every answer read. */
  const accept = async (tokens: string[]): Promise<Map<string, Answer>> => {
    const rows = (await c.query("select t.token, public.accept_public_quote(t.token)::text as answer from unnest($1::text[]) as t(token)", [tokens])).rows as {
      token: string;
      answer: string;
    }[];
    expect(rows).toHaveLength(tokens.length);
    return new Map(rows.map((r) => [r.token, JSON.parse(r.answer) as Answer]));
  };
  type Born = Site & {
    quote_id: string;
    quote_status: string;
    stamped: boolean;
    job_id: string | null;
    name: string | null;
    description: string | null;
    job_status: string | null;
    customer_id: string | null;
    inquiry_id: string | null;
    created_by: string | null;
    org_id: string | null;
  };
  /** Each estimate as it stands now, with the job it is on (if it is on one). */
  const jobsOf = async (quoteIds: string[]): Promise<Map<string, Born>> => {
    const rows = (
      await c.query(
        `select q.id::text as quote_id, q.status::text as quote_status, (q.accepted_at is not null) as stamped, q.job_id::text as job_id,
                j.name, j.description, j.status::text as job_status, j.customer_id::text as customer_id, j.inquiry_id::text as inquiry_id,
                j.created_by::text as created_by, j.org_id::text as org_id, j.address, j.unit, j.city, j.state, j.zip
           from public.quotes q
           left join public.jobs j on j.id = q.job_id
          where q.id = any($1::uuid[])`,
        [quoteIds],
      )
    ).rows as Born[];
    expect(rows).toHaveLength(quoteIds.length);
    return new Map(rows.map((r) => [r.quote_id, r]));
  };
  type JobNow = { id: string; at: string; description: string | null; stamped_now: boolean; stamp_kept: boolean };
  /** Each job as it stands now: its Description, WHICH VERSION of the row this is (ctid: any write to
   *  a row makes a new one, so the same ctid is a row nobody wrote), and its stamp. */
  const jobsNow = async (jobIds: string[]): Promise<Map<string, JobNow>> => {
    const rows = (
      await c.query(
        `select j.id::text as id, j.ctid::text as at, j.description, (j.updated_at = now()) as stamped_now, (j.updated_at = $2::timestamptz) as stamp_kept
           from public.jobs j where j.id = any($1::uuid[])`,
        [jobIds, LONG_AGO],
      )
    ).rows as JobNow[];
    expect(rows).toHaveLength(jobIds.length);
    return new Map(rows.map((r) => [r.id, r]));
  };
  const jobCount = async (org = orgId) => (await one("select count(*)::int as n from public.jobs where org_id = $1", [org])).n as number;
  /** What the projection answers for each invoice, read as the server reads it. */
  const docsOf = async (invoiceIds: string[]): Promise<Map<string, Doc>> => {
    const rows = (await c.query("select i.id::text as id, public.invoice_document_projection(i.id)::text as raw from public.invoices i where i.id = any($1::uuid[])", [invoiceIds]))
      .rows as { id: string; raw: string | null }[];
    expect(rows).toHaveLength(invoiceIds.length);
    return new Map(rows.map((r) => [r.id, JSON.parse(String(r.raw)) as Doc]));
  };

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
    // Is 0409 here? By what it left in the two functions, never by a ledger this suite cannot see.
    const carried = await one(
      `select position('scope_for_job' in (select p.prosrc from pg_proc p where p.oid = 'public.accept_public_quote(text)'::regprocedure)) > 0 as scope,
              position($m$'source', 'quote'$m$ in pg_get_functiondef('public.invoice_document_projection(uuid)'::regprocedure)) > 0 as place`,
    );
    if (carried.scope !== true || carried.place !== true) {
      const sql = readFileSync(M0409, "utf8");
      await c.query(sql); // a first run: the ground check, the patch and its proof, the function, the backfill, the self-check
      await c.query(sql); // and the second run the file says is safe
      console.warn("[born-from-estimate] 0409 was applied inside this suite's transaction (twice: it is twice-safe) and is rolled back with it.");
    }

    const org = await mintThrowawayOrg(c, { label: "0409 born from an estimate", techs: 0 });
    orgId = org.orgId;
    ownerId = org.owner.id;
    const other = await mintThrowawayOrg(c, { label: "0409 another company", techs: 0 });
    otherOrgId = other.orgId;
    otherOwnerId = other.owner.id;
    // The customer every estimate here is made out to, at an address of their own.
    const dana = customerRow({ ...HOME });
    await insertCustomers([dana]);
    danaId = dana.id;
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("what the database calls blank is what the app calls blank: a space, a tab, a line feed and a carriage return, and never a no-break space", async () => {
    // The two expressions below are the migration's own, to the character: it is the file that ships.
    const file = readFileSync(M0409, "utf8");
    expect(file).toContain(`scope_for_job := nullif(btrim(q.description, ${BLANK}), '');`);
    expect(file).toContain(`and btrim(coalesce(description, ''), ${BLANK}) = '';`);

    const rows = (
      await c.query(
        `select (e.ord - 1)::int as i,
                nullif(btrim(e.v #>> '{}', ${BLANK}), '') as scope,
                btrim(coalesce(e.v #>> '{}', ''), ${BLANK}) = '' as takes
           from jsonb_array_elements($1::jsonb) with ordinality as e(v, ord)
          order by e.ord`,
        [JSON.stringify(WORDS.map((k) => k.given))],
      )
    ).rows as { i: number; scope: string | null; takes: boolean }[];
    expect(rows.map((r) => r.i)).toEqual(WORDS.map((_, i) => i));
    for (const [i, k] of WORDS.entries()) {
      // The app first, against what is said in full; then the database against the same.
      expect({ why: k.why, app: scopeForJob(k.given) }).toEqual({ why: k.why, app: k.want });
      expect({ why: k.why, sql: rows[i].scope }).toEqual({ why: k.why, sql: k.want });
      // A description that leaves no scope is exactly a Description that counts as empty.
      expect({ why: k.why, app: jobTakesScope(k.given) }).toEqual({ why: k.why, app: k.want === null });
      expect({ why: k.why, sql: rows[i].takes }).toEqual({ why: k.why, sql: k.want === null });
    }
    // The cases this wave named are really in the table, by what they hold.
    const given = WORDS.map((k) => k.given ?? "");
    expect(given.some((g) => g.startsWith(" ") && g.endsWith(SCOPE))).toBe(true); // a leading space
    expect(given.some((g) => g.startsWith(SCOPE) && g.endsWith(" "))).toBe(true); // a trailing space
    for (const ch of [TAB, LF, CR]) expect(given.some((g) => g.startsWith(ch) && g.endsWith(ch))).toBe(true);
    expect(given.some((g) => g.includes(NBSP) && scopeForJob(g)!.startsWith(NBSP) && scopeForJob(g)!.endsWith(NBSP))).toBe(true);
    expect([TAB, LF, VT, FF, CR, NBSP].map((ch) => ch.charCodeAt(0))).toEqual([9, 10, 11, 12, 13, 160]);
  });

  it("a fresh estimate: the job the customer's Accept makes is born with the estimate's trimmed description, and with none when there is none", async () => {
    const before = await jobCount();
    const quotes = WORDS.map((k, i) => quoteRow({ customer_id: danaId, title: `TEST 0409 fresh ${i + 1}`, description: k.given }));
    await insertQuotes(quotes);
    const answers = await accept(quotes.map((q) => q.public_token));
    const born = await jobsOf(quotes.map((q) => q.id));

    for (const [i, k] of WORDS.entries()) {
      const job = born.get(quotes[i].id)!;
      expect({ why: k.why, answer: answers.get(quotes[i].public_token) }).toEqual({ why: k.why, answer: { ok: true } });
      expect({ why: k.why, estimate: job.quote_status, stamped: job.stamped, made: job.job_id !== null }).toEqual({ why: k.why, estimate: "accepted", stamped: true, made: true });
      // THE SCOPE: the app's own answer for the same description, which the first case holds to `want`.
      expect({ why: k.why, description: job.description }).toEqual({ why: k.why, description: scopeForJob(k.given) });
    }
    // An estimate with no words makes a job with NO Description: null, never an empty string.
    for (const [i, k] of WORDS.entries()) if (k.want === null) expect(born.get(quotes[i].id)!.description, k.why).toBeNull();
    // One job each, and no more.
    expect(await jobCount()).toBe(before + WORDS.length);
    expect(new Set([...born.values()].map((j) => j.job_id)).size).toBe(WORDS.length);

    // WHERE IT IS BORN AND WHAT IT IS CALLED are what they were (0369, 0396): the Description took the
    // eleventh place among twelve values, and every other value still sits in its own column. No
    // street on the estimate and no lead, so the job is born at the customer's address, all five
    // parts, and named for that street by the namer both doors share.
    const name = jobNameFrom({ typed: null, sourceWords: quotes[0].title, customer: { name: DANA, company_name: null, type: "residential" }, street: HOME.address, unit: HOME.unit, aliases: [null], todayStr: "2026-11-11" });
    expect(name).toContain(String(HOME.address));
    for (const q of quotes) {
      const job = born.get(q.id)!;
      expect(five(job)).toEqual(HOME);
      expect({ name: job.name, status: job.job_status, customer: job.customer_id, lead: job.inquiry_id, by: job.created_by, org: job.org_id }).toEqual({
        name,
        status: "to_be_scheduled",
        customer: danaId,
        lead: null,
        by: ownerId,
        org: orgId,
      });
    }
  });

  it("an estimate with a job site of its own and a lead: the job is born at the estimate's site, on the lead, with the scope", async () => {
    const sam = leadRow({ ...BAYBERRY });
    await insertLeads([sam]);
    const own = quoteRow({ customer_id: danaId, inquiry_id: sam.id, description: `${SCOPE}${CR}${LF}`, ...SNOWBELL });
    const leads = quoteRow({ customer_id: danaId, inquiry_id: sam.id, description: `${LF}${SCOPE}` });
    await insertQuotes([own, leads]);
    const answers = await accept([own.public_token, leads.public_token]);
    expect([...answers.values()]).toEqual([{ ok: true }, { ok: true }]);
    const born = await jobsOf([own.id, leads.id]);
    // The estimate's own five columns win whole; with none, the lead's (the order 0396 left).
    expect({ site: five(born.get(own.id)), description: born.get(own.id)!.description, lead: born.get(own.id)!.inquiry_id }).toEqual({ site: SNOWBELL, description: SCOPE, lead: sam.id });
    expect({ site: five(born.get(leads.id)), description: born.get(leads.id)!.description, lead: born.get(leads.id)!.inquiry_id }).toEqual({ site: BAYBERRY, description: SCOPE, lead: sam.id });
  });

  it("an estimate accepted onto a job that was already there: an empty Description is filled, typed words are not written at all, and no job is made", async () => {
    const jobs = HAS.map((k) => jobRow({ customer_id: danaId, description: k.has }));
    await insertJobs(jobs);
    // Each estimate is ALREADY on its job when the customer taps Accept, and carries the scope with
    // blank space at its ends: what lands is the trimmed words.
    const quotes = jobs.map((j, i) => quoteRow({ customer_id: danaId, job_id: j.id, title: `TEST 0409 onto a job ${i + 1}`, description: `  ${SCOPE}${LF}` }));
    await insertQuotes(quotes);
    const before = await jobsNow(jobs.map((j) => j.id));
    const count = await jobCount();

    const answers = await accept(quotes.map((q) => q.public_token));
    const after = await jobsNow(jobs.map((j) => j.id));
    const linked = await jobsOf(quotes.map((q) => q.id));
    for (const [i, k] of HAS.entries()) {
      const id = jobs[i].id;
      expect({ why: k.why, answer: answers.get(quotes[i].public_token) }).toEqual({ why: k.why, answer: { ok: true } });
      // The app's own answer for that Description, held to what is said in the table.
      expect({ why: k.why, app: jobTakesScope(k.has) }).toEqual({ why: k.why, app: k.takes });
      expect({ why: k.why, description: after.get(id)!.description }).toEqual({ why: k.why, description: k.takes ? SCOPE : k.has });
      // A job with words is not rewritten with its own words either: nobody wrote that row.
      expect({ why: k.why, written: after.get(id)!.at !== before.get(id)!.at }).toEqual({ why: k.why, written: k.takes });
      // The estimate stays on the job it was on, accepted.
      expect({ why: k.why, job: linked.get(quotes[i].id)!.job_id, estimate: linked.get(quotes[i].id)!.quote_status }).toEqual({ why: k.why, job: id, estimate: "accepted" });
    }
    expect(await jobCount()).toBe(count);
  });

  it("an estimate with no words fills nothing: an empty Description stays exactly what it was, and the row is not written", async () => {
    const jobs = [null, "", ` ${TAB}`].map((has) => jobRow({ customer_id: danaId, description: has }));
    await insertJobs(jobs);
    const quotes = [null, "", ` ${LF}${CR}${TAB} `].map((words, i) => quoteRow({ customer_id: danaId, job_id: jobs[i].id, description: words }));
    await insertQuotes(quotes);
    const before = await jobsNow(jobs.map((j) => j.id));
    const answers = await accept(quotes.map((q) => q.public_token));
    expect([...answers.values()]).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    const after = await jobsNow(jobs.map((j) => j.id));
    for (const j of jobs) {
      expect(after.get(j.id)!.description).toBe(j.description); // null stays null, "" stays "", blank stays blank
      expect(after.get(j.id)!.at).toBe(before.get(j.id)!.at);
    }
  });

  it("a revision accepted through its own link is pinned to the job of the estimate it revises (0392): no second job, and the same rule on that job", async () => {
    const empty = jobRow({ customer_id: danaId, description: null });
    const worded = jobRow({ customer_id: danaId, description: TYPED });
    await insertJobs([empty, worded]);
    // Two originals, each accepted earlier and on its job; and a revision of each, sent, on no job yet.
    const first = quoteRow({ customer_id: danaId, job_id: empty.id, status: "accepted", accepted_at: LONG_AGO, description: null });
    const second = quoteRow({ customer_id: danaId, job_id: worded.id, status: "accepted", accepted_at: LONG_AGO, description: "The first scope" });
    const revisesFirst = quoteRow({ customer_id: danaId, revises_quote_id: first.id, description: ` The revised scope${CR}${LF}` });
    const revisesSecond = quoteRow({ customer_id: danaId, revises_quote_id: second.id, description: "The revised scope" });
    await insertQuotes([first, second, revisesFirst, revisesSecond]);
    const count = await jobCount();
    const before = await jobsNow([empty.id, worded.id]);

    const answers = await accept([revisesFirst.public_token, revisesSecond.public_token]);
    expect([...answers.values()]).toEqual([{ ok: true }, { ok: true }]);
    expect(await jobCount()).toBe(count); // the work is one job: none was born
    const linked = await jobsOf([revisesFirst.id, revisesSecond.id]);
    expect({ job: linked.get(revisesFirst.id)!.job_id, estimate: linked.get(revisesFirst.id)!.quote_status }).toEqual({ job: empty.id, estimate: "accepted" });
    expect({ job: linked.get(revisesSecond.id)!.job_id, estimate: linked.get(revisesSecond.id)!.quote_status }).toEqual({ job: worded.id, estimate: "accepted" });
    const after = await jobsNow([empty.id, worded.id]);
    // The job that had no scope takes the revision's; the job with words keeps them, unwritten.
    expect(after.get(empty.id)!.description).toBe("The revised scope");
    expect(after.get(worded.id)!.description).toBe(TYPED);
    expect(after.get(worded.id)!.at).toBe(before.get(worded.id)!.at);
  });

  it("the customer's link, with no session, reaches the door; a second tap changes nothing; a token nobody holds is answered as it always was", async () => {
    const quote = quoteRow({ customer_id: danaId, description: `${TAB}${SCOPE}  ` });
    await insertQuotes([quote]);
    const nobody = `test-0409-nobody-${randomUUID()}`;
    const count = await jobCount();
    const answers = await throughTheLink(() => accept([quote.public_token, nobody]));
    expect(answers.get(quote.public_token)).toEqual({ ok: true });
    expect(answers.get(nobody)).toEqual({ ok: false, error: "Quote not found." });
    const born = (await jobsOf([quote.id])).get(quote.id)!;
    expect({ estimate: born.quote_status, description: born.description, org: born.org_id }).toEqual({ estimate: "accepted", description: SCOPE, org: orgId });
    expect(await jobCount()).toBe(count + 1);

    // Somebody types on the job; the customer taps the link again. Accepted is answered, and the job
    // is the same job with the words that were typed.
    expect((await c.query("update public.jobs set description = $2 where id = $1 and org_id = $3 returning id", [born.job_id, TYPED, orgId])).rowCount).toBe(1);
    const again = await throughTheLink(() => accept([quote.public_token]));
    expect(again.get(quote.public_token)).toEqual({ ok: true });
    const now = (await jobsOf([quote.id])).get(quote.id)!;
    expect({ job: now.job_id, description: now.description }).toEqual({ job: born.job_id, description: TYPED });
    expect(await jobCount()).toBe(count + 1);
  });

  it("an invoice's site list is the app's list: its job, then the estimate it was made from, then that estimate's lead, with the customer beside it", async () => {
    const sam = leadRow({ ...BAYBERRY });
    const samNowhere = leadRow(); // a lead who never said where
    const theirLead = leadRow({ org_id: otherOrgId, ...at("77 TEST Bayberry Ln") });
    await insertLeads([sam, samNowhere, theirLead]);
    const job = jobRow({ customer_id: danaId, ...LARKSPUR });
    const jobNowhere = jobRow({ customer_id: danaId }); // a job nobody gave an address
    const theirJob = jobRow({ org_id: otherOrgId, ...at("66 TEST Larkspur Way") });
    await insertJobs([job, jobNowhere, theirJob]);
    const whole = quoteRow({ customer_id: danaId, inquiry_id: sam.id, job_id: job.id, status: "accepted", ...SNOWBELL }); // its own site, a lead, a job
    const own = quoteRow({ customer_id: danaId, inquiry_id: sam.id, ...SNOWBELL }); // its own site and a lead, never a job
    const leadOnly = quoteRow({ customer_id: danaId, inquiry_id: sam.id }); // no site of its own; its lead has one
    const bare = quoteRow({ customer_id: danaId }); // no site, no lead
    const leadBare = quoteRow({ customer_id: danaId, inquiry_id: samNowhere.id }); // no site; a lead with none either
    const theirs = quoteRow({ org_id: otherOrgId, created_by: otherOwnerId, ...at("88 TEST Snowbell Ct") }); // another company's estimate
    const ourOnTheirLead = quoteRow({ customer_id: danaId, inquiry_id: theirLead.id }); // ours, pointing at another company's lead
    await insertQuotes([whole, own, leadOnly, bare, leadBare, theirs, ourOnTheirLead]);

    const bill = (o: Partial<InvoiceRow> = {}) => invoiceRow({ customer_id: danaId, ...o });
    const cases: { why: string; row: InvoiceRow; of: Records; picks: string | null }[] = [
      { why: "on a job, made from an estimate that has a site and a lead: all three, in the app's order", row: bill({ job_id: job.id, quote_id: whole.id }), of: { job: LARKSPUR, quote: SNOWBELL, lead: BAYBERRY, customer: HOME }, picks: "job" },
      { why: "no job, made straight from an estimate with a site of its own", row: bill({ quote_id: own.id }), of: { quote: SNOWBELL, lead: BAYBERRY, customer: HOME }, picks: "quote" },
      { why: "no job; the estimate has no site, its lead has one", row: bill({ quote_id: leadOnly.id }), of: { quote: NOWHERE, lead: BAYBERRY, customer: HOME }, picks: "lead" },
      { why: "no job; the estimate has no site and no lead", row: bill({ quote_id: bare.id }), of: { quote: NOWHERE, customer: HOME }, picks: "customer" },
      { why: "no job; neither the estimate nor its lead has a site", row: bill({ quote_id: leadBare.id }), of: { quote: NOWHERE, lead: NOWHERE, customer: HOME }, picks: "customer" },
      { why: "a job with no address of its own, made from an estimate that has one", row: bill({ job_id: jobNowhere.id, quote_id: own.id }), of: { job: NOWHERE, quote: SNOWBELL, lead: BAYBERRY, customer: HOME }, picks: "quote" },
      { why: "a job and no estimate: as before 0409, with two nulls after it", row: bill({ job_id: job.id }), of: { job: LARKSPUR, customer: HOME }, picks: "job" },
      { why: "no job and no estimate: three nulls, and the customer's own address", row: bill(), of: { customer: HOME }, picks: "customer" },
      { why: "no job, no estimate, no customer: nowhere", row: bill({ customer_id: null }), of: {}, picks: null },
      { why: "another company's estimate is never read", row: bill({ quote_id: theirs.id }), of: { customer: HOME }, picks: "customer" },
      { why: "another company's lead is never read, though our own estimate points at it", row: bill({ quote_id: ourOnTheirLead.id }), of: { quote: NOWHERE, customer: HOME }, picks: "customer" },
      { why: "another company's job is never read (0301's own rule, unchanged)", row: bill({ job_id: theirJob.id }), of: { customer: HOME }, picks: "customer" },
    ];
    await insertInvoices(cases.map((k) => k.row));
    const docs = await docsOf(cases.map((k) => k.row.id));

    for (const k of cases) {
      const doc = docs.get(k.row.id)!;
      // The document is the one it was: the same six keys, the site list still a list of three.
      expect(Object.keys(doc).sort(), k.why).toEqual(["customer", "invoice", "items", "org", "payments", "site_candidates"]);
      expect(doc.invoice.invoice_number, k.why).toBe(k.row.invoice_number);
      expect(doc.site_candidates, k.why).toHaveLength(3);
      // THE LIST IS THE APP'S, entry for entry, and the customer rides beside it.
      expect({ why: k.why, list: doc.site_candidates }).toEqual({ why: k.why, list: appList(k.of) });
      expect({ why: k.why, customer: five(doc.customer) }).toEqual({ why: k.why, customer: k.of.customer ?? null });
      // What a reader prints from it is what the office's own pages print from the same records.
      expect({ why: k.why, picked: readerPick(doc) }).toEqual({ why: k.why, picked: pickSite(bornFromEstimateCandidates(k.of)) });
      expect({ why: k.why, picks: readerPick(doc)?.source ?? null }).toEqual({ why: k.why, picks: k.picks });
    }

    // IN FIGURES, the cases this wave named. All three records: the sources in order are the app's,
    // less its last, which is the customer.
    const all = docs.get(cases[0].row.id)!;
    const app = bornFromEstimateCandidates({ job: LARKSPUR, quote: SNOWBELL, lead: BAYBERRY, customer: HOME });
    expect(app.map((x) => x.source)).toEqual(["job", "quote", "lead", "customer"]);
    expect(all.site_candidates.map((x) => x?.source)).toEqual(app.map((x) => x.source).slice(0, -1));
    expect(all.site_candidates).toEqual([
      { source: "job", parts: LARKSPUR },
      { source: "quote", parts: SNOWBELL },
      { source: "lead", parts: BAYBERRY },
    ]);
    // A bill with no job, made from an estimate with its own address: a 'quote' candidate, which wins.
    const straight = docs.get(cases[1].row.id)!;
    expect(straight.site_candidates[0]).toBeNull();
    expect(straight.site_candidates[1]).toEqual({ source: "quote", parts: SNOWBELL });
    expect(readerPick(straight)).toMatchObject({ source: "quote", address: SNOWBELL.address, unit: SNOWBELL.unit, complete: true });
    // An estimate with no address whose lead has one: a 'lead' candidate, which wins.
    const byLead = docs.get(cases[2].row.id)!;
    expect(byLead.site_candidates).toEqual([null, { source: "quote", parts: NOWHERE }, { source: "lead", parts: BAYBERRY }]);
    expect(readerPick(byLead)).toMatchObject({ source: "lead", address: BAYBERRY.address });
    // No estimate: nulls where its candidates would be. And none of anything: three nulls.
    expect(docs.get(cases[6].row.id)!.site_candidates).toEqual([{ source: "job", parts: LARKSPUR }, null, null]);
    expect(docs.get(cases[7].row.id)!.site_candidates).toEqual([null, null, null]);
    // Another company's records leave nothing behind: not a candidate, and not a word of their address.
    for (const i of [9, 10, 11]) {
      const raw = JSON.stringify(docs.get(cases[i].row.id));
      for (const theirWords of ["88 TEST Snowbell Ct", "77 TEST Bayberry Ln", "66 TEST Larkspur Way"]) expect(raw, cases[i].why).not.toContain(theirWords);
    }
  });

  it("the customer's link reads the list through public_invoice; nobody outside the database calls the projection, and the Accept door is granted as it was", async () => {
    const sam = leadRow({ ...BAYBERRY });
    await insertLeads([sam]);
    const quote = quoteRow({ customer_id: danaId, inquiry_id: sam.id, ...SNOWBELL });
    await insertQuotes([quote]);
    const sent = invoiceRow({ customer_id: danaId, quote_id: quote.id });
    const draft = invoiceRow({ customer_id: danaId, quote_id: quote.id, status: "draft" });
    await insertInvoices([sent, draft]);

    const privileges = await one(
      `select has_function_privilege('anon', 'public.accept_public_quote(text)', 'execute') as accept_anon,
              has_function_privilege('authenticated', 'public.accept_public_quote(text)', 'execute') as accept_authed,
              (select p.prosecdef from pg_proc p where p.oid = 'public.accept_public_quote(text)'::regprocedure) as accept_definer,
              (select count(*)::int from pg_proc p where p.proname = 'accept_public_quote' and p.pronamespace = 'public'::regnamespace) as accepts,
              has_function_privilege('anon', 'public.invoice_document_projection(uuid)', 'execute') as projection_anon,
              has_function_privilege('authenticated', 'public.invoice_document_projection(uuid)', 'execute') as projection_authed,
              has_function_privilege('service_role', 'public.invoice_document_projection(uuid)', 'execute') as projection_service,
              (select p.prosecdef from pg_proc p where p.oid = 'public.invoice_document_projection(uuid)'::regprocedure) as projection_definer,
              (select p.provolatile::text from pg_proc p where p.oid = 'public.invoice_document_projection(uuid)'::regprocedure) as projection_volatility,
              (select count(*)::int from pg_proc p where p.proname = 'invoice_document_projection' and p.pronamespace = 'public'::regnamespace) as projections,
              has_function_privilege('anon', 'public.public_invoice(text)', 'execute') as invoice_anon`,
    );
    expect(privileges).toEqual({
      accept_anon: true,
      accept_authed: true,
      accept_definer: true,
      accepts: 1,
      projection_anon: false,
      projection_authed: false,
      projection_service: true,
      projection_definer: true,
      projection_volatility: "s",
      projections: 1,
      invoice_anon: true,
    });
    // Called directly, the projection is refused: permission denied, for the link and for a signed-in owner.
    expect(await refused("anon", "select public.invoice_document_projection($1::uuid)", [sent.id])).toBe("42501");
    expect(await refused({ uid: ownerId }, "select public.invoice_document_projection($1::uuid)", [sent.id])).toBe("42501");

    // Through the customer's link it is reached, and the list is the one the server reads.
    const server = (await docsOf([sent.id])).get(sent.id)!;
    expect(server.site_candidates).toEqual([null, { source: "quote", parts: SNOWBELL }, { source: "lead", parts: BAYBERRY }]);
    const link = await throughTheLink(async () => {
      const rows = (await c.query("select t.token, public.public_invoice(t.token)::text as raw from unnest($1::text[]) as t(token)", [[sent.public_token, draft.public_token]])).rows as {
        token: string;
        raw: string | null;
      }[];
      return new Map(rows.map((r) => [r.token, r.raw]));
    });
    expect(JSON.parse(String(link.get(sent.public_token)))).toEqual(server);
    // The door's own gate is where it was: a draft is answered with nothing.
    expect(link.get(draft.public_token)).toBeNull();
  });

  it("the backfill, cut out of the migration and run here: an empty job takes its earliest accepted estimate's words WITHOUT being stamped as changed, a job with words is not written, a second run writes no row, and the stamp is on again", async () => {
    // The block as the file carries it, between its own two headings: the stamp switched off, one
    // DO statement, the stamp switched on again (0298's method), run together as the file runs them.
    const file = readFileSync(M0409, "utf8");
    const from = file.indexOf("-- ── 3. The one-time backfill");
    const to = file.indexOf("-- ── Self-check");
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const section = file.slice(from, to);
    const off = "alter table public.jobs disable trigger touch_jobs;";
    const on = "alter table public.jobs enable trigger touch_jobs;";
    const block = section.slice(section.indexOf(off), section.indexOf(on) + on.length).trim();
    expect(block.startsWith(off)).toBe(true);
    expect(block.endsWith(on)).toBe(true);
    expect(block.split("do $$")).toHaveLength(2);
    expect(block).toContain("update public.jobs j");
    /** touch_jobs as the database holds it: 'O' is enabled. */
    const touchJobs = async () =>
      (await one("select tgenabled::text as state from pg_trigger where tgrelid = 'public.jobs'::regclass and tgname = 'touch_jobs' and not tgisinternal")).state as string;
    expect(await touchJobs()).toBe("O");

    // Every job here was last changed long ago, so the stamp the backfill leaves can be seen.
    const old = (o: Partial<JobRow> = {}) => jobRow({ customer_id: danaId, updated_at: LONG_AGO, ...o });
    const accepted = (jobId: string, description: string | null, o: Partial<QuoteRow> = {}) => quoteRow({ customer_id: danaId, job_id: jobId, status: "accepted", accepted_at: "2026-03-01T12:00:00.000Z", description, ...o });
    const [low, high] = [randomUUID(), randomUUID()].sort();

    const earliest = old();
    const unstamped = old({ description: "" });
    const madeFirst = old();
    const lowestId = old();
    const blank = old({ description: ` ${TAB}${CR}${LF}` });
    const revised = old();
    const typed = old({ description: TYPED });
    const noBreak = old({ description: NBSP });
    const nothingToTake = old();
    const theirsOnOurs = old();
    const otherCompanys = old({ org_id: otherOrgId, customer_id: null });
    const jobs = [earliest, unstamped, madeFirst, lowestId, blank, revised, typed, noBreak, nothingToTake, theirsOnOurs, otherCompanys];
    await insertJobs(jobs);
    await insertQuotes([
      // The one accepted first is taken, whichever was written first, and its words are trimmed.
      accepted(earliest.id, "The later words", { accepted_at: "2026-03-05T12:00:00.000Z", created_at: "2026-02-01T12:00:00.000Z" }),
      accepted(earliest.id, `  The earliest accepted words${LF}`, { accepted_at: "2026-03-01T12:00:00.000Z", created_at: "2026-02-20T12:00:00.000Z" }),
      // An accepted estimate with no accepted_at is placed by the day it was made.
      accepted(unstamped.id, "Made in January, never stamped", { accepted_at: null, created_at: "2026-01-10T12:00:00.000Z" }),
      accepted(unstamped.id, "Accepted in February", { accepted_at: "2026-02-01T12:00:00.000Z", created_at: "2026-01-01T12:00:00.000Z" }),
      // Accepted at the same moment: the one made first.
      accepted(madeFirst.id, "Made second", { created_at: "2026-02-02T12:00:00.000Z" }),
      accepted(madeFirst.id, "Made first", { created_at: "2026-02-01T12:00:00.000Z" }),
      // Accepted and made at the same moment: the lower id, so the answer is the same on every run.
      accepted(lowestId.id, "The higher id", { id: high, created_at: "2026-02-01T12:00:00.000Z" }),
      accepted(lowestId.id, "The lower id", { id: low, created_at: "2026-02-01T12:00:00.000Z" }),
      // A Description of blank space is an empty one.
      accepted(blank.id, "Words for a job that held only blank space"),
      // A superseded original is not read; the revision that was accepted is.
      accepted(revised.id, "The original words", { status: "superseded", accepted_at: "2026-01-05T12:00:00.000Z" }),
      accepted(revised.id, "The revised words", { accepted_at: "2026-02-05T12:00:00.000Z" }),
      // Words a person typed, and a no-break space a person left, are never replaced.
      accepted(typed.id, "These words never land"),
      accepted(noBreak.id, "Nor do these"),
      // Nothing to take: an estimate that was only sent, and accepted ones with no words.
      accepted(nothingToTake.id, "Only sent, never accepted", { status: "sent", accepted_at: null }),
      accepted(nothingToTake.id, ` ${TAB}${LF}`),
      accepted(nothingToTake.id, null),
      // Another company's accepted estimate pointing at our job fills nothing…
      accepted(theirsOnOurs.id, "Another company's words", { org_id: otherOrgId, customer_id: null, created_by: otherOwnerId }),
      // …and that company's own job takes its own estimate's words: the backfill is for every company.
      accepted(otherCompanys.id, `${TAB}The other company's own scope`, { org_id: otherOrgId, customer_id: null, created_by: otherOwnerId }),
    ]);
    const ids = jobs.map((j) => j.id);
    const before = await jobsNow(ids);
    for (const j of jobs) expect(before.get(j.id)!.stamp_kept).toBe(true); // the stamps really are long ago

    await c.query(block);
    const after = await jobsNow(ids);
    const filled: [JobRow, string][] = [
      [earliest, "The earliest accepted words"],
      [unstamped, "Made in January, never stamped"],
      [madeFirst, "Made first"],
      [lowestId, "The lower id"],
      [blank, "Words for a job that held only blank space"],
      [revised, "The revised words"],
      [otherCompanys, "The other company's own scope"],
    ];
    for (const [job, words] of filled) {
      // Filled, with the earliest accepted estimate's trimmed words…
      expect({ job: job.name, description: after.get(job.id)!.description }).toEqual({ job: job.name, description: words });
      // …and NOT STAMPED AS CHANGED: touch_jobs is off for this one statement, so the job keeps the
      // updated_at it had. That is the stamp Needs You, Timecards and the calendar sweep read: a
      // finished, never-billed job must not come back as if it had finished today.
      expect({
        job: job.name,
        stamped: after.get(job.id)!.stamped_now,
        kept: after.get(job.id)!.stamp_kept,
        written: after.get(job.id)!.at !== before.get(job.id)!.at,
      }).toEqual({ job: job.name, stamped: false, kept: true, written: true });
    }
    // THE STAMP IS ON AGAIN: a missed enable would stop updated_at on jobs for good.
    expect(await touchJobs()).toBe("O");
    for (const job of [typed, noBreak, nothingToTake, theirsOnOurs]) {
      // Not written at all: the same words, the same row, the stamp it had.
      expect({ job: job.name, description: after.get(job.id)!.description }).toEqual({ job: job.name, description: job.description });
      expect({ job: job.name, written: after.get(job.id)!.at !== before.get(job.id)!.at, kept: after.get(job.id)!.stamp_kept }).toEqual({ job: job.name, written: false, kept: true });
    }
    expect(filled.length + 4).toBe(jobs.length);

    // THE SECOND RUN: it finds nothing to fill, and not one of these rows is written again.
    await c.query(block);
    const again = await jobsNow(ids);
    for (const j of jobs) expect({ job: j.name, row: again.get(j.id)!.at, description: again.get(j.id)!.description }).toEqual({ job: j.name, row: after.get(j.id)!.at, description: after.get(j.id)!.description });
    // And on: the next ordinary save of a job is stamped, as every save was before the backfill.
    expect(await touchJobs()).toBe("O");
    await c.query("update public.jobs set name = name where id = $1", [typed.id]);
    expect((await jobsNow([typed.id])).get(typed.id)!.stamped_now).toBe(true);
  });
});
