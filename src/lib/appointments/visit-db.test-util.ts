/**
 * A STAND-IN DATABASE THAT HONOURS WHAT IT IS ASKED (cn-v1181, lane I's tests). A read returns only the
 * rows its filters let through, only the columns its select list names (a column the table does not
 * have is an error, as PostgREST says it), with a to-one embed `table(cols)` read through `<table
 * singular>_id`; a write lands only on the rows its filters match and reads back exactly those. A
 * stand-in that ignores a filter or a select list is blind: this one is not.
 *
 * Supported: select (with { count, head }), insert, update, delete; eq, neq, in, is, not(col, "is",
 * null), gt, gte, lt, lte, order, limit, range; maybeSingle, single, then. `fail` makes a table's reads
 * or writes answer an error.
 */
export type Row = Record<string, any>;
export type Db = {
  tables: Record<string, Row[]>;
  /** Columns each table HAS (a select naming another is an error). Defaults to the keys of its rows. */
  columns?: Record<string, string[]>;
  fail?: { read?: Set<string>; write?: Set<string> };
  /** Every write, in order: table, op, the patch, the filters. */
  writes: { table: string; op: "insert" | "update" | "delete"; patch?: Row; filters: string[] }[];
};

/** The embed name to the base row's key: customers(name) reads customer_id; inquiries(...) inquiry_id. */
const FK: Record<string, string> = { customers: "customer_id", inquiries: "inquiry_id", jobs: "job_id" };

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function makeDb(tables: Record<string, Row[]>, columns?: Record<string, string[]>): Db {
  return { tables, columns, fail: { read: new Set(), write: new Set() }, writes: [] };
}

