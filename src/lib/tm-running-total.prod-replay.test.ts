import { describe, it, expect } from "vitest";
import pg from "pg";
import { assertReadOnlyReplay } from "@/lib/db-guard";
import { jobBillsItsActuals } from "./invoice-import-rule";
import { unbilledWorkForJob, fixedBillingsNotYetNetted } from "./unbilled-work";
import { openDraftOnJob, openFigure, unbilledCardDoor } from "./actuals-draw";
import { finalFinishWords } from "./finish-job-words";
import { isDrawKind } from "./invoice-math";
import { formatCurrency } from "./utils";

/**
 * THE T&M RUNNING TOTAL, REPLAYED READ-ONLY AGAINST ET'S LIVE BOOKS (Erik, 2026-09-26: "i dont see
 * a running total anywhere on tao's job page"; "the only thing i was looking for was the amount
 * open"). For every Time & Material job it runs the page's own readers - unbilledWorkForJob,
 * openDraftOnJob, fixedBillingsNotYetNetted - and the card's own door (unbilledCardDoor, openFigure)
 * and prints what the Overview card would say ("Open: $X" and its button) and what Finish Job would
 * build. Nothing is written: the session is read-only (assertReadOnlyReplay) and every read below is
 * a SELECT pinned to ET's org.
 *
 * The readers take a Supabase client, so they run here on `readOnlyPostgrest`: a small PostgREST
 * look-alike over one pg connection that knows only SELECT (select lists with embedded tables,
 * eq / neq / in / is / overlaps / order / limit / maybeSingle). It pins every table that has an
 * org_id to ET's, because this connection bypasses RLS.
 */
// A PRODUCTION REPLAY (db-guard.ts): REPLAY_DB_* creds, opt-in, never in CI, read-only session.
//   REPLAY_DB_HOST=… REPLAY_DB_USER=… REPLAY_DBPW=… TM_REPLAY=1 npx vitest run <this file>
const { REPLAY_DBPW, REPLAY_DB_HOST, REPLAY_DB_USER, TM_REPLAY } = process.env;
const d = REPLAY_DBPW && REPLAY_DB_HOST && REPLAY_DB_USER && TM_REPLAY === "1" && !process.env.CI ? describe : describe.skip;

const ET = "60195593-2e18-4230-bc8e-7a32d36d038d";

// ── A read-only PostgREST look-alike ────────────────────────────────────────────────────────────

type Fk = { src: string; col: string; dst: string };
type Sel = { key: string; name: string; inner: boolean; hint: string | null; cols: Sel[] | null };

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function parseSelect(s: string): Sel[] {
  return splitTop(s || "*").map((item) => {
    const paren = item.indexOf("(");
    const head = paren >= 0 ? item.slice(0, paren) : item;
    const inner = paren >= 0 ? item.slice(paren + 1, item.lastIndexOf(")")) : null;
    const [alias, rest] = head.includes(":") ? head.split(":") : [null, head];
    const [nm, bang] = rest.split("!");
    return {
      key: (alias ?? nm).trim(),
      name: nm.trim(),
      inner: bang === "inner",
      hint: alias ? nm.trim() : null,
      cols: inner === null ? null : parseSelect(inner),
    };
  });
}

