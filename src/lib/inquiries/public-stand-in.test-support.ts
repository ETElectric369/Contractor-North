/**
 * A STAND-IN SERVICE CLIENT FOR THE PUBLIC DOORS' TESTS (cn-v1180). The public doors run on the
 * service client, which has no RLS, so the only thing keeping one company's rows from another's is
 * the filters the code writes by hand. A stand-in that ignored them would pass a door that names no
 * company; this one HONOURS eq / neq / is / in / gt / gte / lt / lte / order / limit on reads, updates,
 * deletes and the read-back of an insert, and returns only the columns a select lists (a column the
 * read forgot is absent, as PostgREST would leave it). Every read and write is logged with its filters.
 * `opts.fail` makes a chosen call answer with an error (and write nothing), for the failure paths.
 * Not honoured, and so never to be leaned on: `or` (no door that uses this stand-in calls it).
 *
 * Not a test file itself (no `.test.` before the extension the runner looks for): the tests beside
 * create-triaged-inquiry, public-schedule and the /inquire action import it.
 */
export type Row = Record<string, unknown>;

/** The top-level names a select asks for: "a, b, rel(x, y)" -> a, b, rel. */
function selected(cols: string): string[] {
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
  return out.map((c) => c.replace(/\(.*$/s, "").replace(/!.*$/, "").trim());
}

type Op = "select" | "insert" | "update" | "delete";
export type Logged = { table: string; op: Op; filters: string[]; patch?: Row; rows?: Row[] };

export function standIn(
  tables: Record<string, Row[]>,
  rpcs: Record<string, (args: Row) => { data?: unknown; error?: unknown }> = {},
  opts: { fail?: (table: string, op: Op, filters: string[]) => boolean } = {},
) {
  const log: Logged[] = [];
  let seq = 0;
  const from = (table: string) => {
    const preds: ((r: Row) => boolean)[] = [];
    const filters: string[] = [];
    const orders: [string, boolean][] = [];
    let cols: string | null = null;
    let lim = Infinity;
    let op: Op = "select";
    let patch: Row | null = null;
    let inserted: Row[] = [];
    const project = (r: Row) => (cols && cols !== "*" ? Object.fromEntries(selected(cols).filter((n) => n in r).map((n) => [n, r[n]])) : { ...r });
    const run = (): { data: Row[] | null; error: unknown } => {
      const t = (tables[table] ??= []);
      if (opts.fail?.(table, op, filters)) {
        log.push({ table, op, filters });
        return { data: null, error: { message: `stand-in: ${op} on ${table} failed` } };
      }
      if (op === "insert") {
        t.push(...inserted);
        log.push({ table, op, filters, rows: inserted });
        return { data: cols ? inserted.map(project) : null, error: null };
      }
      let rows = t.filter((r) => preds.every((p) => p(r)));
      if (op === "delete") {
        tables[table] = t.filter((r) => !rows.includes(r));
        log.push({ table, op, filters, rows });
        return { data: cols ? rows.map(project) : null, error: null };
      }
      if (op === "update") {
        for (const r of rows) Object.assign(r, patch);
        log.push({ table, op, filters, patch: patch ?? {}, rows });
        return { data: cols ? rows.map(project) : null, error: null };
      }
      for (const [c, asc] of [...orders].reverse()) {
        rows = [...rows].sort((a, b) => (String(a[c]) < String(b[c]) ? -1 : String(a[c]) > String(b[c]) ? 1 : 0) * (asc ? 1 : -1));
      }
      log.push({ table, op, filters });
      return { data: rows.slice(0, lim).map(project), error: null };
    };
    const q: any = {
      select(c?: string) {
        cols = c ?? "*";
        return q;
      },
      insert(v: Row | Row[]) {
        op = "insert";
        const now = new Date().toISOString();
        inserted = (Array.isArray(v) ? v : [v]).map((r) => ({ id: `${table}-new-${++seq}`, created_at: now, updated_at: now, ...r }));
        return q;
      },
      delete() {
        op = "delete";
        return q;
      },
      update(p: Row) {
        op = "update";
        patch = p;
        return q;
      },
      eq(c: string, v: unknown) {
        filters.push(`${c}=${v}`);
        preds.push((r) => r[c] === v);
        return q;
      },
      neq(c: string, v: unknown) {
        filters.push(`${c}!=${v}`);
        preds.push((r) => r[c] !== v);
        return q;
      },
      in(c: string, vs: unknown[]) {
        filters.push(`${c} in`);
        preds.push((r) => vs.includes(r[c]));
        return q;
      },
      is(c: string, v: null) {
        filters.push(`${c} is ${v}`);
        preds.push((r) => (v === null ? r[c] == null : r[c] === v));
        return q;
      },
      gte(c: string, v: string) {
        filters.push(`${c}>=${v}`);
        preds.push((r) => r[c] != null && String(r[c]) >= v);
        return q;
      },
      gt(c: string, v: string) {
        filters.push(`${c}>${v}`);
        preds.push((r) => r[c] != null && String(r[c]) > v);
        return q;
      },
      lt(c: string, v: string) {
        filters.push(`${c}<${v}`);
        preds.push((r) => r[c] != null && String(r[c]) < v);
        return q;
      },
      lte(c: string, v: string) {
        filters.push(`${c}<=${v}`);
        preds.push((r) => r[c] != null && String(r[c]) <= v);
        return q;
      },
      order(c: string, o?: { ascending?: boolean }) {
        orders.push([c, o?.ascending !== false]);
        return q;
      },
      limit(n: number) {
        lim = n;
        return q;
      },
      async maybeSingle() {
        const r = run();
        return { data: r.data?.[0] ?? null, error: r.error };
      },
      async single() {
        const r = run();
        return r.data?.length === 1 ? { data: r.data[0], error: null } : { data: null, error: { message: "not one row" } };
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(run()).then(resolve, reject);
      },
    };
    return q;
  };
  const rpc = async (name: string, args: Row) => {
    const h = rpcs[name];
    if (!h) return { data: null, error: { message: `no rpc ${name}` } };
    const r = h(args);
    return { data: r.data ?? null, error: r.error ?? null };
  };
  return { client: { from, rpc } as any, log, tables };
}
