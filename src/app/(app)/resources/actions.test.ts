import { describe, it, expect, vi, beforeEach } from "vitest";

// Resources were written with no guard: RLS refused a tech's save with a raw policy error, and a
// tech's Edit or Delete matched zero rows and said "Contact deleted" (Wave 0). Now: staff only,
// said in words, and a write that changes nothing says so.
// And (W2-13) suppliers and subcontractors live in Price List › Vendors: a new contact can't be one,
// and a contact that already is one keeps its category through an edit.
const state = vi.hoisted(() => ({
  ctx: null as any,
  rows: [] as unknown[] | null,
  error: null as unknown,
  /** The row as it's stored, for the edit's "does it already have that category?" read. */
  stored: null as { category: string | null } | null,
  writes: [] as { op: string; row?: Record<string, unknown> }[],
}));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => state.ctx) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createResource, deleteResource, updateResource } from "./actions";
import { RESOURCE_CATEGORIES, SUPPLIERS_LIVE_IN_VENDORS, categoryChoices, isSupplierCategory } from "./categories";
import { resourceActions } from "@/lib/actions/entities/resource";

function client() {
  const chain: any = {
    insert: (row: Record<string, unknown>) => (state.writes.push({ op: "insert", row }), chain),
    update: (row: Record<string, unknown>) => (state.writes.push({ op: "update", row }), chain),
    delete: () => (state.writes.push({ op: "delete" }), chain),
    eq: () => chain,
    select: () => chain,
    maybeSingle: async () => ({ data: state.stored, error: null }),
    then: (ok: any, err?: any) => Promise.resolve({ data: state.rows, error: state.error }).then(ok, err),
  };
  return { from: () => chain };
}

beforeEach(() => {
  state.ctx = { supabase: client(), userId: "u1", orgId: "org-1" };
  state.rows = [{ id: "r1" }];
  state.error = null;
  state.stored = null;
  state.writes = [];
});

describe("resources: staff only, and never silent", () => {
  it("refuses a tech in words before touching the table", async () => {
    state.ctx = { error: "This action is staff-only." };
    expect(await createResource({ name: "County Building" })).toEqual({ ok: false, error: "This action is staff-only." });
    expect(await updateResource("r1", { name: "County Building" })).toEqual({ ok: false, error: "This action is staff-only." });
    expect(await deleteResource("r1")).toEqual({ ok: false, error: "This action is staff-only." });
  });

  it("says so when an edit or a delete changes no row", async () => {
    state.rows = [];
    expect(await updateResource("gone", { name: "County Building" })).toMatchObject({ ok: false });
    expect(await deleteResource("gone")).toMatchObject({ ok: false });
    expect(await createResource({ name: "County Building" })).toMatchObject({ ok: false });
  });

  it("is ok when the row came back", async () => {
    expect(await createResource({ name: "County Building" })).toEqual({ ok: true });
    expect(await updateResource("r1", { name: "County Building" })).toEqual({ ok: true });
    expect(await deleteResource("r1")).toEqual({ ok: true });
  });
});

describe("suppliers and subcontractors live in Price List › Vendors (W2-13)", () => {
  it("the list is the one home for the people a job answers to, in its order, with no Supplier / Distributor", () => {
    expect(RESOURCE_CATEGORIES).toEqual(["Building Department", "Inspector", "Permit Portal", "Utility", "Fire / AHJ", "Engineer", "Other"]);
    expect(SUPPLIERS_LIVE_IN_VENDORS).toBe("Suppliers and subcontractors live in Price List › Vendors.");
  });

  it("a new contact can't be a supplier: refused on create in the form's words, and nothing is written", async () => {
    for (const category of ["Supplier / Distributor", "supplier / distributor", "Supplier", "Electrical Vendors", "Subcontractor", "Sub-contractors"]) {
      expect(await createResource({ name: "Acme Electric Supply", category }), category).toEqual({ ok: false, error: SUPPLIERS_LIVE_IN_VENDORS });
    }
    expect(state.writes).toEqual([]);
  });

  it("every category on the list still saves (and none of them reads as a supplier)", async () => {
    for (const category of RESOURCE_CATEGORIES) {
      expect(isSupplierCategory(category), category).toBe(false);
      expect(await createResource({ name: "County Building", category }), category).toEqual({ ok: true });
    }
  });

  it("a contact that already is one keeps its category through an edit", async () => {
    state.stored = { category: "Supplier / Distributor" };
    expect(await updateResource("r1", { name: "Acme Electric Supply", category: "Supplier / Distributor", phone: "5305550150" })).toEqual({ ok: true });
    expect(state.writes).toEqual([{ op: "update", row: expect.objectContaining({ name: "Acme Electric Supply", category: "Supplier / Distributor" }) }]);
  });

  it("an edit can't turn another contact into one", async () => {
    state.stored = { category: "Inspector" };
    expect(await updateResource("r1", { name: "Acme Electric Supply", category: "Supplier / Distributor" })).toEqual({ ok: false, error: SUPPLIERS_LIVE_IN_VENDORS });
    state.stored = null; // not found (or another company's): said, never a quiet save
    expect(await updateResource("r1", { name: "Acme Electric Supply", category: "Supplier / Distributor" })).toEqual({
      ok: false,
      error: "That contact wasn't found, so nothing changed.",
    });
    expect(state.writes).toEqual([]);
  });

  it("the picker shows an old category as the contact's current pick, disabled, so a save never swaps it", () => {
    const old = categoryChoices("Supplier / Distributor");
    expect(old.slice(0, RESOURCE_CATEGORIES.length).every((c) => !c.disabled)).toBe(true);
    expect(old.at(-1)).toEqual({ value: "Supplier / Distributor", disabled: true });
    expect(categoryChoices("Inspector")).toHaveLength(RESOURCE_CATEGORIES.length);
    expect(categoryChoices("")).toHaveLength(RESOURCE_CATEGORIES.length);
  });

  it("Nort's resource.create names the Vendors tab, offers no supplier, and is refused through createResource in the same words", async () => {
    const create = resourceActions["resource.create"];
    expect(create.description).toContain("Price List › Vendors (the Vendors tab)");
    expect(create.description).not.toMatch(/supplier, vendor, subcontractor, rental yard/);
    expect(await create.handler({ name: "Acme Electric Supply", category: "Supplier" }, {} as any)).toEqual({ ok: false, error: SUPPLIERS_LIVE_IN_VENDORS });
    expect(state.writes).toEqual([]);
  });
});
