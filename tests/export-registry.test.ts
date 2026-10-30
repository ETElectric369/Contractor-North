import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COMPANY_SECRET_KEYS,
  COMPANY_TABLE,
  EXPORT_TABLES,
  OMITTED_COLUMNS,
  SECRET_COLUMN_PATTERN,
  SECRET_LOOKALIKES,
  SKIPPED_TABLES,
  companyJson,
} from "@/lib/export/registry";

/**
 * THE EXPORT REGISTRY IS THE WHOLE CENSUS (cn-v1138). Every migration is parsed for the tables it
 * made, renamed and dropped and the columns it added, dropped and renamed; the registry must name
 * every public table in exactly one place (the company's row, the export list, the skipped list
 * with a why) and, for every exported table, every column the migrations gave it in exactly one
 * place (the CSV's header, or OMITTED_COLUMNS with a why). A column whose name looks like a secret
 * leaves only when SECRET_LOOKALIKES says why it is not one.
 *
 * Two omissions are rules the test applies itself, because the names must stay out of src/: every
 * organizations.stripe_ column, and permits' three inline inspection columns 0378 superseded
 * (tests/no-superseded-permit-columns keeps them unread; they match /^inspect/). Two census names
 * are named only here for the same reason (tests/no-time-allocations keeps the first out of src/):
 * the old time-split table 0290 dropped, and its copy in the archive schema (0289), which PostgREST
 * never exposes. A `create temp table` lives and dies inside its migration and is not a table.
 */
const MIGRATIONS = join(process.cwd(), "supabase/migrations");

const NAMED_ONLY_HERE: Record<string, string> = {
  "public.time_allocations": "dropped in 0290 (the old split table); the name stays out of src/",
  "archive.time_allocations": "0289's copy of the old split rows, in a schema PostgREST does not expose",
};

type Table = { schema: string; name: string; columns: string[]; created: string | null; dropped: string | null; renamedTo: string | null };

const strip = (s: string) => s.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