function readOnlyPostgrest(c: pg.Client) {
  let fks: Fk[] | null = null;
  const orgTables = new Map<string, boolean>();
  const loadMeta = async () => {
    if (fks) return;
    const r = await c.query(
      `select cl.relname as src, a.attname as col, cf.relname as dst
         from pg_constraint k
         join pg_class cl on cl.oid = k.conrelid
         join pg_class cf on cf.oid = k.confrelid
         join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1]
        where k.contype = 'f' and k.connamespace = 'public'::regnamespace`,
    );
    fks = r.rows as Fk[];
    const cols = await c.query(
      `select table_name from information_schema.columns where table_schema = 'public' and column_name = 'org_id'`,
    );
    for (const row of cols.rows) orgTables.set(String(row.table_name), true);
  };

  type Filter = { col: string; op: "eq" | "neq" | "in" | "is" | "overlaps"; val: unknown };
  const where = (table: string, filters: Filter[], params: unknown[]) => {
    const parts: string[] = [];
    const own = filters.filter((f) => !f.col.includes("."));
    if (orgTables.get(table) && !own.some((f) => f.col === "org_id")) own.push({ col: "org_id", op: "eq", val: ET });
    for (const f of own) {
      const col = `"${f.col}"`;
      if (f.op === "is") parts.push(f.val === null ? `${col} is null` : `${col} is ${f.val ? "true" : "false"}`);
      else {
        params.push(f.val);
        const p = `$${params.length}`;
        parts.push(f.op === "eq" ? `${col} = ${p}` : f.op === "neq" ? `${col} <> ${p}` : f.op === "in" ? `${col} = any(${p})` : `${col} && ${p}`);
      }
    }
    return parts.length ? ` where ${parts.join(" and ")}` : "";
  };
  const pass = (row: Record<string, unknown> | null, f: Filter, field: string) => {
    if (!row) return false;
    const v = row[field];
    if (f.op === "eq") return String(v) === String(f.val);
    if (f.op === "neq") return v !== null && String(v) !== String(f.val);
    if (f.op === "is") return f.val === null ? v === null : v === f.val;
    if (f.op === "in") return (f.val as unknown[]).map(String).includes(String(v));
    return false;
  };

  const embed = async (table: string, rows: Record<string, any>[], sel: Sel[]): Promise<Record<string, any>[]> => {
    for (const s of sel) {
      if (!s.cols) continue;
      // Many-to-one: this table's column (the hint, or the one FK to the named table) points there.
      const m2o = (fks ?? []).find((f) => f.src === table && (s.hint ? f.col === s.hint : f.dst === s.name));
      const o2m = m2o ? null : (fks ?? []).find((f) => f.src === s.name && f.dst === table);
      if (!m2o && !o2m) throw new Error(`replay shim: no relation ${table} → ${s.name}`);
      const target = m2o ? m2o.dst : s.name;
      const keys = [...new Set(rows.map((r) => (m2o ? r[m2o.col] : r.id)).filter((x) => x != null).map(String))];
      let related: Record<string, any>[] = [];
      if (keys.length) {
        const params: unknown[] = [keys];
        const w = where(target, [], params);
        const on = m2o ? `"id" = any($1)` : `"${o2m!.col}" = any($1)`;
        related = (await c.query(`select * from public."${target}"${w ? `${w} and ${on}` : ` where ${on}`}`, params)).rows;
        related = await embed(target, related, s.cols);
      }
      for (const r of rows) {
        if (m2o) {
          const hit = related.find((x) => String(x.id) === String(r[m2o.col])) ?? null;
          r[`__embed_${s.key}`] = hit ? project(hit, s.cols) : null;
        } else {
          r[`__embed_${s.key}`] = related.filter((x) => String(x[o2m!.col]) === String(r.id)).map((x) => project(x, s.cols!));
        }
      }
    }
    return rows;
  };
  const project = (row: Record<string, any>, sel: Sel[]): Record<string, any> => {
    const out: Record<string, any> = {};
    for (const s of sel) {
      if (s.name === "*") {
        for (const [k, v] of Object.entries(row)) if (!k.startsWith("__embed_")) out[k] = v;
      } else if (s.cols) out[s.key] = row[`__embed_${s.key}`];
      else out[s.key] = row[s.name];
    }
    return out;
  };

  const from = (table: string) => {
    let sel: Sel[] = parseSelect("*");
    const filters: Filter[] = [];
    const orders: { col: string; asc: boolean }[] = [];
    let lim: number | null = null;
    let one: "maybe" | "single" | null = null;
    const run = async () => {
      await loadMeta();
      const params: unknown[] = [];
      let sql = `select * from public."${table}"${where(table, filters, params)}`;
      if (orders.length) sql += ` order by ${orders.map((o) => `"${o.col}" ${o.asc ? "asc" : "desc"}`).join(", ")}`;
      const dotted = filters.filter((f) => f.col.includes("."));
      if (lim != null && !dotted.length) sql += ` limit ${lim}`;
      let rows = (await c.query(sql, params)).rows as Record<string, any>[];
      rows = await embed(table, rows, sel);
      // A filter on an embedded table: an !inner embed drops the row, any other nulls the embed.
      for (const f of dotted) {
        const [rel, field] = f.col.split(".");
        const s = sel.find((x) => x.key === rel);
        rows = rows.filter((r) => {
          const ok = pass(r[`__embed_${rel}`], f, field);
          if (!ok && !s?.inner) r[`__embed_${rel}`] = null;
          return ok || !s?.inner;
        });
      }
      if (lim != null && dotted.length) rows = rows.slice(0, lim);
      const data = rows.map((r) => project(r, sel));
      return one ? (data[0] ?? null) : data;
    };
    const exec = () => run().then((data) => ({ data, error: null }), (error) => ({ data: null, error }));
    const b: any = {
      select(cols?: string) { sel = parseSelect(cols ?? "*"); return b; },
      eq(col: string, val: unknown) { filters.push({ col, op: "eq", val }); return b; },
      neq(col: string, val: unknown) { filters.push({ col, op: "neq", val }); return b; },
      in(col: string, val: unknown[]) { filters.push({ col, op: "in", val }); return b; },
      is(col: string, val: unknown) { filters.push({ col, op: "is", val }); return b; },
      overlaps(col: string, val: unknown[]) { filters.push({ col, op: "overlaps", val }); return b; },
      order(col: string, o?: { ascending?: boolean }) { orders.push({ col, asc: o?.ascending !== false }); return b; },
      limit(n: number) { lim = n; return b; },
      maybeSingle() { one = "maybe"; return exec(); },
      single() { one = "single"; return exec(); },
      then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) { return exec().then(ok, bad); },
    };
    for (const m of ["insert", "update", "upsert", "delete", "rpc"]) b[m] = () => { throw new Error(`replay shim is read-only: ${m} on ${table}`); };
    return b;
  };
  return { from, rpc: () => { throw new Error("replay shim is read-only: rpc"); } };
}

