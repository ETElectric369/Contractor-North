/**
 * A STAND-IN DATABASE THAT HONOURS THE QUERY (cn-v1181, lane T). Unlike a scripted fake it answers
 * from rows, so a door that forgets a filter (another company's row, a paper already filed) or reads
 * a column it never selected is CAUGHT: eq / is / neq / in / not-is-null filter the rows, `limit`
 * cuts them, the select list PROJECTS each row to exactly the columns named ("*" for all), an update
 * patches only the rows its filters hit and answers with the projection asked of it, a delete takes
 * only those rows, and an insert adds rows with an id. `writes` records every write, in order.
 * An embedded select ("invoices!inner(id, status)") is resolved by the row's own `<singular>_id`
 * (invoices -> invoice_id) and projected to ITS list too; `!inner` drops a row whose embed is missing;
 * a filter on "invoices.status" reads the embed. contains / like filter arrays and import keys.
 * Anything else it cannot honour throws, so a test cannot pass by accident.
 */
export type Row = Record<string, any>;

export function strictDb(tables: Record<string, Row[]>, opts: { fail?: (table: string, verb: string) => string | undefined } = {}) {
  const writes: { table: string; verb: "update" | "insert" | "delete"; patch?: Row; hit: string[] }[] = [];
  let seq = 0;
  /** Top-level comma split: an embed's own list stays whole. */
  const splitTop = (cols: string): string[] => {
    const parts: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of cols) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        parts.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts.filter(Boolean);
  };
  const EMBED = /^([a-z_]+)(!inner)?\((.*)\)$/;
  const embedOf = (r: Row, name: string): Row | null => {
    const key = `${name.replace(/s$/, "")}_id`;
    return (tables[name] ?? []).find((x) => x.id === r[key]) ?? null;
  };
  const valueAt = (r: Row, col: string) => {
    if (!col.includes(".")) return r[col];
    const [name, c] = col.split(".");
    return embedOf(r, name)?.[c];
  };
  const innerOf = (cols: string | null): string[] =>
    !cols || cols.trim() === "*" ? [] : splitTop(cols).map((c) => EMBED.exec(c)).filter((m): m is RegExpExecArray => !!m && !!m[2]).map((m) => m[1]);
  const project = (cols: string | null, r: Row): Row => {
    if (!cols || cols.trim() === "*") return { ...r };
    const out: Row = {};
    for (const c of splitTop(cols)) {
      const m = EMBED.exec(c);
      if (m) {
        const x = embedOf(r, m[1]);
        out[m[1]] = x ? project(m[3], x) : null;
        continue;
      }
      if (/[()]/.test(c)) throw new Error(`strictDb: select not supported: ${c}`);
      out[c] = r[c];
    }
    return out;
  };
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let mode: "select" | "update" | "insert" | "delete" = "select";
    let cols: string | null = null;
    let patch: Row | null = null;
    let pending: Row[] = [];
    let single = false;
    let cap: number | null = null;
    const b: any = {
      select(c?: string) {
        cols = c ?? "*";
        return b;
      },
      eq(col: string, v: unknown) {
        filters.push((r) => valueAt(r, col) === v);
        return b;
      },
      neq(col: string, v: unknown) {
        filters.push((r) => valueAt(r, col) != null && valueAt(r, col) !== v);
        return b;
      },
      contains(col: string, vals: unknown[]) {
        filters.push((r) => Array.isArray(r[col]) && vals.every((v) => r[col].includes(v)));
        return b;
      },
      like(col: string, pattern: string) {
        const re = new RegExp(`^${pattern.split("%").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
        filters.push((r) => re.test(String(r[col] ?? "")));
        return b;
      },
      is(col: string, v: unknown) {
        filters.push((r) => (r[col] ?? null) === v);
        return b;
      },
      in(col: string, vals: unknown[]) {
        filters.push((r) => vals.includes(r[col]));
        return b;
      },
      not(col: string, op: string, v: unknown) {
        if (op !== "is" || v !== null) throw new Error(`strictDb: not(${col}, ${op}) not supported`);
        filters.push((r) => r[col] != null);
        return b;
      },
      order: () => b,
      limit(n: number) {
        cap = n;
        return b;
      },
      update(p: Row) {
        mode = "update";
        patch = p;
        cols = null;
        return b;
      },
      delete() {
        mode = "delete";
        cols = null;
        return b;
      },
      insert(rows: Row | Row[]) {
        mode = "insert";
        pending = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ id: `${table}-new-${++seq}`, ...r }));
        cols = null;
        return b;
      },
      maybeSingle() {
        single = true;
        return b;
      },
      single() {
        single = true;
        return b;
      },
      then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
        try {
          const failed = opts.fail?.(table, mode);
          if (failed) return resolve({ data: null, error: { message: failed } });
          const all = (tables[table] ??= []);
          let rows: Row[];
          if (mode === "insert") {
            all.push(...pending);
            rows = pending;
            writes.push({ table, verb: "insert", hit: pending.map((r) => r.id) });
          } else {
            const inner = mode === "select" ? innerOf(cols) : [];
            rows = all.filter((r) => filters.every((f) => f(r)) && inner.every((name) => embedOf(r, name)));
            if (mode === "update") {
              for (const r of rows) Object.assign(r, JSON.parse(JSON.stringify(patch)));
              writes.push({ table, verb: "update", patch: patch ?? undefined, hit: rows.map((r) => r.id) });
            } else if (mode === "delete") {
              tables[table] = all.filter((r) => !rows.includes(r));
              writes.push({ table, verb: "delete", hit: rows.map((r) => r.id) });
            }
          }
          if (cap !== null) rows = rows.slice(0, cap);
          // A write with no select answers null data, as PostgREST does.
          const data = cols === null ? null : rows.map((r) => project(cols, r));
          resolve({ data: single ? (data?.[0] ?? null) : data, error: null });
        } catch (e) {
          if (reject) reject(e);
          else throw e;
        }
      },
    };
    return b;
  };
  return { sb: { from } as any, tables, writes };
}
