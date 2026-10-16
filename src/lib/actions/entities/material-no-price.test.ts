import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * NO PRICE ON A MATERIALS LINE THROUGH NORT (Erik, 2026-10-15, the night after cn-v1108 took the
 * prices off the materials checklist: "Nort doesn't need to be filling in any hidden material lines").
 * A price said with the line used to land in est_cost, a column no screen shows any more. Now it is
 * never stored, and the person is TOLD it wasn't kept (nothing silent). The price book, through the
 * estimate's take-off, and the supplier's bill are the cost. A vendor is a word, not money: the
 * office's still lands; a tech's is dropped with the office's-to-set sentence as before.
 */
const { db } = vi.hoisted(() => ({
  db: {
    adds: [] as Record<string, unknown>[],
    job: { id: "8760a051-0000-4000-8000-000000000011", job_number: "J-011", name: "Honeysuckle" } as Record<string, unknown>,
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/app/(app)/materials/actions", () => ({
  addMaterialItem: vi.fn(async (_listId: string, draft: Record<string, unknown>) => (db.adds.push(draft), { ok: true, id: "row-1" })),
  ensureJobMaterialList: vi.fn(async () => ({ ok: true, id: "list-1" })),
  deleteMaterialItem: vi.fn(),
  setMaterialItemPurchased: vi.fn(),
}));
function fakeClient() {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const k of ["select", "eq", "order", "limit"]) chain[k] = () => chain;
      chain.maybeSingle = async () => {
        if (table === "jobs") return { data: db.job, error: null };
        if (table === "material_list_items") {
          const last = db.adds[db.adds.length - 1] ?? {};
          return { data: { id: "row-1", description: last.description, quantity: last.quantity, unit: last.unit, purchased: false }, error: null };
        }
        return { data: null, error: null };
      };
      return chain;
    },
  };
}
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => fakeClient()) }));

import { REGISTRY } from "../registry";

const JOB = "8760a051-0000-4000-8000-000000000011";
const ORG = "60195593-2e18-4230-bc8e-7a32d36d038d";
const add = REGISTRY["material.addLine"];
const run = (input: Record<string, unknown>, role: string) => add.handler(add.input.parse(input), { userId: "u", orgId: ORG, role });

beforeEach(() => {
  db.adds.length = 0;
});

describe("material.addLine keeps no price", () => {
  it("the office says a price: the line lands without it, and the reply says the price wasn't kept", async () => {
    const r = await run({ job_id: JOB, description: "20A breaker", quantity: 2, est_cost: 8 }, "owner");
    expect(r.ok).toBe(true);
    expect(db.adds).toHaveLength(1);
    expect(db.adds[0]).toMatchObject({ description: "20A breaker", quantity: 2, unit: "ea", est_cost: null });
    expect(r.recorded).toContain("Added: 2 ea 20A breaker to the ");
    expect(r.recorded).not.toContain("est.");
    expect(r.recorded).not.toContain("$");
    expect(r.warning).toBe("The $8.00 wasn't kept: the materials list carries no prices — the price book and the supplier's bill are the cost.");
  });

  it("no price said: no warning, nothing about money in the reply", async () => {
    const r = await run({ job_id: JOB, description: "20A breaker" }, "owner");
    expect(r.ok).toBe(true);
    expect(db.adds[0]).toMatchObject({ est_cost: null });
    expect(r.warning).toBeUndefined();
    expect(r.recorded).not.toContain("$");
  });

  it("a vendor the office says still lands and is read back — a word, not money", async () => {
    const r = await run({ job_id: JOB, description: "20A breaker", vendor: "Northline Supply" }, "owner");
    expect(db.adds[0]).toMatchObject({ vendor: "Northline Supply", est_cost: null });
    expect(r.recorded).toContain("from Northline Supply");
    expect(r.warning).toBeUndefined();
  });

  it("a tech's vendor, tool flag and price are all dropped, and BOTH sentences are said", async () => {
    const r = await run({ job_id: JOB, description: "20A breaker", vendor: "Northline Supply", est_cost: 8, is_tool: true }, "tech");
    expect(r.ok).toBe(true);
    expect(db.adds[0]).toMatchObject({ vendor: null, est_cost: null, is_tool: false });
    expect(r.warning).toBe(
      "The vendor and the tool flag are the office's to set — the line was added without them. The $8.00 wasn't kept: the materials list carries no prices — the price book and the supplier's bill are the cost.",
    );
    expect(r.recorded).not.toContain("$");
  });

  it("a tech who says only a vendor hears only the office sentence; a zero is not a price said", async () => {
    const r = await run({ job_id: JOB, description: "20A breaker", vendor: "Northline Supply", est_cost: 0 }, "tech");
    expect(r.warning).toBe("The vendor and the tool flag are the office's to set — the line was added without them.");
    const z = await run({ job_id: JOB, description: "20A breaker", est_cost: 0 }, "owner");
    expect(z.warning).toBeUndefined();
  });
});

describe("the source", () => {
  it("material.ts never stores est_cost and never reads a price back", () => {
    const src = readFileSync(resolve(__dirname, "material.ts"), "utf8");
    expect(src).toContain("est_cost: null,");
    expect(src).not.toContain("est_cost: staff ?");
    expect(src).not.toContain("est. $");
    expect(src).toContain("A price said with the line is NOT kept");
  });
});
