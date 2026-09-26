import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { assertTestDatabase } from "@/lib/db-guard";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * SHOP STOCK PHASE 3, END TO END: THE CROSS-CHECK NEITHER TEAM COULD RUN ALONE (feat/stock-phase3).
 *
 * feat/stock-take built the door (Took From Stock, the office bell, Undo, the job's takes list,
 * 0344's reads); feat/stock-bill built the billing (one invoice line per take, 0343's claim
 * boundary). This walks ONE take through both, inside ONE transaction that is always rolled back:
 *
 *   1. a tech's take goes through the REAL server action (takeFromStockAction → takeFromStock →
 *      stock_draw), speaking as the tech exactly as PostgREST does (role authenticated + JWT claims),
 *      and its answer carries no cost;
 *   2. it lands on job cost right away (job_shelf_net, jobMaterialCostFrom);
 *   3. it rings the office: the action's after() bell runs officeRecipients + createNotifications
 *      for real (a 'stock_taken' row per office person), one push;
 *   4. the office's import puts it on a draft ONCE, at the invoice's markup (11%), as a
 *      line_kind='materials' line claimed by the take's move ids (readJobStock + stockImportRows +
 *      upsert_imported_invoice_items + the importer's line_kind stamp), and a re-import or a second
 *      draft adds nothing; the invoice's own markup reads back as 11 with the take voting;
 *   5. Undo through the REAL undoTakeAction is refused with the invoice's name, and the takes list
 *      reads "Take It Off INV First" (office) / "Billed on INV" (crew);
 *   6. voiding the invoice releases it: Undo goes through, the job's cost drops, and the invoice
 *      can't come back from void.
 *
 * The rest of each server action (auth, cookies) is replaced by a thin PostgREST-shaped shim over
 * the one pg connection, which runs every call as the right person inside a savepoint.
 *
 * OPT-IN, ITS OWN THROWAWAY COMPANY, NEVER DDL ON PRODUCTION. It runs only with
 * STOCK_CROSSCHECK_DB=1 as well as the TEST_DB_* creds. No sandbox org is needed: right after BEGIN
 * it mints a TEST organization with an owner and a tech (throwaway-org.db-fixture.ts) inside the
 * same transaction, writes every fixture into that org, and rolls it all back. The live companies
 * are refused by id. When 0343/0344 are not on the database it applies them inside the transaction
 * ONLY with STOCK_CROSSCHECK_APPLY=1, which is refused outright for the production project: 0343's
 * trigger DDL locks every company's invoices until the rollback.
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… STOCK_CROSSCHECK_DB=1 \
 *     npx vitest run src/lib/stock-phase3-crosscheck.integration.test.ts --testTimeout=30000
 * After a run, scan for leaked rows (organizations/jobs/customers/invoices/stock_* named TEST,
 * created in the last hour); there should be none.
 */

const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER, STOCK_CROSSCHECK_DB, STOCK_CROSSCHECK_APPLY } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER && STOCK_CROSSCHECK_DB === "1" ? describe : describe.skip;
const PRODUCTION_REF = "rbpokaozcxqownollqlx";
const isProduction = `${TEST_DB_HOST ?? ""} ${TEST_DB_USER ?? ""}`.includes(PRODUCTION_REF);
if (STOCK_CROSSCHECK_APPLY === "1" && isProduction) {
  throw new Error("stock cross-check: STOCK_CROSSCHECK_APPLY=1 is refused on the production database. Apply 0343/0344 there as migrations, in a quiet window.");
}
const allowDdl = STOCK_CROSSCHECK_APPLY === "1" && !isProduction;

// ── the server runtime, replaced by the shim (hoisted: state is filled per step) ──
const state = vi.hoisted(() => ({
  client: null as any,
  server: null as any,
  member: null as any,
  afterCalls: [] as (() => unknown)[],
  pushes: [] as unknown[][],
  errors: [] as unknown[][],
}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => state.afterCalls.push(fn) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client, createServiceClient: () => state.server }));
vi.mock("@/lib/staff-guard", () => ({
  requireMember: async () => state.member,
  requireStaff: async () => (state.member?.staff ? state.member : { error: "This action is staff-only." }),
}));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: async (...a: unknown[]) => void state.pushes.push(a) }));
vi.mock("@/lib/observe", () => ({ reportError: (...a: unknown[]) => void state.errors.push(a) }));

