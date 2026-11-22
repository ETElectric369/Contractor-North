/**
 * A SMALL IN-MEMORY DATABASE FOR THE PAYMENT-REQUEST TESTS (cn-v1177): every read and write is answered
 * by tables held here, filters and all (eq / neq / in / is / gte), so what a test reads back is what the
 * code wrote. A row inserted with no org_id takes the company's, as 0004's set_org_id trigger does, and
 * an invoice line's line_total is computed, as the generated column is. Not a database: the triggers of
 * 0414 are src/lib/payment-request.integration.test.ts's.
 *
 * AN INVOICE READ WITH ITS LINES GETS ITS LINES. A select on invoices that names invoice_items(...) is
 * answered with each bill's lines embedded, as PostgREST answers it. Until the night cn-v1177 was
 * released this ignored the select list, so the status door read a bill with NO lines and its un-void
 * check had nothing to look at: the tests passed on a door the real database refused at.
 *
 * WHAT A READ ASKS FOR IS WHAT IT GETS (cn-v1178, the audit's L2): a read of `invoices` or `quotes` comes
 * back with ONLY the top-level columns its select list names (`*` is every column; an alias `a:b` is
 * column b under the name a), embeds as above. A door that forgot a column reads it as absent here, as
 * it would on the real database. Other tables still come back whole.
 *
 * THE BOUNDARY OF ONE SALE, ONE DEPOSIT, as far as rows can hold it:
 *   - rpc("quote_family_ids", { p_quote }) answers by migration 0416's rule from the `quotes` table
 *     (up along revises_quote_id to the first of the line, then down through everything that revises any
 *     of them, 12 hops each way, one company); any other function name is an error, never an empty
 *     answer, and `opts.noFamilyFn` makes this one missing too (a database before 0416);
 *   - an invoices write that would leave two live deposit requests for ONE estimate fails with 23505 and
 *     the name of 0414's unique index;
 *   - an invoices write after which a row BECOMES a live deposit request (insert, back from void, a new
 *     estimate or kind) whose sale already has another live one fails as 0416's guard refuses it, with
 *     its words. A payment landing on a request is never refused by it. Off with `opts.noFamilyFn`.
 */
export type Row = Record<string, any>;
export type Tables = Record<string, Row[]>;
export type Write = { table: string; verb: string; payload?: any };

/** The tables whose reads are projected to the select list (top-level columns; embeds as before). */
const PROJECTED = new Set(["invoices", "quotes"]);

/** Split a select list at its top-level commas (an embed's own commas stay inside it). */
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

/** The row as a select list sees it: null when every column is asked for. */
function projector(cols: unknown): ((r: Row) => Row) | null {
  if (typeof cols !== "string" || !cols.trim()) return null;
  const parts = topLevel(cols);
  if (parts.some((p) => p === "*")) return null;
  const plain = parts
    .filter((p) => !p.includes("("))
    .map((p) => {
      const [a, b] = p.includes(":") ? p.split(":").map((x) => x.trim()) : [p, p];
      return { as: a, col: b.replace(/::\w+$/, "") };
    });
  const embeds = parts.filter((p) => p.includes("(")).map((p) => p.slice(0, p.indexOf("(")).split("!")[0].split(":").pop()!.trim());
  return (r: Row) => {
    const o: Row = {};
    for (const { as, col } of plain) if (col in r) o[as] = r[col];
    for (const e of embeds) if (e in r) o[e] = r[e];
    return o;
  };
}

/** migration 0416's quote_family_ids, from the rows: the estimate, its line up to the first, and everything below. */
export function familyOf(quotes: Row[], quoteId: string): string[] {
  const byId = new Map(quotes.map((q) => [String(q.id), q]));
  const me = byId.get(quoteId);
  if (!me) return [quoteId];
  const org = me.org_id ?? null;
  let root = me;
  for (let i = 0; i < 12; i++) {
    const up = root.revises_quote_id ? byId.get(String(root.revises_quote_id)) : null;
    if (!up || (up.org_id ?? null) !== org) break;
    root = up;
  }
  const ids = new Set<string>([String(root.id), quoteId]);
  let level = [String(root.id)];
  for (let i = 0; i < 12 && level.length; i++) {
    const next = quotes.filter((q) => q.revises_quote_id && level.includes(String(q.revises_quote_id)) && (q.org_id ?? null) === org && !ids.has(String(q.id))).map((q) => String(q.id));
    next.forEach((n) => ids.add(n));
    level = next;
  }
  return [...ids];
}

const liveDeposit = (r: Row): boolean => r.invoice_kind === "prepayment" && r.quote_id != null && r.status !== "void";

