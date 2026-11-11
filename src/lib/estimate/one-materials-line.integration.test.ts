import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { assertTestDatabase } from "@/lib/db-guard";
import { mintThrowawayOrg } from "@/lib/throwaway-org.db-fixture";
import { ESTIMATE_FORMATS, estimateFormatFor, normalizeDocStyle, type EstimateFormat } from "@/lib/doc-style";
import { coerceTaskDetail, laborMoney, paperBreakdown, partMoney, taskMoney, type PaperBreakdown } from "@/lib/estimate/task-lines";
import type { TaskDetail, TaskDetailMaterial, TaskLabor } from "@/lib/estimate/line-map";

/**
 * ONE MATERIALS LINE UNDER EACH TASK (0408; cn-v1158 — Erik, 2026-11-10: "an option to group the
 * materials into one materials line as im finding that different people require different
 * solutions"), proven on the database it lives on, inside ONE transaction that is always rolled back:
 *
 *   the twin     public.task_parts_total answers every breakdown exactly as the app's
 *                taskMoney(detail).parts does — 2.5 × $1.99 is $4.98, a part with no name is not
 *                counted, a null count or price is nothing, twenty parts, every half cent;
 *   the check    quotes.estimate_format takes tasks, detailed, grouped or null, and refuses any other
 *                word, under the one check found by what it reads;
 *   the door     public_quote resolves the format the way lib/doc-style estimateFormatFor does (the
 *                estimate's own word, else the company's, else tasks), says the word on the quote, and
 *                ships: under tasks no breakdown; under detailed a line's breakdown with exactly the
 *                keys it had before 0408; under grouped the same labor, an EMPTY parts list and one
 *                figure — and no part's name, cost or code, no person's id, anywhere in the answer;
 *   who may call the customer's link (anon) reads a grouped estimate through public_quote, and nobody
 *                outside the database can call task_parts_total itself.
 *   the page     each line the door ships is handed, AS IT ARRIVED, to the one decision the customer's
 *                page makes with it (lib/estimate/task-lines paperBreakdown, the call components/
 *                quote-document makes), and what comes back is what the page prints: the labor rows,
 *                the parts or the one Materials figure, or nothing. The suite used to add the wire's
 *                labor to its figure by hand and compare that to the price, so a change to how the
 *                page reads the wire could not have failed it. It proves the page now, not its own sum.
 *
 * 0408 is applied here ONLY when it is not on the database yet: swapping the check takes a lock on
 * quotes that is then held until the rollback. Erik applies 0408 on the test database before the
 * deploy, so on CI that branch is skipped and the suite reads the functions as they are deployed; on
 * a database without it the file runs TWICE (a first run, then the second run it promises is safe).
 *
 * One TEST company, one TEST customer and their estimates, minted inside the transaction
 * (throwaway-org.db-fixture.ts). Never run outside CI by hand; it skips without the test database's
 * credentials.
 *   TEST_DB_HOST=… TEST_DB_USER=… TEST_DBPW=… npx vitest run --project db src/lib/estimate/one-materials-line.integration.test.ts
 */
const { TEST_DBPW, TEST_DB_HOST, TEST_DB_USER } = process.env;
const d = TEST_DBPW && TEST_DB_HOST && TEST_DB_USER ? describe : describe.skip;
const M0408 = fileURLToPath(new URL("../../../supabase/migrations/0408_one_materials_line_under_each_task.sql", import.meta.url));

// ── The breakdowns the twin is asked about ──────────────────────────────────────────────────────
const part = (name: string, qty: number | null, sell: number | null, extra: Partial<TaskDetailMaterial> = {}): TaskDetailMaterial => ({
  code: null,
  name,
  qty,
  cost: null,
  sell,
  ...extra,
});
const row = (hours: number | null, rate: number, extra: Partial<TaskLabor> = {}): TaskLabor => ({ label: null, person_id: null, hours, rate, rate_from: "rule", ...extra });
const breakdown = (materials: TaskDetailMaterial[], labor: TaskLabor[] = []): TaskDetail => ({ task_id: "TESTTASKID-twin", labor, units: null, kit_id: null, materials });
/** WHAT THE CUSTOMER'S PAGE PRINTS UNDER ONE LINE, and nothing it does not: the sub-heading, each labor
 *  bullet's label, hours, rate and money, each part's name, count and money, the one Materials figure.
 *  Null = the page prints nothing under the line. (The same reading task-lines-paper.test.ts takes
 *  of a breakdown; the money beside each bullet is the paper's own, laborMoney and partMoney.) */