export function client(db: Db) {
  const colsOf = (table: string) => db.columns?.[table] ?? [...new Set((db.tables[table] ?? []).flatMap((r) => Object.keys(r)))];
  function project(table: string, row: Row, list: string): Row | { __error: string } {
    if (!list || list.trim() === "*") return { ...row };
    const out: Row = {};
    for (const part of splitTop(list)) {
      const m = /^(\w+)\((.*)\)$/.exec(part);
      if (m) {
        const [, rel, inner] = m;
        const fk = FK[rel];
        const target = fk ? (db.tables[rel] ?? []).find((r) => r.id === row[fk]) : undefined;
        if (!target) out[rel] = null;
        else {
          const p = project(rel, target, inner);
          if ("__error" in p) return p;
          out[rel] = p;
        }
        continue;
      }
      if (!colsOf(table).includes(part)) return { __error: `column ${table}.${part} does not exist` };
      out[part] = row[part] ?? null;
    }
    return out;
  }

  function from(table: string) {
    const preds: { desc: string; test: (r: Row) => boolean }[] = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let selectList = "";
    let count = false;
    let head = false;
    let patch: Row | null = null;
    let order: { col: string; asc: boolean } | null = null;
    let limit = Infinity;
    let offset = 0;
    const add = (desc: string, test: (r: Row) => boolean) => (preds.push({ desc, test }), b);
    const rows = () => db.tables[table] ?? (db.tables[table] = []);

    const run = (single: boolean) => {
      if (op === "select") {
        if (db.fail?.read?.has(table)) return { data: null, count: null, error: { message: `${table} read failed` } };
        let hit = rows().filter((r) => preds.every((p) => p.test(r)));
        if (order) {
          const { col, asc } = order;
          hit = [...hit].sort((a, c) => (a[col] === c[col] ? 0 : a[col] == null ? 1 : c[col] == null ? -1 : (a[col] < c[col] ? -1 : 1) * (asc ? 1 : -1)));
        }
        hit = hit.slice(offset, offset + limit);
        if (head) return { data: null, count: hit.length, error: null };
        const data: Row[] = [];
        for (const r of hit) {
          const p = project(table, r, selectList);
          if ("__error" in p) return { data: null, error: { message: p.__error } };
          data.push(p);
        }
        if (single) return { data: data[0] ?? null, error: null, ...(count ? { count: data.length } : {}) };
        return { data, error: null, ...(count ? { count: data.length } : {}) };
      }
      if (db.fail?.write?.has(table)) return { data: null, error: { message: `${table} write failed` } };
      if (op === "insert") {
        const row = { id: `${table}-${rows().length + 1}`, ...patch };
        rows().push(row);
        db.writes.push({ table, op, patch: { ...patch }, filters: [] });
        const p = project(table, row, selectList || "id");
        return { data: single ? p : [p], error: null };
      }
      const hit = rows().filter((r) => preds.every((p) => p.test(r)));
      db.writes.push({ table, op, patch: patch ? { ...patch } : undefined, filters: preds.map((p) => p.desc) });
      if (op === "update") for (const r of hit) Object.assign(r, patch);
      else db.tables[table] = rows().filter((r) => !hit.includes(r));
      const data = hit.map((r) => project(table, r, selectList || "id"));
      return { data: single ? (data[0] ?? null) : data, error: null };
    };

    const b: any = {
      select(list?: string, opts?: { count?: string; head?: boolean }) {
        selectList = list ?? "";
        if (opts?.count) count = true;
        if (opts?.head) head = true;
        return b;
      },
      insert(p: Row) {
        op = "insert";
        patch = p;
        return b;
      },
      update(p: Row) {
        op = "update";
        patch = p;
        return b;
      },
      delete() {
        op = "delete";
        return b;
      },
      eq: (c: string, v: unknown) => add(`eq ${c} ${v}`, (r) => r[c] === v),
      neq: (c: string, v: unknown) => add(`neq ${c} ${v}`, (r) => r[c] !== v),
      in: (c: string, vs: unknown[]) => add(`in ${c}`, (r) => vs.includes(r[c])),
      is: (c: string, v: null) => add(`is ${c} ${v}`, (r) => (r[c] ?? null) === v),
      not: (c: string, o: string, v: unknown) => {
        if (o === "in" && typeof v === "string") {
          const vs = v.replace(/^\(|\)$/g, "").split(",").map((x) => x.trim());
          return add(`not ${c} in ${v}`, (r) => !vs.includes(String(r[c])));
        }
        if (o !== "is" || v !== null) throw new Error(`stand-in: not(${c}, ${o}) is not supported`);
        return add(`not ${c} is null`, (r) => (r[c] ?? null) !== null);
      },
      // or("a.is.null,b.not.in.(x,y),c.eq.v"): each arm by SQL's own rules (a null is in no list, and
      // is not NOT in one either), so a filter that forgets a null is caught here as on the database.
      or: (expr: string) => {
        const arms = splitTop(expr).map((arm) => {
          const m = /^([a-z_]+)\.(not\.)?(is|in|eq|neq)\.(.*)$/.exec(arm);
          if (!m) throw new Error(`stand-in: or arm ${arm} is not supported`);
          const [, c, not, op, raw] = m;
          const test = (r: Row): boolean | null => {
            const x = r[c] ?? null;
            if (op === "is") return raw === "null" ? x === null : null;
            if (x === null) return null;
            if (op === "in") return raw.replace(/^\(|\)$/g, "").split(",").map((s) => s.trim()).includes(String(x));
            if (op === "eq") return String(x) === raw;
            return String(x) !== raw;
          };
          return (r: Row) => {
            const t = test(r);
            if (t === null) return false;
            return not ? !t : t;
          };
        });
        return add(`or ${expr}`, (r) => arms.some((f) => f(r)));
      },
      gt: (c: string, v: any) => add(`gt ${c}`, (r) => r[c] != null && r[c] > v),
      gte: (c: string, v: any) => add(`gte ${c}`, (r) => r[c] != null && r[c] >= v),
      lt: (c: string, v: any) => add(`lt ${c}`, (r) => r[c] != null && r[c] < v),
      lte: (c: string, v: any) => add(`lte ${c}`, (r) => r[c] != null && r[c] <= v),
      order: (col: string, o?: { ascending?: boolean }) => ((order = { col, asc: o?.ascending !== false }), b),
      limit: (n: number) => ((limit = n), b),
      range: (a: number, z: number) => ((offset = a), (limit = z - a + 1), b),
      maybeSingle: async () => run(true),
      single: async () => run(true),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run(false)).then(ok, bad),
    };
    return b;
  }
  return { from };
}
