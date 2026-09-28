import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * RESIDENTIAL OR COMMERCIAL IS WORKED OUT, NOT ASKED (W2-07): the New Lead form no longer asks it.
 * A lead with a company is commercial, one without is residential; a type a caller sends (Nort's
 * inquiry.create) wins; an edit follows the Company box but never demotes an Industrial lead.
 */
type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({
  inserts: [] as Row[],
  updates: [] as { patch: Row; filters: unknown[][] }[],
  customers: [] as Row[],
}));

function builder(table: string) {
  const filters: unknown[][] = [];
  let patch: Row | null = null;
  let insert: Row | null = null;
  const run = () => {
    if (table === "organizations") return { data: { settings: { timezone: "America/Los_Angeles" } }, error: null };
    if (insert) {
      s.inserts.push(insert);
      return { data: { id: "lead-new" }, error: null };
    }
    if (patch) {
      s.updates.push({ patch, filters });
      return { data: [{ id: "lead-1" }], error: null };
    }
    if (table === "customers") return { data: s.customers, error: null };
    return { data: null, error: null };
  };
  const b: any = {
    select: () => b,
    insert: (r: Row) => ((insert = r), b),
    update: (p: Row) => ((patch = p), b),
    single: async () => run(),
    maybeSingle: async () => run(),
    then: (ok: (v: unknown) => unknown) => Promise.resolve(run()).then(ok),
  };
  for (const m of ["eq", "in", "is", "neq", "or", "order", "limit"]) b[m] = (...a: unknown[]) => (filters.push([m, ...a]), b);
  return b;
}
const client = { from: (t: string) => builder(t), auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) } };

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: client, userId: "office-1", orgId: "org-1" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

const { createInquiry, updateInquiry } = await import("./actions");

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

beforeEach(() => {
  s.inserts = [];
  s.updates = [];
  s.customers = [];
});

describe("a new lead's type", () => {
  it("a company makes it commercial; none, residential", async () => {
    await createInquiry(form({ name: "Pat Test", company_name: "Pine Test Co" }));
    await createInquiry(form({ name: "Rita Moss" }));
    expect(s.inserts.map((r) => r.type)).toEqual(["commercial", "residential"]);
  });

  it("a type a caller sends wins (Nort's inquiry.create)", async () => {
    await createInquiry(form({ name: "Plant Test", type: "industrial" }));
    await createInquiry(form({ name: "Pat Test", company_name: "Pine Test Co", type: "residential" }));
    expect(s.inserts.map((r) => r.type)).toEqual(["industrial", "residential"]);
  });

  it("a company carried across from a customer already on file counts too", async () => {
    s.customers = [{ id: "cust-1", name: "Rita Moss", company_name: "Moss Test LLC", phone: null, email: null, address: null, city: null, state: null, zip: null }];
    await createInquiry(form({ name: "Rita Moss" }));
    expect(s.inserts[0]).toMatchObject({ company_name: "Moss Test LLC", type: "commercial", customer_id: "cust-1" });
  });
});

describe("an edited lead's type", () => {
  it("follows the Company box, written apart, and never over an Industrial lead (nor skipping one with no type yet)", async () => {
    expect(await updateInquiry("lead-1", form({ name: "Pat Test", company_name: "Pine Test Co" }))).toEqual({ ok: true });
    const [edit, typed] = s.updates;
    expect("type" in edit.patch).toBe(false); // the edit itself carries no type
    expect(typed.patch).toEqual({ type: "commercial" });
    expect(typed.filters).toContainEqual(["or", "type.is.null,type.neq.industrial"]);
    s.updates = [];
    await updateInquiry("lead-1", form({ name: "Rita Moss" }));
    expect(s.updates[1].patch).toEqual({ type: "residential" });
  });
});
