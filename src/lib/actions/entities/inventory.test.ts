import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * NORT FILLS THE TOOK FROM STOCK CARD; A PERSON TAPS TAKE IT (Shop Stock, Phase 3, fill vs execute).
 * "took 60 feet of 12/2 from stock for Herringbone" resolves the job and the item and hands back the
 * link that opens the sheet filled in. Two items that match ask which; none says what the shelf has.
 * It never takes anything (the only RPC it calls is the crew's read of the shelf), and nothing it
 * says carries a price, for the crew or the office.
 */

const { db } = vi.hoisted(() => ({
  db: {
    job: { id: "8760a051-0000-4000-8000-000000000011", job_number: "J-011", name: "Herringbone" } as Record<string, unknown> | null,
    shelf: [] as Record<string, unknown>[],
    rpcs: [] as string[],
    filters: [] as string[],
    writes: 0,
  },
}));

function fakeClient() {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const k of ["select", "limit", "is", "in", "order", "ilike", "or"]) chain[k] = () => chain;
      chain.eq = (c: string, v: unknown) => (db.filters.push(`${table}.${c}=${String(v)}`), chain);
      for (const k of ["insert", "update", "delete", "upsert"]) chain[k] = () => ((db.writes += 1), chain);
      chain.maybeSingle = async () => ({ data: table === "jobs" ? db.job : null, error: null });
      return chain;
    },
    rpc: async (fn: string) => {
      db.rpcs.push(fn);
      return fn === "shelf_for_crew" ? { data: db.shelf, error: null } : { data: null, error: { message: "not in this test" } };
    },
  };
}
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => fakeClient()) }));

import { REGISTRY } from "../registry";

const JOB = "8760a051-0000-4000-8000-000000000011";
const ORG = "60195593-2e18-4230-bc8e-7a32d36d038d";
const take = REGISTRY["stock.take"];
const run = (input: Record<string, unknown>, role = "tech") => take.handler(take.input.parse(input), { userId: "u", orgId: ORG, role });

beforeEach(() => {
  db.job = { id: JOB, job_number: "J-011", name: "Herringbone" };
  db.shelf = [
    { id: "i-122", name: "12/2 NM-B", unit: "ft", on_hand: "250.000" },
    { id: "i-122mc", name: "12/2 MC", unit: "ft", on_hand: "100" },
    { id: "i-nut", name: "Twister 341-Tan wire nut", unit: "ea", on_hand: "440" },
  ];
  db.rpcs = [];
  db.filters = [];
  db.writes = 0;
});

describe("stock.take fills the card", () => {
  it("resolves the item and the job, and hands back the sheet's link filled in, with no price anywhere", async () => {
    const r = await run({ job_id: JOB, item: "12/2 NM-B", qty: 60, unit: "feet" });
    expect(r.ok).toBe(true);
    const d = r.data as any;
    expect(d.href).toBe(`/jobs/${JOB}?tab=materials&take=i-122&qty=60`);
    expect(d.card).toMatchObject({ kind: "task", title: "Took From Stock: 60 ft of 12/2 NM-B", href: d.href, next: "Open it and tap Take It to save it." });
    expect(d.card.scope).toBe("For Herringbone. On the shelf: 250 ft.");
    expect(r.speak).toContain("Tap Take It to save it.");
    expect(JSON.stringify(r)).not.toMatch(/\$|cost|price/i);
  });

  it("never takes anything: the only call it makes is the crew's read of the shelf, and it writes nothing", async () => {
    await run({ job_id: JOB, item: "12/2 NM-B", qty: 60 });
    expect(db.rpcs).toEqual(["shelf_for_crew"]);
    expect(db.writes).toBe(0);
    expect(take.effect).toBe("read");
  });

  it("reads the job inside the caller's own company", async () => {
    await run({ job_id: JOB, item: "12/2 NM-B", qty: 60 });
    expect(db.filters).toEqual(expect.arrayContaining([`jobs.id=${JOB}`, `jobs.org_id=${ORG}`]));
    db.job = null;
    expect((await run({ job_id: JOB, item: "12/2 NM-B", qty: 60 })).ok).toBe(false);
  });

  it("two items that match the name are a question, never a pick", async () => {
    const r = await run({ job_id: JOB, item: "12/2", qty: 60 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('"12/2 NM-B" (250 ft)');
    expect(r.error).toContain('"12/2 MC" (100 ft)');
    expect(r.error).toContain("Ask which one.");
    expect((r.data as any).candidates.map((c: any) => c.item_id)).toEqual(["i-122", "i-122mc"]);
  });

  it("an item the shelf doesn't have is said, with what it has", async () => {
    const r = await run({ job_id: JOB, item: "10/3 romex", qty: 30 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Nothing on the shelf is called "10/3 romex"');
    expect(r.error).toContain('"Twister 341-Tan wire nut"');
  });

  it("a unit the item isn't counted in is a question back, not a conversion", async () => {
    const r = await run({ job_id: JOB, item: "wire nuts", qty: 10, unit: "feet" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("is counted in ea, not feet");
  });

  it("more than the shelf shows still fills, and says the office will recount", async () => {
    db.shelf = [{ id: "i-122", name: "12/2 NM-B", unit: "ft", on_hand: "5" }];
    const r = await run({ job_id: JOB, item: "12/2 NM-B", qty: 20 });
    expect(r.ok).toBe(true);
    expect((r.data as any).card.scope).toContain("15 ft more than the shelf shows — the office will recount.");
  });

  it("no count said: the card opens on the pad and asks how many", async () => {
    const r = await run({ job_id: JOB, item: "wire nuts" });
    expect(r.ok).toBe(true);
    expect((r.data as any).href).toBe(`/jobs/${JOB}?tab=materials&take=i-nut`);
    expect(r.speak).toContain("How many ea?");
  });

  it("the office's card is the crew's card: no price there either", async () => {
    const r = await run({ job_id: JOB, item: "12/2 NM-B", qty: 60 }, "owner");
    expect(JSON.stringify(r)).not.toMatch(/\$|cost|price|value/i);
  });

  it("takes no money in: the input has a job, an item, a count and a unit", () => {
    expect(Object.keys((take.input as any).shape).sort()).toEqual(["item", "job_id", "qty", "unit"]);
    expect(take.input.safeParse({ job_id: JOB }).success).toBe(false);
    expect(take.input.safeParse({ job_id: JOB, item: "12/2", qty: -1 }).success).toBe(false);
  });
});