const printed = (b: PaperBreakdown | null) =>
  b && {
    perUnit: b.perUnit,
    labor: b.labor.map((r) => [r.label, r.hours, r.rate, laborMoney(r)]),
    parts: b.parts.map((m) => [m.name, m.qty, m.qty !== null && m.sell !== null ? partMoney(m) : null]),
    materials: b.materials,
  };
/** A printed breakdown's bullets, added the way a customer adds them: each figure as printed, in whole cents. */
const bulletCents = (p: NonNullable<ReturnType<typeof printed>>): number =>
  [...p.labor.map((r) => r[3]), ...p.parts.map((m) => m[2]), p.materials].reduce<number>((t, n) => t + Math.round(Number(n ?? 0) * 100), 0);

/** A tab and a no-break space, spelled by number so no editor can swap them for something else. */
const TAB = String.fromCharCode(9);
const NBSP = String.fromCharCode(160);

/** AS THE APP HOLDS THEM: typed breakdowns, asked of taskMoney directly. `want` is said in figures
 *  where the wave named the case, so the two sides cannot agree on a wrong answer together. */
const TWIN: { why: string; detail: TaskDetail; want?: number }[] = [
  { why: "2.5 × $1.99 is $4.98 (the float product says $4.97)", detail: breakdown([part("TESTPART Strap", 2.5, 1.99)]), want: 4.98 },
  {
    why: "each part is rounded first, then summed (0.91 + 4.98 + 0.50 + 3.99)",
    detail: breakdown([part("TESTPART Wire nut", 7, 0.13), part("TESTPART Strap", 2.5, 1.99), part("TESTPART Tape", 1.5, 0.33), part("TESTPART Anchor", 3, 1.33)]),
    want: 10.38,
  },
  { why: "a part with no name is not counted", detail: breakdown([part("", 3, 10), part("TESTPART Anchor", 3, 1.33)]), want: 3.99 },
  { why: "a name of spaces, a tab or a no-break space is no name", detail: breakdown([part("   ", 1, 5), part(TAB, 1, 5), part(`${NBSP} `, 1, 5)]), want: 0 },
  { why: "a name with space around it is a name", detail: breakdown([part(`${TAB} TESTPART Bolt ${NBSP}`, 2, 3)]), want: 6 },
  { why: "a null count is nothing", detail: breakdown([part("TESTPART Tape", null, 9)]), want: 0 },
  { why: "a null price is nothing", detail: breakdown([part("TESTPART Tape", 3, null)]), want: 0 },
  { why: "a null count and a null price are nothing, beside a part that is priced", detail: breakdown([part("TESTPART Tape", null, null), part("TESTPART Bolt", 4, 2.5)]), want: 10 },
  { why: "a count of zero and a price of zero are nothing", detail: breakdown([part("TESTPART Free", 0, 12), part("TESTPART Gift", 5, 0)]), want: 0 },
  { why: "no parts is nothing", detail: breakdown([]), want: 0 },
  { why: "what the labor comes to is not in it", detail: breakdown([part("TESTPART Anchor", 3, 1.33)], [row(4, 145), row(2.5, 65, { label: "Helper" })]), want: 3.99 },
  { why: "a part's cost and code change nothing", detail: breakdown([part("TESTPART Strap", 2.5, 1.99, { code: "TESTCODE-1", cost: 0.5, from_kit: true })]), want: 4.98 },
  {
    why: "twenty parts",
    detail: breakdown(Array.from({ length: 20 }, (_, i) => part(`TESTPART ${i + 1}`, (5 + 45 * i) / 100, (99 + 137 * i) / 100))),
  },
  { why: "big figures stay exact", detail: breakdown([part("TESTPART Switchgear", 1234.56, 9876.54)]), want: 12193181.22 },
  // Every one of these lands exactly on a half cent, where a float product and a decimal can part.
  ...[
    [0.05, 0.1],
    [0.15, 0.1],
    [0.5, 0.01],
    [0.5, 0.03],
    [1.5, 0.33],
    [2.5, 0.01],
    [2.5, 1.99],
    [0.25, 0.02],
    [3.5, 0.07],
    [12.5, 0.13],
  ].map(([qty, sell]) => ({ why: `a half cent: ${qty} × ${sell}`, detail: breakdown([part("TESTPART Half", qty, sell)]) })),
];