// ── The replay ─────────────────────────────────────────────────────────────────────────────────

d("T&M running total and Finish Job, replayed read-only against ET's live books", () => {
  it("every T&M job: Open: $X, the card's door, and what Finish would build - writing nothing", async () => {
    const c = new pg.Client({
      host: REPLAY_DB_HOST,
      port: 5432,
      user: REPLAY_DB_USER,
      password: REPLAY_DBPW,
      database: "postgres",
      ssl: { rejectUnauthorized: false },
      // PostgREST's shapes: numbers for numeric, ISO strings for timestamps, dates as written.
      types: {
        getTypeParser: ((oid: number, format?: "text" | "binary") => {
          if (oid === 1700 || oid === 20) return (v: string) => Number(v);
          if (oid === 1184) return (v: string) => new Date(v).toISOString();
          if (oid === 1114) return (v: string) => new Date(`${v}Z`).toISOString();
          if (oid === 1082) return (v: string) => v;
          return pg.types.getTypeParser(oid, format);
        }) as typeof pg.types.getTypeParser,
      },
    });
    await c.connect();
    await assertReadOnlyReplay(c);
    try {
      await c.query("begin transaction read only");
      const sb = readOnlyPostgrest(c) as any;
      const jobs = (
        await c.query(
          `select j.id, j.job_number, j.name, j.status, j.billing_type,
                  (select count(*)::int from public.payment_milestones m where m.job_id = j.id and m.org_id = j.org_id) as milestones,
                  (select string_agg(q.quote_number || ' ' || q.status::text, ', ') from public.quotes q where q.job_id = j.id and q.org_id = j.org_id) as estimates
             from public.jobs j where j.org_id = $1 and j.billing_type = 'tm' order by j.job_number`,
          [ET],
        )
      ).rows;
      const cards: Record<string, any> = {};
      for (const j of jobs) {
        const invs = (
          await c.query(
            "select id, invoice_number, invoice_kind::text as kind, status::text as status, total from public.invoices where org_id = $1 and job_id = $2 and status <> 'void' order by created_at",
            [ET, j.id],
          )
        ).rows;
        const rule = jobBillsItsActuals(j.billing_type, j.milestones);
        if (!rule) {
          cards[j.job_number] = { card: "none (a payment schedule)" };
          continue;
        }
        const w = await unbilledWorkForJob(sb, j.id, { orgId: ET });
        const drawBilled = invs.some((i) => isDrawKind(i.kind));
        // The page reads the open draft only when some invoice is a draft, and the deposit to net
        // only when the job carries a draw - exactly as here.
        const draft = invs.some((i) => i.status === "draft") ? await openDraftOnJob(sb, j.id) : null;
        const lump = drawBilled ? await fixedBillingsNotYetNetted(sb, j.id) : 0;
        const takes = w.stockCount ?? 0;
        const newWork = Math.round((w.laborAmount + w.billsBilled + (w.stockBilled ?? 0)) * 100) / 100;
        const workPending = w.hours > 0 || w.billsCount > 0 || takes > 0;
        const door = unbilledCardDoor({ openDraft: draft, workPending, returns: w.returnsCount ?? 0, total: w.total, newWork, lumpToNet: lump, drawBilled, money: formatCurrency });
        // "ALREADY BILLED" THAT READS AS "OPEN" (review, 2026-09-26: J-039's INV-060 billed three Ace
        // receipts on one Materials line whose source_ids claim only one, so the other two read as
        // $145.75 open on a paid job). A claimed materials line that bills more than the bills it
        // names, priced at the job's markup, holds receipts it doesn't claim: flagged for a person.
        const overclaimed = (
          await c.query(
            `select i.invoice_number, i.status::text as status, ii.line_total::float8 as line_total,
                    count(b.id)::int as bills_named, coalesce(sum(b.amount), 0)::float8 as bills_cost
               from public.invoice_items ii
               join public.invoices i on i.id = ii.invoice_id
               left join public.bills b on b.org_id = i.org_id and b.id::text = any(ii.source_ids::text[])
              where i.org_id = $1 and i.job_id = $2 and i.status <> 'void' and ii.import_source = 'costs'
              group by i.invoice_number, i.status, ii.id, ii.line_total`,
            [ET, j.id],
          )
        ).rows
          .filter((r) => r.bills_named > 0 && Number(r.line_total) > Number(r.bills_cost) * (1 + (w.markupPct ?? 0) / 100) + 1)
          .map((r) => `${r.invoice_number} (${r.status}): a Materials line of ${formatCurrency(Number(r.line_total))} claims ${r.bills_named} bill(s) worth ${formatCurrency(Number(r.bills_cost) * (1 + (w.markupPct ?? 0) / 100))} at ${w.markupPct}%`);
        if (overclaimed.length) console.warn(`[tm-replay] ${j.job_number}: a claimed line bills more than it claims - its "Open" may be already billed: ${overclaimed.join("; ")}`);
        const finishDoor = unbilledCardDoor({ openDraft: draft, workPending, returns: 0, total: w.total, newWork, lumpToNet: lump, drawBilled, money: formatCurrency });
        cards[j.job_number] = {
          job: `${j.job_number} ${j.name} (${j.status})`,
          estimates: j.estimates,
          bills: invs.map((i) => `${i.invoice_number} ${i.kind} ${i.status} ${formatCurrency(Number(i.total))}`).join(", "),
          open: `Open: ${formatCurrency(openFigure(door, w.total))}`,
          button: door ? ("label" in door ? `${door.label} [${door.kind}]` : `(no button) ${door.note}`) : "(no button)",
          note: door && "note" in door ? door.note ?? null : null,
          unbilled: { hours: w.hours, labor: w.laborAmount, bills: w.billsCount, billsBilled: w.billsBilled, takes, returns: w.returnsCount, total: w.total },
          deposit_to_net: lump,
          ...(overclaimed.length ? { overclaimed } : {}),
          finish: workPending && finishDoor ? finalFinishWords(finishDoor, draft, w.total > 0.005 ? w.total : newWork).line : "no unbilled work: finishes as before",
        };
      }
      console.log(`[tm-replay] ${JSON.stringify(cards, null, 2)}`);

      // Tao J-002: complete, everything on a bill - the card is there now, and it says $0.00 open.
      expect(cards["J-002"].open).toBe("Open: $0.00");
      expect(cards["J-002"].button).toBe("(no button)");
      // Every T&M job carries the card (no ET T&M job is on a schedule).
      expect(Object.values(cards).every((x) => x.open)).toBe(true);
      const ro = (await c.query("show transaction_read_only")).rows[0].transaction_read_only;
      expect(ro).toBe("on");
    } finally {
      await c.query("rollback").catch(() => undefined);
      await c.end();
    }
  }, 120_000);
});
