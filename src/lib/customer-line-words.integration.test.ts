import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { customerLineWords, supplierNameSet } from "./invoice-math";

/**
 * Migration 0315: a customer never reads a supplier's name (audit v994 PL1).
 *
 * Against the live books of ET Electric and Vivian Builders, inside ONE transaction that is always
 * rolled back. Nothing is written: every invoice, line and bill read here is real, and read only.
 *
 *  1. No customer-facing projection of any non-void ET/Vivian invoice line names a supplier from
 *     bills.supplier: the invoice document (/i, and every bill on the portal), the portal's ledger
 *     lines, and the portal job page itself for every live portal link those orgs have.
 *  2. The SQL rule (customer_line_words) and the app's (customerLineWords) give the same words for
 *     every live line and for every shape the importer writes: the print page and the portal's last
 *     door run the TS twin, /i and the portal's function run the SQL one.
 *  3. The stored rows are untouched: the office keeps its words.
 *
 * Before 0315 is applied, the file itself is practised inside the transaction (and rolled back
 * with it), so the proof runs today; once it is applied, the live functions are what is tested.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npm test
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;

const ET = "60195593-2e18-4230-bc8e-7a32d36d038d";
const VIVIAN = "7d6da1e2-c9a0-47d8-bcc1-5b4c3e412fed";
const ORGS = [ET, VIVIAN];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A supplier's name as a whole phrase (so "CED" does not match "PLACED"). */
const namesIn = (text: string, names: string[]): string[] =>
  names.filter((n) => new RegExp(`(^|[^a-z0-9])${escape(n.toLowerCase())}($|[^a-z0-9])`, "i").test(text.toLowerCase()));