/** AS THE DATABASE MAY HOLD THEM: shapes no door writes, asked of the app's one reader first
 *  (coerceTaskDetail), because that is what every paper does before it adds anything up. */
const READER: { why: string; raw: unknown; want: number }[] = [
  { why: "a figure below zero is a hole", raw: { materials: [{ name: "TESTPART Credit", qty: -2, sell: 5 }, { name: "TESTPART Bolt", qty: 2, sell: -5 }, { name: "TESTPART Anchor", qty: 1, sell: 2 }] }, want: 2 },
  { why: "a list that is not a list", raw: { materials: "none" }, want: 0 },
  { why: "no list at all", raw: { labor: [{ label: null, hours: 2, rate: 145 }] }, want: 0 },
  { why: "an entry that is not a part", raw: { materials: [null, 7, "x", [1], { name: "TESTPART Anchor", qty: 1, sell: 2 }] }, want: 2 },
  { why: "a name that is not a string", raw: { materials: [{ name: 7, qty: 1, sell: 5 }, { name: null, qty: 1, sell: 5 }, { qty: 1, sell: 5 }] }, want: 0 },
  { why: "the pre-1131 shape (one hours figure) with a part", raw: { task_id: "x", hours: 3, rate: 120, hours_from_kit: true, units: null, kit_id: null, materials: [{ code: "C", name: "TESTPART Old bolt", qty: 4, cost: 1, sell: 2.5 }] }, want: 10 },
];

