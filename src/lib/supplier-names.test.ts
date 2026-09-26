import { describe, it, expect } from "vitest";
import { readSupplierNames, fetchSupplierNames } from "@/lib/supplier-names";
import { readAllPages } from "@/lib/read-all-pages";
import { customerLineWords, supplierKey } from "@/lib/invoice-math";

/**
 * THE SUPPLIER-NAME SCRUB READS EVERY ROW (audit v1018 links-docs-4). PostgREST caps a select at
 * db-max-rows (1000 by default) with no error; a supplier named only on bill 1,500 must still be
 * in the set, or a hand-typed "Materials — <that supplier>" line prints the name on the customer's
 * /i page and portal bill.
 */

const ORG = "60195593-2e18-4230-bc8e-7a32d36d038d";
const OTHER = "99999999-9999-4999-8999-999999999999";

/** 2,400 of ORG's bills from CED, then one from Sierra Lumber (only there), and another org's. */
const TABLES: Record<string, Record<string, unknown>[]> = {
  bills: [
    ...Array.from({ length: 2400 }, (_, i) => ({ id: `b${String(i).padStart(5, "0")}`, org_id: ORG, supplier: "CED" })),
    { id: "b99999", org_id: ORG, supplier: "Sierra Lumber" },
    { id: "c00001", org_id: OTHER, supplier: "Acme Supply" },
  ],
  purchase_orders: [{ id: "po1", org_id: ORG, vendor: "Home Depot" }],
  supplier_accounts: [{ id: "sa1", org_id: ORG, name: "Consolidated Electrical Distributors" }],
  supplier_aliases: [{ id: "al1", org_id: ORG, alias: "C.E.D." }],
};

/** A PostgREST-shaped client whose every read returns at most `cap` rows, silently. */
function capped(cap: number, fail?: string) {
  const calls: { table: string; range?: [number, number] }[] = [];
  const from = (table: string) => {
    const call: { table: string; range?: [number, number]; org?: unknown; col?: string } = { table };
    calls.push(call);
    const b: any = {
      select: (col: string) => ((call.col = col), b),
      eq: (_c: string, v: unknown) => ((call.org = v), b),
      order: () => b,
      range: (f: number, t: number) => ((call.range = [f, t]), b),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
        if (fail === table) return Promise.resolve({ data: null, error: { message: "boom" } }).then(ok, bad);
        let rows = (TABLES[table] ?? []).filter((r) => call.org === undefined || r.org_id === call.org);
        rows = [...rows].sort((a, z) => String(a.id).localeCompare(String(z.id)));
        const [f, t] = call.range ?? [0, Infinity];
        rows = rows.slice(f, Math.min(t + 1, f + cap));
        return Promise.resolve({ data: rows.map((r) => ({ [call.col!]: r[call.col!] })), error: null }).then(ok, bad);
      },
    };
    return b;
  };
  return { from, calls };
}

describe("the supplier names are read whole, past the row cap", () => {
  it("a supplier named only past row 1,000 is in the set (the cap is silent)", async () => {
    const db = capped(1000);
    const { names, failed } = await readSupplierNames(db, ORG);
    expect(failed).toBe(false);
    expect(names.has(supplierKey("Sierra Lumber"))).toBe(true);
    expect(names.has(supplierKey("CED"))).toBe(true);
    // Never another org's.
    expect(names.has(supplierKey("Acme Supply"))).toBe(false);
    // So the hand-typed line is the customer's word, not the supplier's name.
    expect(customerLineWords({ description: "Materials — Sierra Lumber", import_source: "costs", import_key: "hand", edited: true }, names)).toBe("Materials");
    // Bills paged 1000 + 1000 + 401 + the empty page that says it's whole.
    expect(db.calls.filter((c) => c.table === "bills").map((c) => c.range)).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
      [2401, 3400],
    ]);
  });

  it("a cap tighter than the page still reads every row (it advances by the rows returned)", async () => {
    const { names, failed } = await readSupplierNames(capped(300), ORG);
    expect(failed).toBe(false);
    expect(names.has(supplierKey("Sierra Lumber"))).toBe(true);
  });

  it("a failed page says failed (the customer's document refuses); the lenient reader keeps the rest", async () => {
    expect((await readSupplierNames(capped(1000, "supplier_aliases"), ORG)).failed).toBe(true);
    const lenient = await fetchSupplierNames(capped(1000, "supplier_aliases"), ORG);
    expect(lenient.has(supplierKey("Sierra Lumber"))).toBe(true);
  });
});

describe("readAllPages", () => {
  it("an error, a non-list or too many pages is a failure, never a partial list", async () => {
    expect((await readAllPages(async () => ({ data: null, error: { message: "x" } }))).error).toBeTruthy();
    expect((await readAllPages(async () => ({ data: null, error: null }))).error).toBeTruthy();
    const endless = await readAllPages(async () => ({ data: [1], error: null }), 3);
    expect(endless.rows).toEqual([]);
    expect(String(endless.error)).toMatch(/more than 3000 rows/);
  });
});
