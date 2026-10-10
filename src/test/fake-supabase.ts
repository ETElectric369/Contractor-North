/**
 * A FAKE SUPABASE CLIENT FOR RULES THAT TAKE THE CLIENT THEY ARE GIVEN (lib/estimate/*).
 *
 * A thenable query builder over plain rows, recording every insert. It applies eq/is filters by
 * column (an embedded-table filter like "price_list_item_options.archived" is ignored, as the real
 * one is satisfied by the embed), ignores order/limit/not, answers single()/maybeSingle() with the
 * first row, answers an insert's .select("id") with one id per row (and ADDS the rows to the table,
 * so a later read in the same test sees them, as the database would), and applies an update's patch
 * to the rows the filters hit, returning their ids. `onInsert` lets a test refuse one insert the way
 * Postgres would (a unique violation), optionally planting the winner's rows first.
 */
export type Row = Record<string, any>;

export interface FakeDbOptions {
  /** Called before an insert lands; return an error to refuse it (the rows are then NOT added). */
  onInsert?: (table: string, rows: Row[]) => { code?: string; message: string } | undefined;
}

export function fakeDb(tables: Record<string, Row[]>, opts: FakeDbOptions = {}) {
  const inserted: Record<string, Row[]> = {};
  let seq = 0;
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let mode: "select" | "insert" | "update" = "select";
    let single = false;
    let pending: Row[] = [];
    let refused: { code?: string; message: string } | undefined;
    const b: any = {
      select: () => b,
      order: () => b,
      limit: () => b,
      not: () => b,
      eq(col: string, v: unknown) {
        if (!col.includes(".")) filters.push((r) => r[col] === v);
        return b;
      },
      is(col: string, v: unknown) {
        filters.push((r) => r[col] === v);
        return b;
      },
      insert(rows: Row | Row[]) {
        mode = "insert";
        pending = (Array.isArray(rows) ? rows : [rows]).map((r) => ({ ...r, id: `${table}-${++seq}` }));
        refused = opts.onInsert?.(table, pending);
        if (!refused) {
          inserted[table] = [...(inserted[table] ?? []), ...pending];
          tables[table] = [...(tables[table] ?? []), ...pending];
        }
        return b;
      },
      update(patch: Row) {
        mode = "update";
        pending = [patch];
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
      then(resolve: (v: unknown) => void) {
        if (refused) return resolve({ data: null, error: refused });
        let data: unknown;
        if (mode === "insert") data = single ? pending[0] : pending.map((r) => ({ id: r.id }));
        else if (mode === "update") {
          const hit = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
          for (const r of hit) Object.assign(r, pending[0]);
          data = hit.map((r) => ({ id: r.id }));
        } else {
          const hit = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
          data = single ? (hit[0] ?? null) : hit;
        }
        resolve({ data, error: null });
      },
    };
    return b;
  };
  return { sb: { from } as any, inserted, tables };
}
