/**
 * A Supabase stand-in for the day readers (lib/schedule/day-busy, lib/schedule/open-times) that HONOURS
 * every filter they use: eq, neq, in, is, lt, lte, gt, gte, or (with and(...) groups), limit, and the
 * select list (a row comes back with ONLY the listed columns: the projection law). A filter it ignored
 * could never fail a test, so an unknown method throws instead of passing through.
 *
 * Every query is logged (table + filters) so a test can see each read named its company.
 * `failOn` makes a table's reads answer an error; `failWhen` fails only the reads it picks.
 */
type Row = Record<string, unknown>;
type Cond = (r: Row) => boolean;
export type LoggedQuery = { table: string; cols: string[]; filters: string[] };

function cmp(a: unknown, op: string, b: unknown): boolean {
  if (op === "is") return b === null || b === "null" ? a == null : a === b;
  if (a == null) return false;
  const x = String(a);
  const y = String(b);
  switch (op) {
    case "eq": return a === b || x === y;
    case "neq": return x !== y;
    case "lt": return x < y;
    case "lte": return x <= y;
    case "gt": return x > y;
    case "gte": return x >= y;
    default: throw new Error(`stand-in: unknown operator ${op}`);
  }
}

/** Split at top-level commas (not inside parentheses). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** PostgREST's or= grammar, as far as the readers use it: col.op.value, and(...), or(...). */
function parseOr(term: string): Cond {
  const t = term.trim();
  const group = /^(and|or)\((.*)\)$/.exec(t);
  if (group) {
    const parts = splitTop(group[2]).map(parseOr);
    return group[1] === "and" ? (r) => parts.every((p) => p(r)) : (r) => parts.some((p) => p(r));
  }
  const i = t.indexOf(".");
  const j = t.indexOf(".", i + 1);
  if (i < 0 || j < 0) throw new Error(`stand-in: cannot read or-term ${t}`);
  const col = t.slice(0, i);
  const op = t.slice(i + 1, j);
  const val = t.slice(j + 1);
  return (r) => cmp(r[col], op, val === "null" ? null : val);
}

export function makeDayStandIn(tables: Record<string, Row[]>, opts?: { failOn?: string[]; failWhen?: (q: LoggedQuery) => boolean }) {
  const log: LoggedQuery[] = [];
  const from = (table: string) => {
    const conds: Cond[] = [];
    const entry: LoggedQuery = { table, cols: [], filters: [] };
    let cap = Infinity;
    const run = () => {
      log.push(entry);
      if (opts?.failOn?.includes(table) || opts?.failWhen?.(entry)) return { data: null, error: { message: `${table} is down`, code: "XX000" } };
      const rows = (tables[table] ?? []).filter((r) => conds.every((c) => c(r))).slice(0, cap);
      const data = rows.map((r) => Object.fromEntries(entry.cols.map((c) => [c, r[c] ?? null])));
      return { data, error: null };
    };
    const add = (name: string, col: string, c: Cond, shown: unknown) => {
      conds.push(c);
      entry.filters.push(`${col}.${name}.${String(shown)}`);
      return b;
    };
    const b: Record<string, unknown> = {
      select(cols: string) {
        entry.cols = cols.split(",").map((c) => c.trim()).filter(Boolean);
        return b;
      },
      eq: (c: string, v: unknown) => add("eq", c, (r) => cmp(r[c], "eq", v), v),
      neq: (c: string, v: unknown) => add("neq", c, (r) => cmp(r[c], "neq", v), v),
      is: (c: string, v: unknown) => add("is", c, (r) => cmp(r[c], "is", v), v),
      lt: (c: string, v: unknown) => add("lt", c, (r) => cmp(r[c], "lt", v), v),
      lte: (c: string, v: unknown) => add("lte", c, (r) => cmp(r[c], "lte", v), v),
      gt: (c: string, v: unknown) => add("gt", c, (r) => cmp(r[c], "gt", v), v),
      gte: (c: string, v: unknown) => add("gte", c, (r) => cmp(r[c], "gte", v), v),
      in: (c: string, v: unknown[]) => add("in", c, (r) => v.some((x) => cmp(r[c], "eq", x)), v.join("|")),
      or: (expr: string) => add("or", "*", (r) => splitTop(expr).map(parseOr).some((p) => p(r)), expr),
      limit(n: number) {
        cap = n;
        entry.filters.push(`limit.${n}`);
        return b;
      },
      maybeSingle: async () => {
        const r = run();
        return { data: (r.data as Row[] | null)?.[0] ?? null, error: r.error };
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
    };
    return new Proxy(b, {
      get(target, key) {
        if (key in target) return target[key as string];
        if (typeof key === "symbol") return undefined;
        throw new Error(`stand-in: .${key}() is not honoured; extend the stand-in before using it`);
      },
    });
  };
  return { client: { from } as never, log };
}