d("a customer never reads a supplier's name (0315)", { timeout: 60_000 }, () => {
  let c: pg.Client;
  let practised = false;
  /** bills.supplier per org, trimmed, three characters or more. */
  const billSuppliers = new Map<string, string[]>();
  /** Every name the rule compares against, per org (the four sources customer_line_words reads). */
  const ruleNames = new Map<string, ReadonlySet<string>>();

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await c.query("begin");
    const has = (await c.query("select to_regprocedure('public.customer_line_words(uuid, text, text, text, boolean)') is not null as ok")).rows[0].ok;
    if (!has) {
      practised = true;
      console.warn("[customer-line-words] 0315 is not applied here yet: practising it inside this rolled-back transaction.");
      const file = path.join(process.cwd(), "supabase/migrations/0315_a_customer_never_reads_a_supplier.sql");
      await c.query(fs.readFileSync(file, "utf8"));
    }
    for (const org of ORGS) {
      const bills = await c.query("select distinct btrim(supplier) s from public.bills where org_id = $1 and length(btrim(coalesce(supplier, ''))) >= 3", [org]);
      billSuppliers.set(org, bills.rows.map((r) => String(r.s)));
      const all = await c.query(
        `select supplier as n from public.bills where org_id = $1
         union all select vendor from public.purchase_orders where org_id = $1
         union all select name from public.supplier_accounts where org_id = $1
         union all select alias from public.supplier_aliases where org_id = $1`,
        [org],
      );
      ruleNames.set(org, supplierNameSet(all.rows.map((r) => r.n)));
    }
  });

  afterAll(async () => {
    if (!c) return;
    await c.query("rollback");
    await c.end();
  });

  it("the functions the customer's doors call read the words through the rule", async () => {
    const defs = (
      await c.query(
        `select pg_get_functiondef('public.invoice_document_projection(uuid)'::regprocedure) as doc,
                pg_get_functiondef('public.portal_job_view(text, uuid)'::regprocedure) as portal`,
      )
    ).rows[0];
    expect(defs.doc).toMatch(/customer_line_words\(i\.org_id, it\.description/);
    expect(defs.portal).toMatch(/customer_line_words\(a\.org_id, it\.description/);
  });

  it("no invoice document of a live ET/Vivian bill names a supplier (/i and the portal's bills)", async () => {
    const leaks: string[] = [];
    let lines = 0;
    for (const org of ORGS) {
      const names = billSuppliers.get(org) ?? [];
      const docs = await c.query(
        `select i.invoice_number, public.invoice_document_projection(i.id)::jsonb->'items' as items
           from public.invoices i where i.org_id = $1 and i.status <> 'void'`,
        [org],
      );
      for (const r of docs.rows) {
        for (const it of (r.items ?? []) as { description?: string }[]) {
          lines++;
          const hit = namesIn(String(it.description ?? ""), names);
          if (hit.length) leaks.push(`${r.invoice_number}: "${it.description}" names ${hit.join(", ")}`);
        }
      }
    }
    expect(lines).toBeGreaterThan(0);
    expect(leaks).toEqual([]);
  });

  it("no portal ledger line names a supplier, and neither does any live portal job page", async () => {
    const leaks: string[] = [];
    for (const org of ORGS) {
      const names = billSuppliers.get(org) ?? [];
      // The ledger lines, exactly as portal_job_view projects them.
      const rows = await c.query(
        `select i.invoice_number, public.customer_line_words(it.org_id, it.description, it.import_source, it.import_key, it.edited) as words
           from public.invoice_items it join public.invoices i on i.id = it.invoice_id
          where i.org_id = $1 and it.org_id = $1 and i.status <> 'void'`,
        [org],
      );
      for (const r of rows.rows) {
        const hit = namesIn(String(r.words ?? ""), names);
        if (hit.length) leaks.push(`${r.invoice_number}: "${r.words}" names ${hit.join(", ")}`);
      }
      // And the real page, through every live link and every job it shows.
      const links = await c.query(
        `select a.token, j.id as job_id
           from public.customer_portal_access a
           join public.jobs j on j.customer_id = a.customer_id and j.org_id = a.org_id
          where a.org_id = $1 and a.enabled`,
        [org],
      );
      for (const l of links.rows) {
        const view = (await c.query("select public.portal_job_view($1, $2)::text as j", [l.token, l.job_id])).rows[0].j;
        if (!view) continue;
        const parsed = JSON.parse(view) as { lines?: { description?: string }[]; invoices?: { doc?: { items?: { description?: string }[] } }[] };
        const words = [
          ...(parsed.lines ?? []).map((x) => x.description ?? ""),
          ...(parsed.invoices ?? []).flatMap((i) => (i.doc?.items ?? []).map((x) => x.description ?? "")),
        ];
        for (const w of words) {
          const hit = namesIn(w, names);
          if (hit.length) leaks.push(`portal job ${l.job_id}: "${w}" names ${hit.join(", ")}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it("the SQL rule and the app's rule give the same words for every live line", async () => {
    const diffs: string[] = [];
    let n = 0;
    for (const org of ORGS) {
      const rows = await c.query(
        `select it.id, it.description, it.import_source, it.import_key, it.edited,
                public.customer_line_words(it.org_id, it.description, it.import_source, it.import_key, it.edited) as sql_words
           from public.invoice_items it where it.org_id = $1`,
        [org],
      );
      for (const r of rows.rows) {
        n++;
        const ts = customerLineWords(r, ruleNames.get(org));
        const sql = r.sql_words == null ? "" : String(r.sql_words);
        if (ts !== sql) diffs.push(`${r.id}: TS "${ts}" vs SQL "${sql}" (stored "${r.description}")`);
      }
    }
    expect(n).toBeGreaterThan(0);
    expect(diffs).toEqual([]);
  });

  it("and for every shape the importer writes, with and without a key", async () => {
    const shapes: [string, string | null, string | null, boolean][] = [
      ["Materials — Consolidated Electrical Distributors, Inc. (CED) (bill #8802-1101363)", "costs", "bill:x", false],
      ["Materials — A Supplier Nobody Has Heard Of", "costs", "bill:x", false],
      ["Materials — A Supplier Nobody Has Heard Of", "costs", "bill:x", true],
      ["Materials — The Home Depot (PO 1042)", "costs", "po:x", true],
      ["Materials — The Home Depot", "costs", null, true],
      ["Materials — Ground rod", null, null, false],
      ["Materials — new dimmer switch", "costs", null, true],
      ["Materials — Assorted light bulbs, Signal wire - 100', 3A furnace fuses\nNew thermostat", "costs", "bill:5e1b", true],
      ["Supplies & tax — Consolidated Electrical Dist.", "costs", "bill:x:remainder", false],
      ["Supplies & tax —", "costs", "bill:x:remainder", true],
      ["Supplies & taxes", "costs", null, false],
      ["Returned: other items — Consolidated Electrical Dist.", "costs", "bill:r:remainder", false],
      ["Returned: materials — Consolidated Electrical Dist. (bill #8802-1)", "costs", "bill:r", false],
      ["Returned: tax", "costs", "bill:r:remainder", false],
      ["Returned: 4 in LED Shallow IC HSG", "costs", "bli:1", false],
      ["Labor - Brian Taylor", "labor", "labor:b", false],
      ["", "costs", null, false],
    ];
    for (const [description, src, key, edited] of shapes) {
      const sql = (await c.query("select public.customer_line_words($1, $2, $3, $4, $5) as w", [ET, description, src, key, edited])).rows[0].w;
      expect(customerLineWords({ description, import_source: src, import_key: key, edited }, ruleNames.get(ET)), description).toBe(sql ?? "");
    }
  });

  it("the stored rows keep the office's words: the scrub is on read, never a rewrite", async () => {
    const r = (
      await c.query(
        `select count(*)::int as n from public.invoice_items it join public.invoices i on i.id = it.invoice_id
          where i.org_id = $1 and it.import_source = 'costs' and it.description ~* '^\\s*(materials|supplies\\s*&\\s*tax)\\s*—\\s*\\S'`,
        [ET],
      )
    ).rows[0];
    // ET's books carry the supplier on these rows today (INV-00028, INV-061, INV-078).
    expect(r.n).toBeGreaterThan(0);
    if (practised) console.warn("[customer-line-words] all of the above ran against 0315 practised in this transaction; apply it to make it live.");
  });
});
