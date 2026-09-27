import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { companyFromOrg } from "@/components/doc-letterhead";
import type { Organization } from "@/lib/types";

/**
 * THE TAGLINE UNDER A COMPANY'S NAME (Wave 0), pinned against the TEST database inside ONE
 * transaction that is always rolled back, with throwaway companies minted in it:
 *   · 0354's one-shot line gives ET its tagline only when it has none, keeps every other doc_style
 *     key (and every other setting), and a second run changes nothing. The line is read from the
 *     migration file itself and run against a throwaway company in ET's place: a suite never writes
 *     a live company's id, even on the test database.
 *   · public_quote (/q) and public_invoice (/i) carry the tagline inside their one whitelisted
 *     doc_style key, and companyFromOrg reads it from exactly what they return. No new key.
 *
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run <this file>
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const MIGRATION = fileURLToPath(new URL("../../supabase/migrations/0354_any_company_any_supplier.sql", import.meta.url));
const ET = "60195593-2e18-4230-bc8e-7a32d36d038d";
const ET_TAGLINE = "Service · Integrity · Reliability";

/** 0354's tagline statement, exactly as the file has it (section 1b, up to its semicolon). */
function taglineLine(): string {
  const m = readFileSync(MIGRATION, "utf8").match(/-- ── 1b\.[^\n]*\n(?:--[^\n]*\n)*(update public\.organizations[\s\S]*?;)\s*\n/);
  if (!m) throw new Error("0354 has no section 1b tagline statement.");
  return m[1];
}

d("the document tagline: 0354's line and the public projections", () => {
  let c: pg.Client;
  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const settingsOf = async (orgId: string) => (await one("select settings from organizations where id = $1", [orgId])).settings;
  /** The migration's line, aimed at `orgId` in ET's place; returns how many rows it wrote. */
  const runLine = async (orgId: string) => (await c.query(taglineLine().split(ET).join(orgId))).rowCount;

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    // BEGIN FIRST: nothing on this connection runs outside the transaction that is rolled back.
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("the line names ET alone and writes ET's own words", () => {
    const line = taglineLine();
    expect(line.split(ET).length - 1).toBe(1);
    expect(line).toContain(`'${ET_TAGLINE}'`);
    expect(line).not.toMatch(/where\s+true|org_id\s+is\s+not\s+null/i);
  });

  it("sets a blank tagline once, keeps every other doc_style key and setting, and a rerun changes nothing", async () => {
    const org = (await mintThrowawayOrg(c, { label: "tagline", techs: 0 })).orgId;
    const other = (await mintThrowawayOrg(c, { label: "tagline bystander", techs: 0 })).orgId;
    const docStyle = { col_gap: 30, density: "airy", logo_size: "l", show_breakdown: false, closing_invoice: "Thanks", closing_quote: "", margin_x: 0.5, margin_y: 0.7 };
    await c.query("update organizations set settings = $2 where id = $1", [org, { glass_tint: "#123456", books_begin: "2026-06-08", doc_style: docStyle }]);
    const bystander = await settingsOf(other);

    expect(await runLine(org)).toBe(1);
    const after = await settingsOf(org);
    expect(after.doc_style).toEqual({ ...docStyle, tagline: ET_TAGLINE });
    expect(after.glass_tint).toBe("#123456");
    expect(after.books_begin).toBe("2026-06-08");

    // Idempotent: the second run finds a tagline and writes nothing.
    expect(await runLine(org)).toBe(0);
    expect(await settingsOf(org)).toEqual(after);
    // Only the one company named.
    expect(await settingsOf(other)).toEqual(bystander);
  });

  it("never overwrites a tagline the company chose", async () => {
    const org = (await mintThrowawayOrg(c, { label: "tagline kept", techs: 0 })).orgId;
    await c.query("update organizations set settings = $2 where id = $1", [org, { doc_style: { tagline: "Our Own Words", density: "compact" } }]);
    expect(await runLine(org)).toBe(0);
    expect((await settingsOf(org)).doc_style).toEqual({ tagline: "Our Own Words", density: "compact" });
  });

  it("creates doc_style when there is none (or it is not an object), and fills a blank tagline", async () => {
    const org = (await mintThrowawayOrg(c, { label: "tagline new", techs: 0 })).orgId;
    for (const [start, want] of [
      [{ glass_tint: "#abcdef" }, { glass_tint: "#abcdef", doc_style: { tagline: ET_TAGLINE } }],
      [{ doc_style: "junk" }, { doc_style: { tagline: ET_TAGLINE } }],
      [{ doc_style: { tagline: "   ", density: "airy" } }, { doc_style: { tagline: ET_TAGLINE, density: "airy" } }],
    ] as const) {
      await c.query("update organizations set settings = $2 where id = $1", [org, start]);
      expect(await runLine(org), JSON.stringify(start)).toBe(1);
      expect(await settingsOf(org), JSON.stringify(start)).toEqual(want);
    }
  });

  it("public_quote and public_invoice carry it inside doc_style, and the letterhead reads it from there", async () => {
    const org = (await mintThrowawayOrg(c, { label: "tagline doors", techs: 0 })).orgId;
    await c.query("update organizations set settings = $2 where id = $1", [org, { doc_style: { tagline: "Quality Work Since 1998", density: "airy" }, invoice_terms: "Net 30" }]);
    const cust = (await one("insert into customers (org_id, name) values ($1, 'TEST tagline customer') returning id", [org])).id;
    const qTok = `test-tagline-q-${cust}`;
    const iTok = `test-tagline-i-${cust}`;
    await c.query("insert into quotes (org_id, customer_id, quote_number, status, public_token) values ($1, $2, 'TEST-E-1', 'sent', $3)", [org, cust, qTok]);
    await c.query("insert into invoices (org_id, customer_id, invoice_number, status, public_token) values ($1, $2, 'TEST-INV-1', 'sent', $3)", [org, cust, iTok]);

    for (const [door, sql, tok] of [
      ["/q", "select public.public_quote($1) as j", qTok],
      ["/i", "select public.public_invoice($1) as j", iTok],
    ] as const) {
      const j = (await one(sql, [tok])).j;
      expect(j?.org?.doc_style?.tagline, door).toBe("Quality Work Since 1998");
      // Still the one whitelisted key: no settings object, no tagline key of its own.
      expect(j.org, door).not.toHaveProperty("settings");
      expect(j.org, door).not.toHaveProperty("tagline");
      expect(companyFromOrg(j.org as Organization).tagline, door).toBe("Quality Work Since 1998");
    }
  });
});
