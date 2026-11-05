import { describe, expect, it } from "vitest";
import { tieAlreadyInvoiced } from "./already-invoiced";

/**
 * ALREADY INVOICED refuses a deposit or a progress draw (money for work still ahead never settles the
 * work, quoteSettled's rule), says so in plain words, and writes nothing. A final draw ties.
 */
function fakeDb(invoice: Record<string, unknown>) {
  const writes: unknown[] = [];
  const db = {
    writes,
    from(table: string) {
      const chain: any = {
        _update: null as unknown,
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        not: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        update: (v: unknown) => {
          writes.push({ table, v });
          chain._update = v;
          return chain;
        },
        maybeSingle: async () =>
          table === "quotes"
            ? { data: { id: "q1", quote_number: "Q-001", job_id: null, customer_id: "c1", customers: { name: "Larkspur" } }, error: null }
            : { data: invoice, error: null },
        then: (res: (v: unknown) => unknown) => res({ data: [{ id: "i1" }], error: null }),
      };
      return chain;
    },
  };
  return db;
}

const base = { id: "i1", invoice_number: "INV-001", status: "sent", job_id: null, quote_id: null, appointment_id: null };

describe("tieAlreadyInvoiced", () => {
  for (const kind of ["deposit", "progress"]) {
    it(`refuses a ${kind} and writes nothing`, async () => {
      const db = fakeDb({ ...base, invoice_kind: kind });
      const r = await tieAlreadyInvoiced(db, "org1", { kind: "quote", id: "q1" }, "i1");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/work still ahead/);
      expect(db.writes).toHaveLength(0);
    });
  }
  it("ties a final draw", async () => {
    const db = fakeDb({ ...base, invoice_kind: "final" });
    const r = await tieAlreadyInvoiced(db, "org1", { kind: "quote", id: "q1" }, "i1");
    expect(r.ok).toBe(true);
    expect(db.writes).toHaveLength(1);
  });
  it("ties a standard invoice", async () => {
    const db = fakeDb({ ...base, invoice_kind: "standard" });
    const r = await tieAlreadyInvoiced(db, "org1", { kind: "quote", id: "q1" }, "i1");
    expect(r.ok).toBe(true);
  });
});
