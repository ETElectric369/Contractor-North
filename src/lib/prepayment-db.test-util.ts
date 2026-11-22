/**
 * A SMALL IN-MEMORY DATABASE FOR THE PAYMENT-REQUEST TESTS (cn-v1177): every read and write is answered
 * by tables held here, filters and all (eq / neq / in / is / gte), so what a test reads back is what the
 * code wrote. A row inserted with no org_id takes the company's, as 0004's set_org_id trigger does, and
 * an invoice line's line_total is computed, as the generated column is. Not a database: the triggers of
 * 0414 are src/lib/payment-request.integration.test.ts's.
 */
export type Row = Record<string, any>;
export type Tables = Record<string, Row[]>;
export type Write = { table: string; verb: string; payload?: any };

export function fakeDb(tables: Tables, opts: { org: string; writes: Write[]; seq: { n: number } }) {
  const { writes, seq } = opts;
  const genLine = (r: Row) => {
    if ("quantity" in r || "unit_price" in r) r.line_total = Math.round(Number(r.quantity ?? 1) * Number(r.unit_price ?? 0) * 100) / 100;
    return r;
  };
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let verb: "select" | "insert" | "update" | "delete" = "select";
    let payload: any = null;
    let order: { col: string; asc: boolean } | null = null;
    let limit: number | null = null;
    const rows = () => (tables[table] ??= []);
    const matching = () => rows().filter((r) => filters.every((f) => f(r)));
    const run = (): { data: any; error: any } => {
      if (verb === "insert") {
        const list = (Array.isArray(payload) ? payload : [payload]).map((p: Row) => {
          const n = ++seq.n;
          const r: Row = { id: p.id ?? `${table}-${n}`, created_at: new Date(Date.UTC(2026, 10, 1, 0, 0, n)).toISOString(), ...p };
          if ((table === "invoices" || table === "invoice_items" || table === "payments" || table === "customer_credits") && !r.org_id) r.org_id = opts.org;
          if (table === "invoices") {
            r.invoice_number = r.invoice_number ?? `INV-9${String(n).padStart(2, "0")}`;
            r.public_token = r.public_token ?? `tok-${n}`;
            r.amount_paid = r.amount_paid ?? 0;
            r.invoice_kind = r.invoice_kind ?? "standard";
          }
          return table === "invoice_items" ? genLine(r) : r;
        });
        rows().push(...list);
        writes.push({ table, verb, payload });
        return { data: list, error: null };
      }
      if (verb === "update") {
        const hit = matching();
        for (const r of hit) {
          Object.assign(r, payload);
          if (table === "invoice_items") genLine(r);
        }
        writes.push({ table, verb, payload });
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      if (verb === "delete") {
        const hit = matching();
        tables[table] = rows().filter((r) => !hit.includes(r));
        writes.push({ table, verb });
        return { data: hit.map((r) => ({ ...r })), error: null };
      }
      let out = matching().map((r) => ({ ...r }));
      if (order) {
        const { col, asc } = order;
        out = out.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
      }
      if (limit !== null) out = out.slice(0, limit);
      return { data: out, error: null };
    };
    const chain: any = {
      select: () => chain,
      insert: (p: any) => ((verb = "insert"), (payload = p), chain),
      update: (p: any) => ((verb = "update"), (payload = p), chain),
      delete: () => ((verb = "delete"), chain),
      eq: (c: string, v: any) => (filters.push((r) => r[c] === v), chain),
      neq: (c: string, v: any) => (filters.push((r) => r[c] !== v), chain),
      in: (c: string, v: any[]) => (filters.push((r) => v.includes(r[c])), chain),
      is: (c: string, v: any) => (filters.push((r) => (r[c] ?? null) === v), chain),
      gte: (c: string, v: any) => (filters.push((r) => String(r[c] ?? "") >= String(v)), chain),
      order: (c: string, o?: { ascending?: boolean }) => ((order = { col: c, asc: o?.ascending !== false }), chain),
      limit: (n: number) => ((limit = n), chain),
      single: async () => {
        const r = run();
        return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error ?? (Array.isArray(r.data) && !r.data.length ? { message: "no rows" } : null) };
      },
      maybeSingle: async () => {
        const r = run();
        return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error };
      },
      then: (ok: any, bad: any) => Promise.resolve(run()).then(ok, bad),
    };
    return chain;
  };
  return { from, auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } } as any;
}

/** One table's reads made to fail (a timeout), everything else as it is. */
export function failingReads(client: any, table: string) {
  const real = client.from;
  return {
    ...client,
    from: (t: string) => {
      const c = real(t);
      if (t !== table) return c;
      const failing: any = new Proxy(c, {
        get: (o, k) =>
          k === "then"
            ? (ok: any) => Promise.resolve({ data: null, error: { message: "timeout" } }).then(ok)
            : typeof o[k] === "function"
              ? (...a: any[]) => (o[k](...a), failing)
              : o[k],
      });
      return failing;
    },
  };
}
