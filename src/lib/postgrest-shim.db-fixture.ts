/**
 * A POSTGREST-SHAPED CLIENT OVER ONE pg CONNECTION, for a DB suite that runs a REAL server action
 * (the stock cross-check's pattern, stock-phase3-crosscheck.integration.test.ts, made reusable).
 *
 * The action gets this in place of the Supabase client (its requireStaff / createClient are mocked to
 * hand it over). Every call runs as `uid` exactly as PostgREST does (set local role authenticated +
 * request.jwt.claims, the setting auth.uid() reads), or as the server when uid is null, inside its own
 * savepoint: a refusal comes back as { error } the way PostgREST returns it, and never aborts the
 * suite's one transaction, which the suite always rolls back.
 *
 * Only what the doors under test call: from().select / insert / update / delete, the filters eq, neq,
 * is, in, gt, gte, lt, lte, or, order (nullsFirst either way), limit, range, maybeSingle, single, one
 * level of embedding for the relations named in EMBEDS, and rpc(). Numbers, dates and timestamps come
 * back as PostgREST sends them (a number, 'YYYY-MM-DD', an ISO string) when the client uses PG_TYPES.
 *
 * It never connects: the calling *.integration.test.ts does, and calls assertTestDatabase first.
 */

export interface ShimSql {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

export type ShimError = { message: string; code?: string; details?: string | null; hint?: string | null };

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** The comparison words PostgREST spells inside an `or(...)`, and the SQL they mean. */
const OR_OPS: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

/** Split an or()/and() body on its TOP-LEVEL commas, so a nested `and(a,b)` stays one term. */
function splitArms(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((a) => a.trim()).filter(Boolean);
}

/** pg's type parsers for the suite's Client, so a row reads as PostgREST's JSON would: numeric and
 *  bigint as numbers, date / timestamp / timestamptz as their text. */
export const PG_TYPES = {
  getTypeParser(oid: number, format?: "text" | "binary") {
    if (format === "binary") return (v: unknown) => v;
    switch (oid) {
      case 20: // int8
      case 1700: // numeric
        return (v: string) => (v === null ? null : Number(v));
      case 1082: // date
      case 1114: // timestamp
      case 1184: // timestamptz
        return (v: string) => v;
      case 114: // json
      case 3802: // jsonb
        return (v: string) => (v === null ? null : JSON.parse(v));
      case 16: // bool
        return (v: string) => v === "t" || v === "true";
      case 21: // int2
      case 23: // int4
      case 700: // float4
      case 701: // float8
        return (v: string) => (v === null ? null : Number(v));
      default:
        return (v: string) => v;
    }
  },
};

/** The relations one level of embedding may name: a child (its rows point at this row) or a parent
 *  (this row points at it), each with the column that joins them. */
const EMBEDS: Record<string, Record<string, { kind: "child" | "parent"; column: string }>> = {
  bills: { bill_line_items: { kind: "child", column: "bill_id" }, jobs: { kind: "parent", column: "job_id" } },
  appointments: { customers: { kind: "parent", column: "customer_id" }, inquiries: { kind: "parent", column: "inquiry_id" }, jobs: { kind: "parent", column: "job_id" } },
  jobs: { customers: { kind: "parent", column: "customer_id" } },
  stock_moves: { inventory_items: { kind: "parent", column: "item_id" }, jobs: { kind: "parent", column: "job_id" } },
  supplier_payments: { supplier_accounts: { kind: "parent", column: "supplier_account_id" } },
};

/** A value as a pg parameter for a filter or a column: objects and arrays of objects go as JSON text
 *  (a jsonb column casts it); a non-empty list of plain values stays a Postgres array (= any(...), a
 *  uuid[] column). */
function param(v: unknown): unknown {
  if (v === undefined) return null;
  if (v === null || typeof v !== "object" || v instanceof Date) return v;
  if (Array.isArray(v) && v.length > 0 && v.every((x) => x === null || typeof x !== "object")) return v;
  return JSON.stringify(v);
}

/** A function argument: PostgREST hands every object and array to a function as JSON (a jsonb
 *  argument), the empty list included, which a Postgres array literal ('{}') would turn into {}. */
function rpcParam(v: unknown): unknown {
  if (v === undefined) return null;
  if (v === null || typeof v !== "object" || v instanceof Date) return v;
  return JSON.stringify(v);
}

/** Split "a, b, rel(c, d)" on its top-level commas. */
function topLevel(cols: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of cols) {
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

function projection(table: string, cols: string): string {
  const t = cols.trim();
  if (!t || t === "*") return "t.*";
  return topLevel(t)
    .map((part) => {
      const embed = part.match(/^([a-z_][a-z0-9_]*)\s*\(([^()]*)\)$/);
      if (!embed) {
        if (!IDENT.test(part)) throw new Error(`shim: column ${part} on ${table}`);
        return `t.${part}`;
      }
      const [, rel, inner] = embed;
      const how = EMBEDS[table]?.[rel];
      if (!how) throw new Error(`shim: no embed ${rel} on ${table}`);
      const fields = inner.split(",").map((s) => s.trim()).filter(Boolean);
      for (const f of fields) if (!IDENT.test(f)) throw new Error(`shim: embedded column ${f}`);
      const obj = `json_build_object(${fields.map((f) => `'${f}', e.${f}`).join(", ")})`;
      return how.kind === "child"
        ? `coalesce((select json_agg(${obj}) from public.${rel} e where e.${how.column} = t.id), '[]'::json) as ${rel}`
        : `(select ${obj} from public.${rel} e where e.id = t.${how.column}) as ${rel}`;
    })
    .join(", ");
}

/** One call at a time per connection: an action's reads side by side (Promise.all) would otherwise
 *  interleave their savepoints and roles, and a query could run as the wrong person. */
const queues = new WeakMap<ShimSql, Promise<unknown>>();

export function postgrestShim(c: ShimSql, uid: string | null) {
  const claims = uid ? JSON.stringify({ sub: uid, role: "authenticated" }) : "";
  const role = uid ? "authenticated" : "none";
  const asServer = () => c.query("select set_config('request.jwt.claims', '', true), set_config('role', 'none', true)");
  const runNow = async (sql: string, params: unknown[]): Promise<{ rows: any[] | null; error: ShimError | null }> => {
    await c.query("savepoint shim");
    try {
      await c.query("select set_config('request.jwt.claims', $1, true), set_config('role', $2, true)", [claims, role]);
      const r = await c.query(sql, params);
      await c.query("release savepoint shim");
      await asServer();
      return { rows: r.rows, error: null };
    } catch (e: any) {
      await c.query("rollback to savepoint shim");
      await asServer();
      return { rows: null, error: { message: String(e?.message ?? e), code: e?.code, details: e?.detail ?? null, hint: e?.hint ?? null } };
    }
  };
  const run = (sql: string, params: unknown[]) => {
    const next = (queues.get(c) ?? Promise.resolve()).then(() => runNow(sql, params));
    queues.set(c, next.catch(() => undefined));
    return next;
  };

  const from = (table: string) => {
    if (!IDENT.test(table)) throw new Error(`shim: table ${table}`);
    let mode: "select" | "insert" | "update" | "delete" = "select";
    let cols = "*";
    let returning: string | null = null;
    let rows: Record<string, unknown>[] = [];
    let patch: Record<string, unknown> = {};
    let single: "maybe" | "one" | null = null;
    const where: string[] = [];
    const params: unknown[] = [];
    const order: string[] = [];
    let limit: number | null = null;
    let offset: number | null = null;
    const col = (k: string) => {
      if (!IDENT.test(k)) throw new Error(`shim: column ${k}`);
      return `t.${k}`;
    };
    const cmp = (op: string) => (k: string, v: unknown) => {
      params.push(v);
      where.push(`${col(k)} ${op} $${params.length}`);
      return q;
    };
    const q: any = {
      select(s = "*") {
        if (mode === "select") cols = s;
        else returning = s;
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
      delete() {
        mode = "delete";
        return q;
      },
      eq: cmp("="),
      neq: (k: string, v: unknown) => {
        params.push(v);
        where.push(`${col(k)} is distinct from $${params.length}`);
        return q;
      },
      gt: cmp(">"),
      gte: cmp(">="),
      lt: cmp("<"),
      lte: cmp("<="),
      is(k: string, v: null | boolean) {
        where.push(`${col(k)} is ${v === null ? "null" : v ? "true" : "false"}`);
        return q;
      },
      /**
       * PostgREST's `or=(...)`: the arms the client passes as one string, translated whole. The
       * ranked-pool cut (lib/six-rank rankPoolCut) is exactly this shape, so a suite can run the REAL
       * query the app sends instead of a hand-written copy of it.
       */
      or(filters: string) {
        const arm = (a: string): string => {
          const nested = /^(and|or)\((.*)\)$/s.exec(a);
          if (nested) {
            const join = nested[1] === "and" ? " and " : " or ";
            return `(${splitArms(nested[2]).map(arm).join(join)})`;
          }
          const m = /^([a-z_][a-z0-9_]*)\.([a-z]+)\.(.*)$/s.exec(a);
          if (!m) throw new Error(`shim: or arm ${a}`);
          const [, k, op, raw] = m;
          if (op === "is") {
            if (raw === "null") return `${col(k)} is null`;
            if (raw === "true" || raw === "false") return `${col(k)} is ${raw}`;
            throw new Error(`shim: or is.${raw}`);
          }
          const sql = OR_OPS[op];
          if (!sql) throw new Error(`shim: or op ${op}`);
          params.push(raw);
          return `${col(k)} ${sql} $${params.length}`;
        };
        where.push(`(${splitArms(filters).map(arm).join(" or ")})`);
        return q;
      },
      in(k: string, v: unknown[]) {
        params.push(v);
        where.push(`${col(k)} = any ($${params.length})`);
        return q;
      },
      /** PostgREST's not: .not(col, "is", null) and .not(col, "in", "(a,b)"). */
      not(k: string, op: string, v: unknown) {
        if (op === "is" && v === null) where.push(`${col(k)} is not null`);
        else if (op === "in") {
          const list = String(v)
            .replace(/^\(|\)$/g, "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
          params.push(list);
          where.push(`not (${col(k)} = any ($${params.length}))`);
        } else throw new Error(`shim: not ${op}`);
        return q;
      },
      order(k: string, opts: { ascending?: boolean; nullsFirst?: boolean; referencedTable?: string } = {}) {
        if (opts.referencedTable) return q;
        // nullsFirst is three-valued the way PostgREST is: unset leaves Postgres's own default
        // (nulls last for asc, first for desc), true and false say so.
        const nulls = opts.nullsFirst === true ? " nulls first" : opts.nullsFirst === false ? " nulls last" : "";
        order.push(`${col(k)} ${opts.ascending === false ? "desc" : "asc"}${nulls}`);
        return q;
      },
      limit(n: number, opts: { referencedTable?: string } = {}) {
        if (!opts.referencedTable) limit = n;
        return q;
      },
      range(a: number, b: number) {
        offset = a;
        limit = b - a + 1;
        return q;
      },
      maybeSingle() {
        single = "maybe";
        return q;
      },
      single() {
        single = "one";
        return q;
      },
      async exec() {
        const p = [...params];
        const w = where.length ? ` where ${where.join(" and ")}` : "";
        let sql: string;
        if (mode === "select") {
          sql = `select ${projection(table, cols)} from public.${table} t${w}${order.length ? ` order by ${order.join(", ")}` : ""}${limit != null ? ` limit ${Number(limit)}` : ""}${offset != null ? ` offset ${Number(offset)}` : ""}`;
        } else if (mode === "insert") {
          const keys = Object.keys(rows[0] ?? {});
          for (const k of keys) if (!IDENT.test(k)) throw new Error(`shim: column ${k}`);
          const values = rows.map((r) => `(${keys.map((k) => (p.push(r[k]), `$${p.length}`)).join(", ")})`);
          sql = `insert into public.${table} as t (${keys.join(", ")}) values ${values.join(", ")}${returning ? ` returning ${projection(table, returning)}` : ""}`;
        } else if (mode === "update") {
          const sets = Object.keys(patch).map((k) => {
            if (!IDENT.test(k)) throw new Error(`shim: column ${k}`);
            p.push(patch[k]);
            return `${k} = $${p.length}`;
          });
          sql = `update public.${table} as t set ${sets.join(", ")}${w}${returning ? ` returning ${projection(table, returning)}` : ""}`;
        } else {
          sql = `delete from public.${table} as t${w}${returning ? ` returning ${projection(table, returning)}` : ""}`;
        }
        const r = await run(sql, p.map(param));
        if (r.error) return { data: null, error: r.error, count: null };
        const out = r.rows ?? [];
        if (single === "one") {
          if (out.length !== 1) return { data: null, error: { message: `JSON object requested, ${out.length} rows returned`, code: "PGRST116" }, count: null };
          return { data: out[0], error: null, count: null };
        }
        if (single === "maybe") {
          if (out.length > 1) return { data: null, error: { message: "JSON object requested, multiple rows returned", code: "PGRST116" }, count: null };
          return { data: out[0] ?? null, error: null, count: null };
        }
        return { data: mode === "select" || returning ? out : null, error: null, count: null };
      },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
        return q.exec().then(res, rej);
      },
    };
    return q;
  };

  /** A function's result the way PostgREST hands it back: a set-returning function's rows, or one value. */
  const rpc = async (name: string, args: Record<string, unknown> = {}) => {
    if (!IDENT.test(name)) throw new Error(`shim: rpc ${name}`);
    const keys = Object.keys(args);
    for (const k of keys) if (!IDENT.test(k)) throw new Error(`shim: rpc arg ${k}`);
    const call = `public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")})`;
    const sets = await run(
      "select p.proretset as sets from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1 limit 1",
      [name],
    );
    if (sets.error) return { data: null, error: sets.error };
    const setReturning = sets.rows?.[0]?.sets === true;
    const r = await run(setReturning ? `select * from ${call}` : `select ${call} as r`, keys.map((k) => rpcParam(args[k])));
    if (r.error) return { data: null, error: r.error };
    return { data: setReturning ? r.rows : (r.rows?.[0]?.r ?? null), error: null };
  };

  return { from, rpc };
}
