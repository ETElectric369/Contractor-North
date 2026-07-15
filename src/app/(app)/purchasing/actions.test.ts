import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Regression suite for the materials-list → PO import (Erik's 7/14 field failure:
// a PO "seeded" from a list arrived with ZERO items). Two roots, both guarded here:
//   1. UI — the materials/[id] page never preselected its own list, so the modal
//      quietly sent source_list_id: null ("— Start empty —").
//   2. Action — createPurchaseOrder swallowed the item-seeding result, so ANY
//      failure there produced a silently-empty PO instead of an error.
// The DB path itself was proven healthy by an authed live replay (org_id stamp
// trigger + RLS both pass), so these tests pin the code-side contract.

const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => state.client),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createPurchaseOrder } from "./actions";

type Call = { table: string; verb: string; payload?: any };

/** Minimal scriptable PostgREST-builder fake: every chained method returns the
 *  chain; awaiting it (or .single()/.maybeSingle()) dequeues the next scripted
 *  result for `<table>.<verb>`. Unscripted calls throw, so the tests also pin
 *  WHICH statements run. */
function fakeSupabase(script: Record<string, any[]>, calls: Call[]) {
  const next = (key: string) => {
    const q = script[key];
    if (!q || q.length === 0) throw new Error(`unscripted call: ${key}`);
    return q.shift();
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from(table: string) {
      let verb = "select";
      const chain: any = {
        insert(payload: any) { verb = "insert"; calls.push({ table, verb, payload }); return chain; },
        update(payload: any) { verb = "update"; calls.push({ table, verb, payload }); return chain; },
        delete() { verb = "delete"; calls.push({ table, verb }); return chain; },
        select() { if (verb === "select") calls.push({ table, verb }); return chain; },
        eq() { return chain; },
        order() { return chain; },
        single: () => Promise.resolve(next(`${table}.${verb}`)),
        maybeSingle: () => Promise.resolve(next(`${table}.${verb}`)),
        then(resolve: any, reject: any) {
          try { resolve(next(`${table}.${verb}`)); } catch (e) { reject?.(e); }
        },
      };
      return chain;
    },
  };
}

let calls: Call[];
beforeEach(() => { calls = []; });

describe("createPurchaseOrder — seeding from a material list", () => {
  it("copies every list item onto the PO and stamps source_list_id provenance", async () => {
    state.client = fakeSupabase(
      {
        "material_lists.select": [{ data: { id: "list-1" }, error: null }],
        "material_list_items.select": [{
          data: [
            { description: "Brown accordion cover", part_number: null, quantity: 4, unit: "ea", est_cost: null },
            { description: "Mud ring", part_number: "MR-1", quantity: 1, unit: null, est_cost: "2.5" },
          ],
          error: null,
        }],
        "purchase_orders.insert": [{ data: { id: "po-1" }, error: null }],
        "purchase_order_items.insert": [{ error: null }],
        // recalcPoTotals
        "purchase_order_items.select": [{ data: [{ line_total: 0 }, { line_total: 2.5 }], error: null }],
        "purchase_orders.update": [{ error: null }],
      },
      calls,
    );

    const res = await createPurchaseOrder({ vendor: "CED", job_id: null, source_list_id: "list-1" });
    expect(res).toEqual({ ok: true, id: "po-1" });

    const poInsert = calls.find((c) => c.table === "purchase_orders" && c.verb === "insert");
    expect(poInsert?.payload.source_list_id).toBe("list-1");

    const itemsInsert = calls.find((c) => c.table === "purchase_order_items" && c.verb === "insert");
    expect(itemsInsert?.payload).toEqual([
      { po_id: "po-1", description: "Brown accordion cover", part_number: null, quantity: 4, unit: "ea", unit_cost: 0, sort_order: 0 },
      { po_id: "po-1", description: "Mud ring", part_number: "MR-1", quantity: 1, unit: "ea", unit_cost: 2.5, sort_order: 1 },
    ]);
  });

  it("a failed items insert is LOUD: rolls the shell PO back and returns the error (was silently swallowed)", async () => {
    state.client = fakeSupabase(
      {
        "material_lists.select": [{ data: { id: "list-1" }, error: null }],
        "material_list_items.select": [{
          data: [{ description: "Wire", part_number: null, quantity: 1, unit: "ea", est_cost: null }],
          error: null,
        }],
        "purchase_orders.insert": [{ data: { id: "po-1" }, error: null }],
        "purchase_order_items.insert": [{ error: { message: "rls says no" } }],
        "purchase_orders.delete": [{ error: null }],
      },
      calls,
    );

    const res = await createPurchaseOrder({ vendor: "CED", job_id: null, source_list_id: "list-1" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("rls says no");
    // The misleading empty PO must not survive.
    expect(calls.some((c) => c.table === "purchase_orders" && c.verb === "delete")).toBe(true);
    // And totals must not be recalculated on a rolled-back PO.
    expect(calls.some((c) => c.table === "purchase_orders" && c.verb === "update")).toBe(false);
  });

  it("an invisible/foreign list id fails BEFORE any PO exists", async () => {
    state.client = fakeSupabase(
      { "material_lists.select": [{ data: null, error: null }] },
      calls,
    );
    const res = await createPurchaseOrder({ vendor: "CED", job_id: null, source_list_id: "not-mine" });
    expect(res.ok).toBe(false);
    expect(calls.some((c) => c.table === "purchase_orders" && c.verb === "insert")).toBe(false);
  });

  it("no source list still creates a plain empty PO (source_list_id null)", async () => {
    state.client = fakeSupabase(
      { "purchase_orders.insert": [{ data: { id: "po-2" }, error: null }] },
      calls,
    );
    const res = await createPurchaseOrder({ vendor: "", job_id: "job-1", source_list_id: null });
    expect(res).toEqual({ ok: true, id: "po-2" });
    const poInsert = calls.find((c) => c.table === "purchase_orders" && c.verb === "insert");
    expect(poInsert?.payload).toMatchObject({ vendor: "CED", job_id: "job-1", source_list_id: null });
  });
});

describe("materials/[id] page wiring — the field bug's other half", () => {
  it("passes defaultListId to NewPoButton so 'New PO' on a list page seeds THAT list", () => {
    // Source guard (repo has precedent for meta-guards; see tests/ci-guard.test.ts):
    // without the preselect, the modal's list dropdown sits on "— Start empty —"
    // and the PO imports zero items — exactly the 7/14 field failure.
    const page = readFileSync(
      fileURLToPath(new URL("../materials/[id]/page.tsx", import.meta.url)),
      "utf8",
    );
    expect(page).toMatch(/defaultListId=\{l\.id\}/);
  });
});
