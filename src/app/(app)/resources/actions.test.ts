import { describe, it, expect, vi, beforeEach } from "vitest";

// Resources were written with no guard: RLS refused a tech's save with a raw policy error, and a
// tech's Edit or Delete matched zero rows and said "Contact deleted" (Wave 0). Now: staff only,
// said in words, and a write that changes nothing says so.
const state = vi.hoisted(() => ({ ctx: null as any, rows: [] as unknown[] | null, error: null as unknown }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => state.ctx) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { createResource, deleteResource, updateResource } from "./actions";

function client() {
  const chain: any = {
    insert: () => chain,
    update: () => chain,
    delete: () => chain,
    eq: () => chain,
    select: () => Promise.resolve({ data: state.rows, error: state.error }),
  };
  return { from: () => chain };
}

beforeEach(() => {
  state.ctx = { supabase: client(), userId: "u1", orgId: "org-1" };
  state.rows = [{ id: "r1" }];
  state.error = null;
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