d("0408: one Materials line under each task", () => {
  let c: pg.Client;
  let orgId = "";
  let ownerId = "";
  let quoteId = "";
  let token = "";
  let draftToken = "";

  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  /** PostgREST's own mechanism: the person's claims under the authenticated role. */
  const as = async (uid: string) => {
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
    await c.query("set local role authenticated");
  };
  /** Someone holding the link and nothing else: the anon key, no session. */
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
  const refused = async (who: "anon" | "server" | { uid: string }, sql: string, params: unknown[] = []): Promise<string | null> => {
    await c.query("savepoint attempt");
    try {
      if (who === "anon") await asAnon();
      else if (who !== "server") await as(who.uid);
      await c.query(sql, params);
      return null;
    } catch (e) {
      return String((e as { code?: string }).code ?? e);
    } finally {
      await c.query("rollback to savepoint attempt");
      await asServer();
    }
  };

  // ── What the estimate holds ───────────────────────────────────────────────────────────────────
  /** A task line as the builder stores it: two labor rows (one naming a person) and four parts. */
  const stored = () => ({
    task: {
      task_id: "TESTTASKID-0408-A",
      kit_id: "TESTKITID-0408-A",
      units: 2,
      labor: [
        { label: null, person_id: ownerId, hours: 4, rate: 145, rate_from: "rule" },
        { label: "TESTLABEL Helper", person_id: null, hours: 2.5, rate: 65, rate_from: "hand", from_kit: true },
      ],
      materials: [
        { code: "TESTCODE-STRAP", name: "TESTPART Strap", qty: 2.5, cost: 7711.31, sell: 1.99, from_kit: true },
        { code: "TESTCODE-NUT", name: "TESTPART Wire nut", qty: 7, cost: 7722.32, sell: 0.13 },
        { code: null, name: "TESTPART Tape", qty: 1.5, cost: 7733.33, sell: 0.33 },
        { code: "TESTCODE-ANCHOR", name: "TESTPART Anchor", qty: 3, cost: 7744.34, sell: 1.33 },
      ],
    },
    /** A task whose one part nobody has counted or priced: there is no Materials figure to ship. */
    unpriced: {
      task_id: "TESTTASKID-0408-B",
      kit_id: null,
      units: null,
      labor: [{ label: null, person_id: null, hours: 1, rate: 100, rate_from: "rule" }],
      materials: [{ code: null, name: "TESTPART Unpriced", qty: null, cost: null, sell: null }],
    },
    /** A line saved before cn-v1131: one hours figure, no labor rows. */
    legacy: {
      task_id: "TESTTASKID-0408-C",
      hours: 3,
      rate: 120,
      hours_from_kit: true,
      units: null,
      kit_id: null,
      materials: [{ code: "TESTCODE-OLD", name: "TESTPART Old bolt", qty: 4, cost: 7755.35, sell: 2.5 }],
    },
    /** Not a breakdown at all: a list where an object belongs. */
    junk: ["TESTJUNK not a breakdown"],
  });
  /** Everything of the company's that must never reach the customer's link, under any format. */
  const secrets = () => [
    ownerId,
    "TESTCODE",
    "TESTTASKID",
    "TESTKITID",
    "TESTJUNK",
    "7711.31",
    "7722.32",
    "7733.33",
    "7744.34",
    "7755.35",
    '"cost"',
    '"code"',
    '"person_id"',
    '"task_id"',
    '"kit_id"',
    '"rate_from"',
    '"from_kit"',
    '"hours_from_kit"',
  ];

  type Wire = {
    quote: Record<string, unknown>;
    items: { description: string; quantity: number; unit_price: number; line_total: number; detail: Record<string, unknown> | null }[];
    org: Record<string, unknown> | null;
  };
  /** The answer as the database wrote it (the text) and as the page reads it (parsed). */
  const read = async (tok: string): Promise<{ raw: string; j: Wire } | null> => {
    const raw = (await one("select public.public_quote($1)::text as raw", [tok])).raw as string | null;
    return raw === null ? null : { raw, j: JSON.parse(raw) as Wire };
  };
  /** Set the estimate's own word and the company's Doc Studio word together; both writes are read back. */
  const setFormats = async (own: string | null, company: string | undefined) => {
    const docStyle = company === undefined ? { density: "airy" } : { density: "airy", estimate_format: company };
    const wrote = await one(
      `with o as (update public.organizations
                     set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{doc_style}', $2::jsonb, true)
                   where id = $1 returning 1),
            q as (update public.quotes set estimate_format = $4::text where id = $3 and org_id = $1 returning 1)
       select (select count(*) from o)::int as orgs, (select count(*) from q)::int as quotes`,
      [orgId, JSON.stringify(docStyle), quoteId, own],
    );
    expect(wrote).toEqual({ orgs: 1, quotes: 1 });
    return docStyle;
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
    const carried = (await one("select to_regprocedure('public.task_parts_total(jsonb)') is not null as ok")).ok === true;
    if (!carried) {
      const sql = readFileSync(M0408, "utf8");
      await c.query(sql); // a first run: the ground check, the swap, both functions, the self-check
      await c.query(sql); // and the second run the file says is safe
      console.warn("[one-materials-line] 0408 was applied inside this suite's transaction (twice: it is twice-safe) and is rolled back with it.");
    }

    const org = await mintThrowawayOrg(c, { label: "0408 one materials line", techs: 0 });
    orgId = org.orgId;
    ownerId = org.owner.id;
    const cust = (
      await one(
        "insert into public.customers (org_id, name, type, status, address, city, state, zip, created_by) values ($1, 'TEST Dana Rook', 'residential', 'active', '14 TEST Larkspur Way', 'Thistlewood', 'CA', '96100', $2) returning id::text as id",
        [orgId, ownerId],
      )
    ).id as string;
    token = `test-0408-${randomUUID()}`;
    draftToken = `test-0408-draft-${randomUUID()}`;
    quoteId = (
      await one("insert into public.quotes (org_id, customer_id, title, status, public_token, created_by) values ($1, $2, 'TEST one materials line', 'sent', $3, $4) returning id::text as id", [
        orgId,
        cust,
        token,
        ownerId,
      ])
    ).id as string;
    await c.query("insert into public.quotes (org_id, customer_id, title, status, public_token, created_by) values ($1, $2, 'TEST still a draft', 'draft', $3, $4)", [orgId, cust, draftToken, ownerId]);

    const s = stored();
    const priced = (detail: unknown) => taskMoney(coerceTaskDetail(detail)!).total;
    const lines: [string, number, number, unknown][] = [
      ["TEST task line", 2, priced(s.task), s.task],
      ["TEST task with nothing priced", 1, priced(s.unpriced), s.unpriced],
      ["TEST plain line", 1, 25, null],
      ["TEST line with a breakdown that is not one", 1, 40, s.junk],
      ["TEST line from before labor rows", 1, priced(s.legacy), s.legacy],
    ];
    for (const [i, [description, quantity, unitPrice, detail]] of lines.entries()) {
      await c.query(
        "insert into public.quote_line_items (org_id, quote_id, description, quantity, unit, unit_price, sort_order, detail) values ($1, $2, $3, $4, 'ea', $5, $6, $7::jsonb)",
        [orgId, quoteId, description, quantity, unitPrice, i, detail === null ? null : JSON.stringify(detail)],
      );
    }
  });

  afterAll(async () => {
    try {
      await c?.query("rollback");
    } finally {
      await c?.end();
    }
  });

  it("task_parts_total answers every breakdown as taskMoney(detail).parts does", async () => {
    const asked = [...TWIN.map((k) => k.detail as unknown), ...READER.map((k) => k.raw)];
    const rows = (
      await c.query(
        "select (e.ord - 1)::int as i, public.task_parts_total(e.d)::text as total from jsonb_array_elements($1::jsonb) with ordinality as e(d, ord) order by e.ord",
        [JSON.stringify(asked)],
      )
    ).rows as { i: number; total: string }[];
    expect(rows.map((r) => r.i)).toEqual(asked.map((_, i) => i));

    for (const [i, k] of TWIN.entries()) {
      const app = taskMoney(k.detail).parts;
      expect({ why: k.why, sql: Number(rows[i].total) }).toEqual({ why: k.why, sql: app });
      if (k.want !== undefined) expect({ why: k.why, app }).toEqual({ why: k.why, app: k.want });
    }
    for (const [n, k] of READER.entries()) {
      const asRead = coerceTaskDetail(k.raw);
      expect(asRead, k.why).not.toBeNull();
      expect({ why: k.why, app: taskMoney(asRead!).parts }).toEqual({ why: k.why, app: k.want });
      expect({ why: k.why, sql: Number(rows[TWIN.length + n].total) }).toEqual({ why: k.why, sql: k.want });
    }
    // Twenty parts really are twenty, and the half cents really are halves.
    expect(TWIN.find((k) => k.why === "twenty parts")!.detail.materials).toHaveLength(20);
    for (const k of TWIN.filter((x) => x.why.startsWith("a half cent"))) {
      const m = k.detail.materials[0];
      expect((Math.round(m.qty! * 100) * Math.round(m.sell! * 100)) % 100, k.why).toBe(50);
    }
    // No breakdown at all is nothing, never an error.
    const none = await one("select public.task_parts_total(null)::text as a, public.task_parts_total('[]'::jsonb)::text as b, public.task_parts_total('\"x\"'::jsonb)::text as c");
    expect([Number(none.a), Number(none.b), Number(none.c)]).toEqual([0, 0, 0]);
  });

  it("the column takes the three words and null, and refuses any other, under the one check on it", async () => {
    // Every check on quotes with the columns it reads; the ones that read estimate_format are picked
    // out here, so this does not lean on the way the migration itself looks for the check.
    const all = (
      await c.query(
        `select c.conname::text as name, pg_get_constraintdef(c.oid) as def, c.convalidated as validated,
                (select array_agg(a.attname::text order by a.attname) from pg_attribute a
                  where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) as columns
           from pg_constraint c
          where c.conrelid = 'public.quotes'::regclass and c.contype = 'c'`,
      )
    ).rows as { name: string; def: string; validated: boolean; columns: string[] | null }[];
    const checks = all.filter((r) => (r.columns ?? []).includes("estimate_format") || /estimate_format/.test(r.def));
    expect(checks).toHaveLength(1);
    expect(checks[0].columns).toEqual(["estimate_format"]);
    expect(checks[0].name).toBe("quotes_estimate_format_check");
    expect(checks[0].validated).toBe(true);
    expect([...checks[0].def.matchAll(/'([^']*)'/g)].map((m) => m[1]).sort()).toEqual([...ESTIMATE_FORMATS].sort());

    for (const word of [...ESTIMATE_FORMATS, null]) {
      expect(await refused("server", "update public.quotes set estimate_format = $2::text where id = $1", [quoteId, word]), String(word)).toBeNull();
    }
    for (const word of ["bogus", "Grouped", "", "materials"]) {
      expect(await refused("server", "update public.quotes set estimate_format = $2::text where id = $1", [quoteId, word]), JSON.stringify(word)).toBe("23514");
    }
  });

  it("the format is the estimate's own word, else the company's, else tasks — the app's reader and the database agree on every pair", async () => {
    for (const own of [null, ...ESTIMATE_FORMATS]) {
      for (const company of [undefined, ...ESTIMATE_FORMATS, "bogus"]) {
        const docStyle = await setFormats(own, company);
        const got = await read(token);
        const pair = `own ${String(own)}, company ${String(company)}`;
        expect(got, pair).not.toBeNull();
        const word = got!.j.quote.estimate_format;
        // The twin of lib/doc-style: the one reader every office paper resolves the format through.
        expect({ pair, word }).toEqual({ pair, word: estimateFormatFor({ estimate_format: own }, normalizeDocStyle(docStyle)) });
        expect({ pair, word }).toEqual({ pair, word: own ?? (ESTIMATE_FORMATS as readonly string[]).find((f) => f === company) ?? "tasks" });
        // What rides follows the word, whichever side it came from.
        const first = got!.j.items[0].detail;
        if (word === "tasks") expect(got!.j.items.every((it) => it.detail === null), pair).toBe(true);
        else expect(Object.keys(first ?? {}).sort(), pair).toEqual(word === "grouped" ? ["hours", "labor", "materials", "materials_total", "rate", "units"] : ["hours", "labor", "materials", "rate", "units"]);
      }
    }
  });

  it("tasks: no breakdown rides, and nothing of one is in the answer", async () => {
    for (const [own, company] of [
      ["tasks", "detailed"],
      [null, "tasks"],
    ] as const) {
      await setFormats(own, company);
      const { raw, j } = (await read(token))!;
      expect(j.quote.estimate_format).toBe("tasks");
      expect(j.items.map((it) => it.description)).toEqual(["TEST task line", "TEST task with nothing priced", "TEST plain line", "TEST line with a breakdown that is not one", "TEST line from before labor rows"]);
      expect(j.items.map((it) => it.detail)).toEqual([null, null, null, null, null]);
      for (const leak of [...secrets(), "TESTPART", "TESTLABEL", '"labor"', '"materials"', '"materials_total"', '"hours"', '"rate"']) expect(raw, leak).not.toContain(leak);
    }
  });

  it("detailed: a line's breakdown has exactly the keys it had before 0408 — labor rows and each part's name, count and sell", async () => {
    for (const [own, company] of [
      ["detailed", "grouped"],
      [null, "detailed"],
    ] as const) {
      await setFormats(own, company);
      const { raw, j } = (await read(token))!;
      const pair = `own ${String(own)}, company ${company}`;
      expect(j.quote.estimate_format, pair).toBe("detailed");
      // The built task line: key for key, row for row, part for part, in stored order.
      expect(j.items[0].detail, pair).toEqual({
        hours: null,
        rate: null,
        units: 2,
        labor: [
          { label: null, hours: 4, rate: 145 },
          { label: "TESTLABEL Helper", hours: 2.5, rate: 65 },
        ],
        materials: [
          { name: "TESTPART Strap", qty: 2.5, sell: 1.99 },
          { name: "TESTPART Wire nut", qty: 7, sell: 0.13 },
          { name: "TESTPART Tape", qty: 1.5, sell: 0.33 },
          { name: "TESTPART Anchor", qty: 3, sell: 1.33 },
        ],
      });
      expect(j.items[1].detail, pair).toEqual({ hours: null, rate: null, units: null, labor: [{ label: null, hours: 1, rate: 100 }], materials: [{ name: "TESTPART Unpriced", qty: null, sell: null }] });
      expect(j.items[2].detail, pair).toBeNull(); // a plain line has none
      expect(j.items[3].detail, pair).toBeNull(); // nor does one whose breakdown is not an object
      expect(j.items[4].detail, pair).toEqual({ hours: 3, rate: 120, units: null, labor: [], materials: [{ name: "TESTPART Old bolt", qty: 4, sell: 2.5 }] });
      // Not one key more: the one figure belongs to grouped alone.
      expect(raw, pair).not.toContain("materials_total");
      for (const leak of secrets()) expect(raw, `${pair}: ${leak}`).not.toContain(leak);

      // WHAT THE PAGE PRINTS FROM IT: every line as it arrived, through the page's own decision.
      const page = j.items.map((line) => printed(paperBreakdown(line, "detailed")));
      expect(page, pair).toEqual([
        // Two of the task, so the bullets are for one of it: "For each one:" stands above them.
        {
          perUnit: true,
          labor: [
            [null, 4, 145, 580],
            ["TESTLABEL Helper", 2.5, 65, 162.5],
          ],
          parts: [
            ["TESTPART Strap", 2.5, 4.98],
            ["TESTPART Wire nut", 7, 0.91],
            ["TESTPART Tape", 1.5, 0.5],
            ["TESTPART Anchor", 3, 3.99],
          ],
          materials: null,
        },
        // The part nobody counted or priced is listed by name with no figure; the labor is the whole price.
        { perUnit: false, labor: [[null, 1, 100, 100]], parts: [["TESTPART Unpriced", null, null]], materials: null },
        null, // a plain line prints nothing beneath it
        null, // nor does one whose breakdown is not one
        // A line from before labor rows: its one hours figure reads as one labor bullet.
        { perUnit: false, labor: [[null, 3, 120, 360]], parts: [["TESTPART Old bolt", 4, 10]], materials: null },
      ]);
      // The bullets the customer can add up come to each line's unit price, to the cent.
      for (const i of [0, 1, 4]) expect(bulletCents(page[i]!), `${pair}: line ${i}`).toBe(Math.round(Number(j.items[i].unit_price) * 100));
    }
  });

  it("grouped: the same labor, an empty parts list and ONE figure — no part's name, cost or code, no person's id, anywhere in the answer", async () => {
    const s = stored();
    for (const [own, company] of [
      ["grouped", "tasks"],
      [null, "grouped"],
    ] as const) {
      await setFormats(own, company);
      const { raw, j } = (await read(token))!;
      const pair = `own ${String(own)}, company ${company}`;
      expect(j.quote.estimate_format, pair).toBe("grouped");

      expect(j.items[0].detail, pair).toEqual({
        hours: null,
        rate: null,
        units: 2,
        labor: [
          { label: null, hours: 4, rate: 145 },
          { label: "TESTLABEL Helper", hours: 2.5, rate: 65 },
        ],
        materials: [],
        materials_total: 10.38,
      });
      // The figure is the app's own, for ONE of the task (the line's Qty of 2 is not in it).
      expect(j.items[0].detail!.materials_total, pair).toBe(taskMoney(coerceTaskDetail(s.task)!).parts);
      // Nothing priced: no figure, never a zero.
      expect(j.items[1].detail, pair).toEqual({ hours: null, rate: null, units: null, labor: [{ label: null, hours: 1, rate: 100 }], materials: [], materials_total: null });
      expect(j.items[2].detail, pair).toBeNull();
      expect(j.items[3].detail, pair).toBeNull();
      // A line from before labor rows keeps its one hours figure, and its parts are one figure too.
      expect(j.items[4].detail, pair).toEqual({ hours: 3, rate: 120, units: null, labor: [], materials: [], materials_total: 10 });

      // THE WIRE, AS TEXT: the figure is there, and no part behind it is.
      expect(raw, pair).toContain('"materials_total"');
      for (const leak of [...secrets(), "TESTPART", '"qty"', '"sell"']) expect(raw, `${pair}: ${leak}`).not.toContain(leak);
      // The labor still reads (his label, never who), and the customer and the letterhead are untouched.
      expect(raw, pair).toContain("TESTLABEL Helper");
      expect(raw, pair).toContain("TEST Dana Rook");

      // WHAT THE PAGE PRINTS FROM IT: every line as it arrived goes through the page's own decision
      // (paperBreakdown, the call components/quote-document makes with the wire's item). Its adds-up
      // gate is inside that call, so a breakdown coming back at all is the page saying the labor and
      // the one figure explain the line's unit price; a change to how it reads the wire fails HERE.
      const page = j.items.map((line) => printed(paperBreakdown(line, "grouped")));
      // The one figure on each grouped line is the parts' total of the detail the office STORED.
      const figure = { task: taskMoney(coerceTaskDetail(s.task)!).parts, legacy: taskMoney(coerceTaskDetail(s.legacy)!).parts };
      expect(figure, pair).toEqual({ task: 10.38, legacy: 10 });
      expect(page, pair).toEqual([
        // Two of the task: "For each one:", the same two labor bullets a detailed paper prints, NO part
        // by name, and one Materials figure.
        {
          perUnit: true,
          labor: [
            [null, 4, 145, 580],
            ["TESTLABEL Helper", 2.5, 65, 162.5],
          ],
          parts: [],
          materials: figure.task,
        },
        // Nothing priced: the labor bullet alone, and no Materials bullet at all (never a "$0.00").
        { perUnit: false, labor: [[null, 1, 100, 100]], parts: [], materials: null },
        null, // a plain line prints nothing beneath it
        null, // nor does one whose breakdown is not one
        // A line from before labor rows: one labor bullet from its one hours figure, and the one figure.
        { perUnit: false, labor: [[null, 3, 120, 360]], parts: [], materials: figure.legacy },
      ]);
      // The bullets the customer can add up come to each line's unit price, to the cent.
      for (const i of [0, 1, 4]) expect(bulletCents(page[i]!), `${pair}: line ${i}`).toBe(Math.round(Number(j.items[i].unit_price) * 100));
      // And the office's own row answers the same: the page and the print page cannot part ways on a grouped line.
      const office = [s.task, s.unpriced, null, s.junk, s.legacy].map((detail, i) => printed(paperBreakdown({ quantity: j.items[i].quantity, unit_price: j.items[i].unit_price, detail }, "grouped")));
      expect(page, pair).toEqual(office);
    }
  });

  it("the customer's link reads a grouped estimate; nobody outside the database calls task_parts_total", async () => {
    await setFormats("grouped", undefined);
    const privileges = await one(
      `select has_function_privilege('anon', 'public.task_parts_total(jsonb)', 'execute') as total_anon,
              has_function_privilege('authenticated', 'public.task_parts_total(jsonb)', 'execute') as total_authed,
              has_function_privilege('anon', 'public.public_quote(text)', 'execute') as quote_anon,
              has_function_privilege('authenticated', 'public.public_quote(text)', 'execute') as quote_authed,
              (select p.prosecdef from pg_proc p where p.oid = 'public.public_quote(text)'::regprocedure) as quote_definer,
              (select p.provolatile::text from pg_proc p where p.oid = 'public.public_quote(text)'::regprocedure) as quote_volatility,
              (select p.prosecdef from pg_proc p where p.oid = 'public.task_parts_total(jsonb)'::regprocedure) as total_definer,
              (select p.provolatile::text from pg_proc p where p.oid = 'public.task_parts_total(jsonb)'::regprocedure) as total_volatility,
              (select count(*)::int from pg_proc p where p.proname = 'task_parts_total' and p.pronamespace = 'public'::regnamespace) as totals`,
    );
    expect(privileges).toEqual({
      total_anon: false,
      total_authed: false,
      quote_anon: true,
      quote_authed: true,
      quote_definer: true,
      quote_volatility: "s",
      total_definer: false,
      total_volatility: "i",
      totals: 1,
    });
    // Called directly, the helper is refused: permission denied, for the link and for a signed-in owner.
    expect(await refused("anon", "select public.task_parts_total('{}'::jsonb)")).toBe("42501");
    expect(await refused({ uid: ownerId }, "select public.task_parts_total('{}'::jsonb)")).toBe("42501");

    // Through the door it is reached: public_quote runs as its owner. As anon, and as a signed-in person.
    for (const who of ["anon", "owner"] as const) {
      await c.query("savepoint through_the_door");
      try {
        if (who === "anon") await asAnon();
        else await as(ownerId);
        const got = (await read(token))!;
        expect(got.j.quote.estimate_format, who).toBe("grouped");
        expect(got.j.items[0].detail!.materials_total, who).toBe(10.38);
        expect(got.j.items[0].detail!.materials, who).toEqual([]);
      } finally {
        await c.query("rollback to savepoint through_the_door");
        await asServer();
      }
    }
  });

  it("the door's gate is where it was: a draft, or a token nobody holds, is answered with nothing", async () => {
    expect(await read(draftToken)).toBeNull();
    expect(await read(`test-0408-nobody-${randomUUID()}`)).toBeNull();
    expect(await read(token)).not.toBeNull();
  });
});