/** Split on commas at paren depth 0. */
function splitTop(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

const NOT_A_COLUMN = /^(constraint|primary\s+key|unique|foreign\s+key|check|exclude|like)\b/i;
const NAME = `(?:([a-z_][a-z0-9_]*)\\.)?"?([a-z_][a-z0-9_]*)"?`;

export function censusOfMigrations(dir: string = MIGRATIONS): Map<string, Table> {
  const tables = new Map<string, Table>();
  const temp = new Set<string>();
  const get = (schema: string, name: string): Table => {
    const key = `${schema}.${name}`;
    let t = tables.get(key);
    if (!t) {
      t = { schema, name, columns: [], created: null, dropped: null, renamedTo: null };
      tables.set(key, t);
    }
    return t;
  };
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = strip(readFileSync(join(dir, file), "utf8"));
    const num = file.slice(0, 4);
    for (const m of sql.matchAll(/create\s+temp(?:orary)?\s+table\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) temp.add(m[1].toLowerCase());

    const cre = new RegExp(`create\\s+(?:unlogged\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${NAME}\\s*\\(`, "gi");
    let m: RegExpExecArray | null;
    while ((m = cre.exec(sql))) {
      const t = get((m[1] ?? "public").toLowerCase(), m[2].toLowerCase());
      let depth = 1;
      let body = "";
      for (let i = cre.lastIndex; i < sql.length && depth > 0; i++) {
        const ch = sql[i];
        if (ch === "(") depth++;
        if (ch === ")") {
          depth--;
          if (depth === 0) break;
        }
        body += ch;
      }
      t.created ??= num;
      t.dropped = null;
      for (const part of splitTop(body)) {
        const p = part.trim();
        if (!p || NOT_A_COLUMN.test(p)) continue;
        const col = /^"?([a-z_][a-z0-9_]*)"?\s/i.exec(p);
        if (col && !t.columns.includes(col[1].toLowerCase())) t.columns.push(col[1].toLowerCase());
      }
    }

    const alt = new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${NAME}\\s+([^;]*);`, "gi");
    while ((m = alt.exec(sql))) {
      const schema = (m[1] ?? "public").toLowerCase();
      const name = m[2].toLowerCase();
      const ops = m[3].trim();
      const rename = /^rename\s+to\s+"?([a-z_][a-z0-9_]*)"?/i.exec(ops);
      if (rename) {
        const t = get(schema, name);
        const to = get(schema, rename[1].toLowerCase());
        t.renamedTo = to.name;
        to.columns = [...t.columns];
        to.created ??= num;
        continue;
      }
      const t = get(schema, name);
      for (const op of splitTop(ops)) {
        const o = op.trim();
        let mm: RegExpExecArray | null;
        if (/^add\s+constraint/i.test(o) || /^drop\s+constraint/i.test(o)) continue;
        if ((mm = /^add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/i.exec(o))) {
          const c = mm[1].toLowerCase();
          if (!t.columns.includes(c)) t.columns.push(c);
        } else if ((mm = /^drop\s+(?:column\s+)?(?:if\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/i.exec(o))) {
          const c = mm[1].toLowerCase();
          t.columns = t.columns.filter((x) => x !== c);
        } else if ((mm = /^rename\s+(?:column\s+)?"?([a-z_][a-z0-9_]*)"?\s+to\s+"?([a-z_][a-z0-9_]*)"?/i.exec(o))) {
          const a = mm[1].toLowerCase();
          const b = mm[2].toLowerCase();
          t.columns = t.columns.map((x) => (x === a ? b : x));
        }
      }
    }

    const drp = new RegExp(`drop\\s+table\\s+(?:if\\s+exists\\s+)?${NAME}`, "gi");
    while ((m = drp.exec(sql))) {
      const schema = (m[1] ?? "public").toLowerCase();
      const name = m[2].toLowerCase();
      if (schema === "pg_temp" || temp.has(name)) continue;
      get(schema, name).dropped = num;
    }
  }
  for (const name of temp) tables.delete(`public.${name}`);
  // 0004 adds org_id to the first twenty tables through a loop the parser cannot read; org_id is
  // never exported, and the database suite proves it is there.
  return tables;
}

const census = censusOfMigrations();
const live = [...census.values()].filter((t) => t.schema === "public" && !t.dropped && !t.renamedTo);
const exportNames = EXPORT_TABLES.map((t) => t.table);
const skippedNames = SKIPPED_TABLES.map((t) => t.table);
const named = new Set([COMPANY_TABLE.table, ...exportNames, ...skippedNames]);
const ORDER_NOT_ID: Record<string, string> = { doc_counters: "doc_type", customer_portal_access: "customer_id", job_shared_documents: "document_id" };

describe("the export registry is the whole census of what a company owns", () => {
  it("found the migrations (so a passing run means something)", () => {
    expect(census.size).toBeGreaterThan(100);
    expect(live.length).toBeGreaterThan(90);
    expect(census.get("public.jobs")?.columns).toContain("report_back_at"); // 0385: the parser reads adds
    expect(census.get("public.error_events")?.created).toBe("0146"); // the parser reads renames
    expect(census.get("public.sentry_events")?.renamedTo).toBe("error_events");
    expect(census.get("public.phone_contacts")?.dropped).toBe("0236"); // the parser reads drops
    expect(census.has("public._0313_owed")).toBe(false); // a temp table is not a table
    expect(census.has("archive.time_allocations")).toBe(true); // another schema is seen
  });

  it("the census is exact: 87 exported tables and 28 skipped, none twice (a new table moves the number here, on purpose)", () => {
    expect(EXPORT_TABLES.length).toBe(87);
    expect(SKIPPED_TABLES.length).toBe(28);
    expect(new Set(exportNames).size).toBe(exportNames.length);
    expect(new Set(skippedNames).size).toBe(skippedNames.length);
    expect(exportNames.filter((n) => skippedNames.includes(n))).toEqual([]);
    expect(exportNames).not.toContain(COMPANY_TABLE.table);
    expect(skippedNames).not.toContain(COMPANY_TABLE.table);
  });

  it("every table a migration made is the company's row, exported, skipped with a why, or named here", () => {
    const missing: string[] = [];
    for (const t of census.values()) {
      const key = `${t.schema}.${t.name}`;
      if (NAMED_ONLY_HERE[key]) continue;
      if (t.schema !== "public") missing.push(`${key} (schema ${t.schema})`);
      else if (!named.has(t.name)) missing.push(`${key} (created ${t.created}${t.dropped ? `, dropped ${t.dropped}` : ""}${t.renamedTo ? `, renamed to ${t.renamedTo}` : ""})`);
    }
    expect(missing).toEqual([]);
    for (const [key, why] of Object.entries(NAMED_ONLY_HERE)) {
      expect(census.has(key), key).toBe(true);
      expect(why.length).toBeGreaterThanOrEqual(10);
      expect(named.has(key.split(".")[1])).toBe(false);
    }
  });

  it("nothing in the registry names a table no migration made; a skipped history entry names its migration and the parser agrees", () => {
    for (const n of [COMPANY_TABLE.table, ...exportNames]) {
      const t = census.get(`public.${n}`);
      expect(t, n).toBeDefined();
      expect(t!.dropped, `${n} was dropped in ${t!.dropped}`).toBeNull();
      expect(t!.renamedTo, `${n} was renamed to ${t!.renamedTo}`).toBeNull();
    }
    for (const s of SKIPPED_TABLES) {
      expect(s.why.length, s.table).toBeGreaterThanOrEqual(10);
      const t = census.get(`public.${s.table}`);
      expect(t, s.table).toBeDefined();
      if (t!.dropped || t!.renamedTo) {
        const num = t!.dropped ?? [...census.values()].find((x) => x.name === t!.renamedTo)?.created;
        expect(s.why, `${s.table}: say the migration (${num})`).toContain(String(num));
        expect(s.why).toMatch(/renamed|dropped/);
      } else {
        expect(s.why, `${s.table} is live; its why must not call it history`).not.toMatch(/\b(renamed to|dropped in)\b/);
      }
    }
  });

  it("every exported column list: has the order column, never org_id, no duplicates; order is id unless the key is another column", () => {
    for (const t of [COMPANY_TABLE, ...EXPORT_TABLES]) {
      expect(t.columns.length, t.table).toBeGreaterThan(0);
      expect(new Set(t.columns).size, t.table).toBe(t.columns.length);
      expect(t.columns, t.table).not.toContain("org_id");
      expect(t.columns, t.table).toContain(t.order);
      expect(t.order, t.table).toBe(ORDER_NOT_ID[t.table] ?? "id");
      for (const c of t.columns) expect(c, `${t.table}.${c}`).toMatch(/^[a-z_][a-z0-9_]*$/);
    }
    expect(Object.keys(ORDER_NOT_ID).every((n) => exportNames.includes(n))).toBe(true);
  });

  it("every column the migrations gave an exported table is in its CSV or in OMITTED_COLUMNS with a why; nothing stale", () => {
    const problems: string[] = [];
    const omitted = (table: string) => OMITTED_COLUMNS.filter((o) => o.table === table).map((o) => o.column);
    for (const t of [COMPANY_TABLE, ...EXPORT_TABLES]) {
      const made = census.get(`public.${t.table}`)!.columns.filter((c) => c !== "org_id");
      for (const c of t.columns) if (!made.includes(c)) problems.push(`${t.table}.${c} is exported but no migration made it`);
      for (const c of omitted(t.table)) {
        if (!made.includes(c)) problems.push(`${t.table}.${c} is omitted but no migration made it`);
        if (t.columns.includes(c)) problems.push(`${t.table}.${c} is both exported and omitted`);
      }
      const unaccounted = made.filter((c) => !t.columns.includes(c) && !omitted(t.table).includes(c));
      if (t.table === COMPANY_TABLE.table) {
        // North's Stripe wiring, by rule: every stripe_ column and only those.
        const stray = unaccounted.filter((c) => !c.startsWith("stripe_"));
        if (stray.length) problems.push(`${t.table}: ${stray.join(", ")} neither exported nor omitted`);
        if (unaccounted.filter((c) => c.startsWith("stripe_")).length !== 8) problems.push(`${t.table}: expected the 8 stripe_ columns left out, got ${unaccounted.join(", ")}`);
        for (const c of t.columns) if (c.startsWith("stripe_")) problems.push(`${t.table}.${c} is Stripe wiring and is exported`);
      } else if (t.table === "permits") {
        // 0378's three superseded inline inspection columns, by rule (their names stay out of code).
        const stray = unaccounted.filter((c) => !/^inspect/.test(c));
        if (stray.length) problems.push(`permits: ${stray.join(", ")} neither exported nor omitted`);
        if (unaccounted.filter((c) => /^inspect/.test(c)).length !== 3) problems.push(`permits: expected 3 superseded columns left out, got ${unaccounted.join(", ")}`);
        for (const c of t.columns) if (/^inspect/.test(c)) problems.push(`permits.${c} is superseded (0378) and is exported`);
      } else if (unaccounted.length) {
        problems.push(`${t.table}: ${unaccounted.join(", ")} neither exported nor omitted`);
      }
    }
    for (const o of OMITTED_COLUMNS) {
      if (![COMPANY_TABLE.table, ...exportNames].includes(o.table)) problems.push(`OMITTED ${o.table}.${o.column}: not an exported table`);
      if (o.why.length < 10) problems.push(`OMITTED ${o.table}.${o.column}: say why`);
    }
    expect(problems).toEqual([]);
  });

  it("no exported column looks like a secret unless SECRET_LOOKALIKES says why it is not one; every lookalike is real", () => {
    const problems: string[] = [];
    const lookalike = (table: string, column: string) => SECRET_LOOKALIKES.find((l) => l.table === table && l.column === column);
    for (const t of [COMPANY_TABLE, ...EXPORT_TABLES]) {
      for (const c of t.columns) {
        if (SECRET_COLUMN_PATTERN.test(c) && !lookalike(t.table, c)) problems.push(`${t.table}.${c} looks like a secret and is exported`);
      }
    }
    for (const l of SECRET_LOOKALIKES) {
      const t = [COMPANY_TABLE, ...EXPORT_TABLES].find((x) => x.table === l.table);
      if (!t) problems.push(`lookalike ${l.table}.${l.column}: not an exported table`);
      else if (!t.columns.includes(l.column)) problems.push(`lookalike ${l.table}.${l.column}: not an exported column`);
      if (!SECRET_COLUMN_PATTERN.test(l.column)) problems.push(`lookalike ${l.table}.${l.column}: does not match the pattern; drop the entry`);
      if (l.why.length < 10) problems.push(`lookalike ${l.table}.${l.column}: say why`);
    }
    // The omitted ones are the secrets: every token column the migrations made on an exported table is omitted.
    for (const o of OMITTED_COLUMNS) if (!SECRET_COLUMN_PATTERN.test(o.column)) problems.push(`OMITTED ${o.table}.${o.column} does not look like a secret; is it really one?`);
    expect(problems).toEqual([]);
    expect(SECRET_COLUMN_PATTERN.test("public_token")).toBe(true);
    expect(SECRET_COLUMN_PATTERN.test("must_reset_password")).toBe(true);
    expect(SECRET_COLUMN_PATTERN.test("dismissed_task_keys")).toBe(false);
    expect(SECRET_COLUMN_PATTERN.test("key_part")).toBe(false);
  });

  it("companyJson: the row minus every stripe_ column, settings minus the inbound secret, a missing column empty", () => {
    expect(COMPANY_SECRET_KEYS).toEqual(["lead_inbound_secret"]);
    const out = companyJson(
      { id: "o1", name: "Larkspur", stripe_customer_id: "cus_1", stripe_account_id: "acct_1", plan: "pro", settings: { ignored: true } },
      { timezone: "America/Chicago", lead_inbound_secret: "shh", features: { sales_tax: true } },
    );
    expect(out.id).toBe("o1");
    expect(out.name).toBe("Larkspur");
    expect(out.plan).toBe("pro");
    expect(out.logo_url).toBeNull();
    expect(Object.keys(out).filter((k) => k.startsWith("stripe_"))).toEqual([]);
    expect(out.settings).toEqual({ timezone: "America/Chicago", features: { sales_tax: true } });
    expect(Object.keys(out).sort()).toEqual([...COMPANY_TABLE.columns].sort());
    // Settings that are not an object are an empty object, never a throw.
    expect(companyJson({ id: "o1" }, null).settings).toEqual({});
    expect(companyJson({ id: "o1" }, "x").settings).toEqual({});
    expect(companyJson({ id: "o1" }, [1]).settings).toEqual({});
  });
});