export function fakeDb(tables: Tables, opts: { org: string; writes: Write[]; seq: { n: number }; noFamilyFn?: boolean }) {
  const { writes, seq } = opts;
  const genLine = (r: Row) => {
    if ("quantity" in r || "unit_price" in r) r.line_total = Math.round(Number(r.quantity ?? 1) * Number(r.unit_price ?? 0) * 100) / 100;
    return r;
  };
  /**
   * 0414's unique index and 0416's guard, asked of the invoices table as it WOULD be after a write.
   * `became`: the rows that became live deposit requests or changed estimate (the guard acts on those only).
   */
  const boundary = (after: Row[], became: Row[]): { code: string; message: string } | null => {
    for (const r of became) {
      if (opts.noFamilyFn || !liveDeposit(r)) continue;
      const fam = familyOf(tables.quotes ?? [], String(r.quote_id));
      // ANOTHER estimate of the sale only, as 0416's guard reads it (`d.quote_id <> new.quote_id`), oldest
      // first: a second live request on the SAME estimate is left to 0414's unique index below (23505).
      const other = after
        .filter((o) => o !== r && o.id !== r.id && liveDeposit(o) && (o.org_id ?? null) === (r.org_id ?? null) && fam.includes(String(o.quote_id)) && String(o.quote_id) !== String(r.quote_id))
        .sort((x, y) => String(x.created_at ?? "").localeCompare(String(y.created_at ?? "")) || String(x.id).localeCompare(String(y.id)))[0];
      if (other) return { code: "P0001", message: `This sale already has a deposit request: ${other.invoice_number ?? "another payment request"}. Use that one. Nothing was made.` };
    }
    const seen = new Set<string>();
    for (const r of after.filter(liveDeposit)) {
      const k = String(r.quote_id);
      if (seen.has(k)) return { code: "23505", message: 'duplicate key value violates unique constraint "invoices_one_live_deposit_request_per_estimate"' };
      seen.add(k);
    }
    return null;
  };
  const from = (table: string) => {
    const filters: ((r: Row) => boolean)[] = [];
    let verb: "select" | "insert" | "update" | "delete" = "select";
    let payload: any = null;
    let order: { col: string; asc: boolean } | null = null;
    let limit: number | null = null;
    let withLines = false;
    let project: ((r: Row) => Row) | null = null;
    const rows = () => (tables[table] ??= []);
    const matching = () => rows().filter((r) => filters.every((f) => f(r)));
    const shape = (list: Row[]): Row[] => (project && PROJECTED.has(table) ? list.map(project) : list);
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
        if (table === "invoices") {
          const refused = boundary([...rows(), ...list], list);
          if (refused) {
            writes.push({ table, verb: "refused", payload });
            return { data: null, error: refused };
          }
        }
        rows().push(...list);
        writes.push({ table, verb, payload });
        return { data: shape(list.map((r: Row) => ({ ...r }))), error: null };
      }
      if (verb === "update") {
        const hit = matching();
        if (table === "invoices") {
          const next = new Map(hit.map((r) => [r, { ...r, ...payload }]));
          const after = rows().map((r) => next.get(r) ?? r);
          const became = hit
            .filter((r) => {
              const n = next.get(r)!;
              return r.status === "void" || r.quote_id !== n.quote_id || r.invoice_kind !== n.invoice_kind;
            })
            .map((r) => next.get(r)!);
          const refused = boundary(after, became);
          if (refused) {
            writes.push({ table, verb: "refused", payload });
            return { data: null, error: refused };
          }
        }
        for (const r of hit) {
          Object.assign(r, payload);
          if (table === "invoice_items") genLine(r);
        }
        writes.push({ table, verb, payload });
        return { data: shape(hit.map((r) => ({ ...r }))), error: null };
      }
      if (verb === "delete") {
        const hit = matching();
        tables[table] = rows().filter((r) => !hit.includes(r));
        writes.push({ table, verb });
        return { data: shape(hit.map((r) => ({ ...r }))), error: null };
      }
      let out = matching().map((r) => ({ ...r }));
      if (order) {
        const { col, asc } = order;
        out = out.sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : String(a[col]) > String(b[col]) ? 1 : 0) * (asc ? 1 : -1));
      }
      if (limit !== null) out = out.slice(0, limit);
      if (withLines) out = out.map((r) => ({ ...r, invoice_items: (tables.invoice_items ?? []).filter((l) => l.invoice_id === r.id).map((l) => ({ ...l })) }));
      return { data: shape(out), error: null };
    };
    const chain: any = {
      select: (cols?: unknown) => {
        if (table === "invoices" && typeof cols === "string" && /\binvoice_items\s*\(/.test(cols)) withLines = true;
        project = projector(cols);
        return chain;
      },
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
  /** The database functions this stand-in knows. Any other name is an error, as PostgREST answers it. */
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    if (fn === "quote_family_ids" && !opts.noFamilyFn) {
      writes.push({ table: "rpc:quote_family_ids", verb: "rpc", payload: args });
      return { data: familyOf(tables.quotes ?? [], String(args?.p_quote ?? "")), error: null };
    }
    return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn} in the schema cache` } };
  };
  return { from, rpc, auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) } } as any;
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