import { takeFromStockAction, undoTakeAction } from "@/app/(app)/materials/stock-actions";
import { readJobStock, stockImportRows, stockKey, unclaimedTakes, markStock } from "./stock-billing";
import { billItemisation, shelfLotCost, type BillLine } from "./bill-itemisation";
import { jobMaterialCostFrom } from "./job-cost";
import { markupReading } from "./invoice-markup";
import { parseTakes, takeDoor } from "./stock-take";
import { LIVE_ORGS, mintThrowawayOrg } from "./throwaway-org.db-fixture";

const num = (v: unknown) => Number(v);
const cents = (n: number) => Math.round(n * 100) / 100;
const IDENT = /^[a-z_][a-z0-9_]*$/;
const COLS = /^[a-z_][a-z0-9_]*(\s*,\s*[a-z_][a-z0-9_]*)*$|^\*$/;

d("Shop Stock Phase 3 cross-check: a crew take, its bell, its bill, its Undo, its void (0343 + 0344)", () => {
  let c: pg.Client;
  let ready = false;
  let orgId = "";
  let techId = "";
  let techName = "";
  let staffId = "";
  let seq = 0;

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  const as = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  const asServer = async () => {
    await c.query("reset role");
    await c.query("select set_config('request.jwt.claims', '', true)");
  };
  const refusal = async (fn: () => Promise<unknown>): Promise<string | null> => {
    await c.query("savepoint attempt");
    try {
      await fn();
      await c.query("release savepoint attempt");
      return null;
    } catch (e: any) {
      await c.query("rollback to savepoint attempt");
      return String(e?.message ?? e);
    }
  };

  /**
   * A PostgREST-shaped client over the one connection, speaking as `uid` (or as the service role
   * when uid is null). Only the calls these doors make: from().select/insert/update + eq/neq/is/in +
   * maybeSingle, and rpc(). Every call runs in its own savepoint, so a refusal comes back as
   * { error } (as PostgREST returns it) and never aborts the test's transaction.
   */
  const client = (uid: string | null) => {
    const run = async (sql: string, params: unknown[]) => {
      await c.query("savepoint shim");
      try {
        if (uid) await as(uid);
        else await asServer();
        const r = await c.query(sql, params);
        await c.query("release savepoint shim");
        await asServer();
        return { rows: r.rows, error: null as any };
      } catch (e: any) {
        await c.query("rollback to savepoint shim");
        await asServer();
        return { rows: null as any, error: { message: String(e?.message ?? e), code: e?.code, details: e?.detail ?? null, hint: e?.hint ?? null } };
      }
    };
    const from = (table: string) => {
      if (!IDENT.test(table)) throw new Error(`shim: table ${table}`);
      let mode: "select" | "insert" | "update" = "select";
      let cols = "*";
      let returning: string | null = null;
      let rows: Record<string, unknown>[] = [];
      let patch: Record<string, unknown> = {};
      let single = false;
      const where: string[] = [];
      const params: unknown[] = [];
      const col = (k: string) => {
        if (!IDENT.test(k)) throw new Error(`shim: column ${k}`);
        return k;
      };
      const q: any = {
        select(s = "*") {
          const t = s.trim();
          if (!COLS.test(t)) throw new Error(`shim: select ${s}`);
          if (mode === "select") cols = t;
          else returning = t;
          return q;
        },
        insert(r: Record<string, unknown> | Record<string, unknown>[]) {
          mode = "insert";
          rows = Array.isArray(r) ? r : [r];
          return q;
        },
        update(p: Record<string, unknown>) {
          mode = "update";
          patch = p;
          return q;
        },
        eq(k: string, v: unknown) {
          params.push(v);
          where.push(`${col(k)} = $${params.length}`);
          return q;
        },
        neq(k: string, v: unknown) {
          params.push(v);
          where.push(`${col(k)} is distinct from $${params.length}`);
          return q;
        },
        is(k: string, v: null) {
          if (v !== null) throw new Error("shim: is() takes null only");
          where.push(`${col(k)} is null`);
          return q;
        },
        in(k: string, v: unknown[]) {
          params.push(v);
          where.push(`${col(k)} = any ($${params.length})`);
          return q;
        },
        maybeSingle() {
          single = true;
          return q;
        },
        async exec() {
          let sql: string;
          const p = [...params];
          const w = where.length ? ` where ${where.join(" and ")}` : "";
          if (mode === "select") {
            sql = `select ${cols} from public.${table}${w}`;
          } else if (mode === "insert") {
            const keys = Object.keys(rows[0] ?? {}).map(col);
            const values = rows.map((r) => `(${keys.map((k) => (p.push(r[k]), `$${p.length}`)).join(", ")})`);
            sql = `insert into public.${table} (${keys.join(", ")}) values ${values.join(", ")}${returning ? ` returning ${returning}` : ""}`;
          } else {
            const sets = Object.keys(patch).map((k) => (p.push(patch[k]), `${col(k)} = $${p.length}`));
            // The patch's params come after the filters', so the filters' $n still hold.
            sql = `update public.${table} set ${sets.join(", ")}${w}${returning ? ` returning ${returning}` : ""}`;
          }
          const r = await run(sql, p);
          if (r.error) return { data: null, error: r.error };
          if (single) {
            if (r.rows.length > 1) return { data: null, error: { message: "shim: more than one row for maybeSingle" } };
            return { data: r.rows[0] ?? null, error: null };
          }
          return { data: mode === "select" || returning ? r.rows : null, error: null };
        },
        then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
          return q.exec().then(res, rej);
        },
      };
      return q;
    };
    const rpc = async (name: string, args: Record<string, unknown> = {}) => {
      if (!IDENT.test(name)) throw new Error(`shim: rpc ${name}`);
      const keys = Object.keys(args).map((k) => {
        if (!IDENT.test(k)) throw new Error(`shim: rpc arg ${k}`);
        return k;
      });
      const r = await run(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
      return r.error ? { data: null, error: r.error } : { data: r.rows[0]?.r ?? null, error: null };
    };
    return { from, rpc };
  };

  beforeAll(async () => {
    c = new pg.Client({ host: TEST_DB_HOST, port: 5432, user: TEST_DB_USER, password: TEST_DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
    await c.connect();
    await assertTestDatabase(c);
    await c.query("begin");
    await c.query("set local lock_timeout = '3s'");
    await c.query("set local statement_timeout = '15s'");
    const has = await one(
      `select to_regclass('public.stock_moves') is not null as ledger,
              to_regprocedure('public.guard_stock_piece_claim()') is not null as b0343,
              to_regprocedure('public.stock_takes_for_job(uuid)') is not null as b0344`,
    );
    if (!has.ledger) {
      console.warn("[stock cross-check] the shelf (0303) is not on this database; nothing to check.");
      return;
    }
    for (const [present, file] of [
      [has.b0343, "0343_a_piece_is_billed_once.sql"],
      [has.b0344, "0344_the_crew_reads_the_jobs_takes.sql"],
    ] as const) {
      if (present) continue;
      if (!allowDdl) {
        console.warn(`[stock cross-check] ${file} is not on this database, and this run may not apply DDL (never on production); nothing to check.`);
        return;
      }
      await c.query(readFileSync(fileURLToPath(new URL(`../../supabase/migrations/${file}`, import.meta.url)), "utf8"));
    }
    // ITS OWN COMPANY, in this transaction, rolled back with it: an owner (the office) and a tech.
    const fx = await mintThrowawayOrg(c, { label: "stock cross-check", techs: 1 });
    if (LIVE_ORGS.has(fx.orgId)) throw new Error("stock cross-check: refusing to write in a live company's org.");
    orgId = fx.orgId;
    techId = fx.techs[0].id;
    techName = fx.techs[0].name;
    staffId = fx.owner.id;
    state.server = client(null);
    ready = true;
  });

  afterAll(async () => {
    await c?.query("rollback").catch(() => undefined);
    await c?.end();
  });

  const speakAs = (who: "tech" | "office") => {
    const uid = who === "tech" ? techId : staffId;
    state.client = client(uid);
    state.member = { supabase: state.client, userId: uid, orgId, staff: who === "office", name: who === "tech" ? techName : "The Office" };
  };

  it("a tech's take counts on the job, rings the office, bills once at 11% as materials, holds Undo with the invoice's name, and a void lets it go", async () => {
    if (!ready) return;

    // ── fixtures, as the server: a job, its CED ticket with a 250 ft coil unused, the coil on the shelf ──
    const cust = (await one("insert into public.customers (org_id, name) values ($1, 'TEST Cross-check Customer') returning id", [orgId])).id as string;
    const jobNumber = `TEST-XC-${++seq}`;
    const job = (
      await one(
        `insert into public.jobs (org_id, customer_id, name, job_number, status, billing_type)
         values ($1, $2, 'TEST Cross-check', $3, 'in_progress', 'tm') returning id`,
        [orgId, cust, jobNumber],
      )
    ).id as string;
    const lines = [
      { description: "TEST Flexbox BH bar hanger ground", amount: 8.82, quantity: 1, billed_amount: null as number | null, category: "Electrical" },
      { description: "TEST NMB 12/2 w/gnd wire 250 ft coil", amount: 165.29, quantity: 250, billed_amount: 0, category: "Electrical" },
      { description: "TEST Flexbox single gang 16 cu in", amount: 8.9, quantity: 2, billed_amount: null, category: "Electrical" },
      { description: "TEST Tax at 9.000 percent", amount: 16.47, quantity: 1, billed_amount: null, category: "Tax" },
    ];
    const billAmount = cents(lines.reduce((s, l) => s + l.amount, 0));
    const bill = (
      await one(
        `insert into public.bills (org_id, job_id, supplier, bill_number, amount, bill_date, status)
         values ($1, $2, 'TEST CED', $3, $4, '2001-08-19', 'unpaid') returning id`,
        [orgId, job, `TEST-XC-BILL-${++seq}`, billAmount],
      )
    ).id as string;
    const lineIds: string[] = [];
    for (const [i, l] of lines.entries()) {
      lineIds.push(
        (
          await one(
            `insert into public.bill_line_items (org_id, bill_id, description, quantity, unit_price, amount, category, billable, billed_amount, sort_order)
             values ($1, $2, $3, $4, $5, $5, $6, true, $7, $8) returning id`,
            [orgId, bill, l.description, l.quantity, l.amount, l.category, l.billed_amount, i],
          )
        ).id,
      );
    }
    const billLines: (BillLine & { id: string })[] = lines.map((l, i) => ({ id: lineIds[i], ...l }));
    const itemName = `TEST 12/2 NM-B ${++seq}`;
    const item = (await one("insert into public.inventory_items (org_id, name, unit) values ($1, $2, 'ft') returning id", [orgId, itemName])).id as string;
    const lotCost = shelfLotCost(billLines[1], billLines);
    expect(lotCost).toBe(180.17);
    await as(staffId);
    await c.query("insert into public.stock_lots (org_id, item_id, kind, bill_line_id, pieces, unit, cost) values ($1, $2, 'line', $3, 250, 'ft', $4)", [orgId, item, lineIds[1], lotCost]);
    await asServer();
    const invNumber = `TEST-XC-INV-${++seq}`;
    const draft = async (n: string) =>
      (
        await one(
          `insert into public.invoices (org_id, job_id, customer_id, invoice_number, status, total, amount_paid)
           values ($1, $2, $3, $4, 'draft', 0, 0) returning id`,
          [orgId, job, cust, n],
        )
      ).id as string;
    const inv = await draft(invNumber);

    // ── 1. THE CREW'S TAKE, THROUGH THE REAL SERVER ACTION ──
    speakAs("tech");
    state.afterCalls.length = 0;
    const took = await takeFromStockAction({ itemId: item, jobId: job, qty: 60 });
    expect(took.ok, JSON.stringify(took)).toBe(true);
    if (!took.ok) return;
    expect(took).toMatchObject({ item: itemName, unit: "ft", qty: 60, short: 0 });
    expect(took.message.startsWith(`Took 60 ft of ${itemName} for `)).toBe(true);
    // No money in the answer, not even the lot's figures.
    expect(Object.keys(took).sort()).toEqual(["drawGroup", "item", "message", "ok", "onHand", "qty", "short", "unit"]);
    expect(JSON.stringify(took)).not.toMatch(/cost|price|180\.17|43\.24/i);
    const group = took.drawGroup;
    const moves = (await c.query("select id::text from public.stock_moves where draw_group = $1 and kind = 'draw' and org_id = $2 order by id", [group, orgId])).rows.map((r) => r.id as string);
    expect(moves.length).toBeGreaterThan(0);
    const src = await one("select distinct source, created_by from public.stock_moves where draw_group = $1", [group]);
    expect(src).toEqual({ source: "crew", created_by: techId });

    // ── 2. IT COUNTS ON THE JOB RIGHT AWAY ──
    const net = async () => {
      const r = await one("select off_shelf, from_shelf from public.job_shelf_net where org_id = $1 and job_id = $2", [orgId, job]);
      return { offShelf: num(r?.off_shelf ?? 0), fromShelf: num(r?.from_shelf ?? 0) };
    };
    expect(await net()).toEqual({ offShelf: 180.17, fromShelf: 43.24 });
    expect(jobMaterialCostFrom(billAmount, await net())).toBe(cents(billAmount - 180.17 + 43.24));

    // ── 3. IT RINGS THE OFFICE: one bell per office person, one push, after the answer ──
    expect(state.afterCalls).toHaveLength(1);
    await state.afterCalls[0]();
    expect(state.errors).toEqual([]);
    // Found by the TEST job's own door (every row in one transaction shares its created_at).
    const fresh = (
      await c.query(
        `select n.user_id, n.title, n.body, n.url, p.role
           from public.notifications n join public.profiles p on p.id = n.user_id
          where n.org_id = $1 and n.type = 'stock_taken' and n.url = $2`,
        [orgId, `/jobs/${job}?tab=materials`],
      )
    ).rows;
    expect(fresh.length).toBeGreaterThan(0);
    expect(new Set(fresh.map((b) => b.user_id)).size).toBe(fresh.length); // one bell each
    for (const b of fresh) {
      expect(["owner", "admin", "office"]).toContain(b.role);
      expect(b.user_id).not.toBe(techId);
      expect(b.title).toBe(`${techName} took 60 ft of ${itemName} for ${took.message.slice(`Took 60 ft of ${itemName} for `.length)}`.slice(0, 140));
      expect(b.url).toBe(`/jobs/${job}?tab=materials`);
    }
    expect(state.pushes).toHaveLength(1);
    expect(state.pushes[0][1]).toBe("assigned");

    // The crew reads its take on the job, no cost, with Undo.
    const takesAs = async (uid: string) => {
      await as(uid);
      const r = (await one("select public.stock_takes_for_job($1) as r", [job])).r;
      await asServer();
      return parseTakes(r);
    };
    let crew = await takesAs(techId);
    expect(crew).toHaveLength(1);
    expect(crew[0]).toMatchObject({ drawGroup: group, billedOn: null, canUndo: true });
    expect(takeDoor(crew[0])).toEqual({ kind: "undo" });

    // ── 4. THE OFFICE BILLS IT ONCE, AT THE INVOICE'S MARKUP, AS MATERIALS ──
    speakAs("office");
    const office = client(staffId);
    const plan = async (invoiceId: string, markup: number) => {
      const stock = await readJobStock(office, job);
      const claimed = new Set<string>(
        (
          await c.query(
            `select unnest(it.source_ids)::text as id from public.invoice_items it join public.invoices i on i.id = it.invoice_id
              where i.org_id = $1 and i.status <> 'void' and it.invoice_id <> $2`,
            [orgId, invoiceId],
          )
        ).rows.map((r) => r.id as string),
      );
      const split = unclaimedTakes(stock.takes, claimed);
      return { ...stockImportRows(split.free, markup), held: split.held, takes: stock.takes, shorts: stock.shorts };
    };
    const billRows = billItemisation({ id: bill, supplier: "TEST CED", amount: billAmount }, billLines, 11).map((r) => ({ ...r, source_ids: [bill] }));
    const importRows = async (invoiceId: string, rows: unknown[]) => {
      const r = await office.rpc("upsert_imported_invoice_items", { p_invoice_id: invoiceId, p_source: "costs", p_rows: JSON.stringify(rows) });
      expect(r.error).toBeNull();
      // The importer's own stamp (billing/actions.ts stampStockLinesMaterials), the same chain.
      const keys = (rows as { import_key: string }[]).map((x) => x.import_key).filter((k) => k.startsWith("stock:"));
      if (keys.length) {
        const s = await office
          .from("invoice_items")
          .update({ line_kind: "materials" })
          .eq("invoice_id", invoiceId)
          .eq("import_source", "costs")
          .in("import_key", keys)
          .is("line_kind", null)
          .select("id");
        expect(s.error).toBeNull();
      }
      return r.data as { inserted?: unknown; removed?: unknown };
    };
    const first = await plan(inv, 11);
    expect(first.shorts).toEqual([]);
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]).toMatchObject({ import_key: stockKey(group), description: `${itemName}, 60 ft`, quantity: 60, unit: "ft", unit_price: 0.8 });
    expect(markStock(43.24, 11)).toBe(48);
    await importRows(inv, [...billRows, ...first.rows]);
    const stockLine = async (invoiceId: string) =>
      one(
        `select description, quantity, unit, unit_price, line_total, source_ids::text[] as source_ids, line_kind, import_key, edited
           from public.invoice_items where invoice_id = $1 and import_key like 'stock:%'`,
        [invoiceId],
      );
    const line = await stockLine(inv);
    expect([line.description, num(line.quantity), line.unit, num(line.unit_price), num(line.line_total), line.line_kind, line.import_key]).toEqual([
      `${itemName}, 60 ft`,
      60,
      "ft",
      0.8,
      48,
      "materials",
      stockKey(group),
    ]);
    expect([...line.source_ids].sort()).toEqual(moves);

    // The invoice's own markup reads back as 11 with the take voting (keepInvoiceMarkup's reading).
    const invLines = (await c.query("select import_key, source_ids::text[] as source_ids, line_total, edited from public.invoice_items where invoice_id = $1", [inv])).rows;
    const dismissed = new Set<string>(((await one("select dismissed_import_keys from public.invoices where id = $1", [inv])).dismissed_import_keys ?? []) as string[]);
    const reading = markupReading({
      lines: invLines,
      dismissed,
      bills: [{ id: bill, amount: billAmount }],
      linesByBill: new Map([[bill, billLines]]),
      pos: [],
      takes: first.takes.map((t) => ({ group: t.group, moveIds: t.moveIds, cost: t.cost })),
    });
    expect(reading).toEqual({ kind: "one", pct: 11 });

    // Once: a re-import changes nothing, and a second draft on the job finds nothing to bill.
    const again = await plan(inv, 11);
    expect(again.rows).toEqual(first.rows);
    const second = await importRows(inv, [...billRows, ...again.rows]);
    expect([num(second.inserted), num(second.removed)]).toEqual([0, 0]);
    const inv2Number = `TEST-XC-INV-${++seq}`;
    const inv2 = await draft(inv2Number);
    const onSecond = await plan(inv2, 11);
    expect(onSecond.rows).toEqual([]);
    expect(onSecond.held.map((t) => t.group)).toEqual([group]);
    // And a hand-made claim of the same pieces is refused by 0343, in the office's word.
    await as(staffId);
    const handClaim = () =>
      c.query(
        `insert into public.invoice_items (org_id, invoice_id, description, quantity, unit_price, source_ids, import_source)
         values ($1, $2, 'TEST pieces', 1, 1, $3::uuid[], 'costs')`,
        [orgId, inv2, moves],
      );
    expect(await refusal(handClaim)).toBe(`materials already billed on ${invNumber}`);
    await asServer();

    // ── 5. UNDO IS HELD, WITH THE INVOICE'S NAME ──
    speakAs("tech");
    const held = await undoTakeAction(group, job);
    expect(held.ok).toBe(false);
    if (!held.ok) expect(held.error).toContain(`${invNumber} already bills these pieces`);
    crew = await takesAs(techId);
    expect(crew[0]).toMatchObject({ billedOn: invNumber, billedInvoiceId: null, canUndo: false });
    expect(takeDoor(crew[0])).toMatchObject({ kind: "billed", status: `Billed on ${invNumber}` });
    const officeView = await takesAs(staffId);
    expect(officeView[0]).toMatchObject({ billedOn: invNumber, billedInvoiceId: inv, canUndo: false });
    expect(takeDoor(officeView[0])).toMatchObject({ kind: "billed", label: `Take It Off ${invNumber} First` });
    expect(await net()).toEqual({ offShelf: 180.17, fromShelf: 43.24 });

    // ── 6. A VOID RELEASES IT ──
    const voided = await office.from("invoices").update({ status: "void" }).eq("id", inv).eq("org_id", orgId).select("id");
    expect(voided.error).toBeNull();
    expect(voided.data).toHaveLength(1);
    crew = await takesAs(techId);
    expect(crew[0]).toMatchObject({ billedOn: null, canUndo: true });
    expect((await plan(inv2, 11)).rows.map((r) => r.import_key)).toEqual([stockKey(group)]);
    speakAs("tech");
    const undone = await undoTakeAction(group, job);
    expect(undone).toEqual({ ok: true, message: "Undone: the pieces are back on the shelf." });
    expect(await takesAs(techId)).toEqual([]);
    expect((await net()).fromShelf).toBe(0);
    // The way back from void is shut: its pieces are on the shelf again.
    await as(staffId);
    expect(await refusal(() => c.query("update public.invoices set status = 'draft' where id = $1", [inv]))).toContain(
      "went back on the shelf, so it can't come back from void",
    );
    await asServer();

    // ── the shelf still adds up ──
    const problems = (await c.query("select problem, detail from public.stock_reconcile_problems where org_id = $1 and item_id = $2", [orgId, item])).rows;
    expect(problems).toEqual([]);
  });
});
