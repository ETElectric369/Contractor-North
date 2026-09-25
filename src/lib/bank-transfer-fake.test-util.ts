/**
 * A small in-memory PostgREST fake for the bank-transfer tests (audit v994 BK1-BK3): tables are
 * arrays of rows; select / insert / upsert / update apply eq, in, is, lt filters, and limit. The
 * two unique keys these doors lean on are enforced: payments.stripe_event_id (a retried event is a
 * 23505) and pending_bank_transfers.payment_intent (upsert ignoreDuplicates is ON CONFLICT DO
 * NOTHING). A table named in `missing` answers PGRST205, the way a database before 0338 does.
 */
export type Tables = Record<string, any[]>;

const UNIQUE: Record<string, string> = { payments: "stripe_event_id", pending_bank_transfers: "payment_intent" };

export function fakeDb(tables: Tables, opts: { missing?: string[] } = {}) {
  let seq = 0;
  const log: { table: string; verb: string; payload?: any; filters: string[] }[] = [];
  const client = {
    log,
    tables,
    from(table: string) {
      const filters: ((r: any) => boolean)[] = [];
      const said: string[] = [];
      let verb: "select" | "insert" | "upsert" | "update" = "select";
      let payload: any = null;
      let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
      let limit: number | null = null;
      let single: "maybe" | "one" | null = null;
      const run = () => {
        log.push({ table, verb, payload, filters: said });
        if (opts.missing?.includes(table)) return { data: null, error: { code: "PGRST205", message: `Could not find the table 'public.${table}'` } };
        const rows = (tables[table] ??= []);
        if (verb === "insert" || verb === "upsert") {
          const list = Array.isArray(payload) ? payload : [payload];
          const out: any[] = [];
          for (const p of list) {
            const key = UNIQUE[table];
            if (key && p[key] != null && rows.some((r) => r[key] === p[key])) {
              if (verb === "upsert" && upsertOpts.ignoreDuplicates) continue;
              return { data: null, error: { code: "23505", message: "duplicate key value" } };
            }
            const row = { id: p.id ?? `${table}-${++seq}`, ...p };
            rows.push(row);
            out.push(row);
          }
          return { data: out, error: null };
        }
        let hit = rows.filter((r) => filters.every((f) => f(r)));
        if (verb === "update") {
          for (const r of hit) Object.assign(r, payload);
        }
        if (limit != null) hit = hit.slice(0, limit);
        if (single) return { data: hit[0] ?? null, error: single === "one" && !hit[0] ? { message: "no row" } : null };
        return { data: hit, error: null };
      };
      const chain: any = {
        select() {
          return chain;
        },
        insert(p: any) {
          verb = "insert";
          payload = p;
          return chain;
        },
        upsert(p: any, o: any = {}) {
          verb = "upsert";
          payload = p;
          upsertOpts = o;
          return chain;
        },
        update(p: any) {
          verb = "update";
          payload = p;
          return chain;
        },
        eq(c: string, v: unknown) {
          said.push(`eq:${c}`);
          filters.push((r) => r[c] === v);
          return chain;
        },
        in(c: string, vs: unknown[]) {
          said.push(`in:${c}`);
          filters.push((r) => vs.includes(r[c]));
          return chain;
        },
        is(c: string, v: unknown) {
          said.push(`is:${c}`);
          filters.push((r) => (r[c] ?? null) === v);
          return chain;
        },
        lt(c: string, v: string) {
          said.push(`lt:${c}`);
          filters.push((r) => String(r[c]) < v);
          return chain;
        },
        order() {
          return chain;
        },
        limit(n: number) {
          limit = n;
          return chain;
        },
        maybeSingle() {
          single = "maybe";
          return Promise.resolve(run());
        },
        single() {
          single = "one";
          return Promise.resolve(run());
        },
        then(ok: (v: any) => any, err?: (e: any) => any) {
          return Promise.resolve(run()).then(ok, err);
        },
      };
      return chain;
    },
  };
  return client;
}
