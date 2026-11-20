import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE APPOINTMENT FORM'S NEW CUSTOMER GOES THROUGH THE ONE DOOR (cn-v1171). resolveCustomer inserted a
 * typed person without looking; it now goes through lib/crm/new-customer matchOrCreateCustomer, the job
 * forms' own match-then-insert door. A match puts the visit on the customer on file and the answer says
 * so by the name on file (a `notice`, toasted by the form); a new person is made as before and nothing
 * extra is said. Stand-in client; the door itself is stubbed and its arguments pinned.
 */
type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({ inserts: [] as { table: string; row: Row }[], book: [] as Row[] }));

function builder(table: string) {
  let insert: Row | null = null;
  let range: [number, number] = [0, 999];
  const run = () => {
    if (table === "organizations") return { data: { settings: { timezone: "America/Los_Angeles" } }, error: null };
    if (table === "profiles") return { data: { language: "en" }, error: null };
    if (insert) {
      s.inserts.push({ table, row: insert });
      return { data: { id: table === "customers" ? "cust-new" : "appt-1" }, error: null };
    }
    if (table === "customers") return { data: s.book.slice(range[0], range[1] + 1), error: null };
    return { data: null, error: null };
  };
  const b: any = {
    select: () => b,
    insert: (r: Row) => ((insert = r), b),
    range: (from: number, to: number) => ((range = [from, to]), b),
    single: async () => run(),
    maybeSingle: async () => run(),
    then: (ok: (v: unknown) => unknown) => Promise.resolve(run()).then(ok),
  };
  for (const m of ["eq", "in", "is", "neq", "order", "limit"]) b[m] = () => b;
  return b;
}
const client = { from: (t: string) => builder(t), auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) } };

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: client, userId: "office-1", orgId: "org-1" })),
  requireMember: vi.fn(async () => ({ supabase: client, userId: "office-1", orgId: "org-1" })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(async () => {}), deleteCalendarItem: vi.fn(async () => {}) }));
vi.mock("@/lib/notifications", () => ({ notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })) }));
const matchOrCreateCustomer = vi.fn();
vi.mock("@/lib/crm/new-customer", () => ({ matchOrCreateCustomer: (...a: unknown[]) => matchOrCreateCustomer(...a) }));

import { createAppointment } from "./actions";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ title: "Panel look", date: "2026-11-20", start_time: "09:00", starts_at_iso: "2026-11-20T17:00:00.000Z", type: "inspection", ...fields })) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  s.inserts.length = 0;
  s.book = [];
  matchOrCreateCustomer.mockReset();
});

describe("the real door: only a SURE match is taken (cn-v1171, skeptic #74)", () => {
  it("a typed name with another phone than the card on file is another person: a NEW customer, and the visit is theirs", async () => {
    const real = await vi.importActual<typeof import("@/lib/crm/new-customer")>("@/lib/crm/new-customer");
    matchOrCreateCustomer.mockImplementation((...a: unknown[]) => (real.matchOrCreateCustomer as (...x: unknown[]) => unknown)(...a));
    s.book = [{ id: "cust-sam", name: "Sam Tillery", company_name: null, email: null, phone: "(530) 555-0100" }];
    const r = await createAppointment(form({ customer_id: "__new__", new_customer_name: "Sam Tillery", new_customer_phone: "5305550199" }));
    expect(r).toEqual({ ok: true, id: "appt-1" });
    expect(s.inserts.map((i) => i.table)).toEqual(["customers", "appointments"]);
    expect(s.inserts[0].row).toMatchObject({ name: "Sam Tillery", phone: "(530) 555-0199" });
    expect(s.inserts[1].row.customer_id).toBe("cust-new");
    // The same phone is the same person: no customer made.
    s.inserts.length = 0;
    const same = await createAppointment(form({ customer_id: "__new__", new_customer_name: "Sam Tillery", new_customer_phone: "5305550100" }));
    expect(same).toMatchObject({ ok: true, notice: "Sam Tillery is already a customer, so this visit is theirs." });
    expect(s.inserts.map((i) => i.table)).toEqual(["appointments"]);
  });
});

describe("resolveCustomer through matchOrCreateCustomer", () => {
  it("somebody already in the book: the visit is theirs, said by the name on file", async () => {
    matchOrCreateCustomer.mockResolvedValue({ ok: true, id: "cust-sam", matched: true, name: "Sam Tillery" });
    const r = await createAppointment(form({ customer_id: "__new__", new_customer_name: "Sam Tilery", new_customer_phone: "5305550100" }));
    expect(matchOrCreateCustomer).toHaveBeenCalledWith(client, "office-1", { name: "Sam Tilery", phone: "5305550100" });
    expect(r).toMatchObject({ ok: true, id: "appt-1", notice: "Sam Tillery is already a customer, so this visit is theirs." });
    expect(s.inserts.map((i) => i.table)).toEqual(["appointments"]);
    expect(s.inserts[0].row.customer_id).toBe("cust-sam");
  });

  it("a new person is made by the door and nothing extra is said", async () => {
    matchOrCreateCustomer.mockResolvedValue({ ok: true, id: "cust-new", matched: false, name: "Theo Vance" });
    const r = await createAppointment(form({ new_customer_name: "Theo Vance" }));
    expect(r).toEqual({ ok: true, id: "appt-1" });
    expect(s.inserts[0].row.customer_id).toBe("cust-new");
  });

  it("the door's refusal is the answer, and no visit is written", async () => {
    matchOrCreateCustomer.mockResolvedValue({ ok: false, error: "Couldn't check your customer list just now, so no customer was made. Try again." });
    const r = await createAppointment(form({ customer_id: "__new__", new_customer_name: "Casey Loam" }));
    expect(r).toEqual({ ok: false, error: "Couldn't check your customer list just now, so no customer was made. Try again." });
    expect(s.inserts).toEqual([]);
  });

  it("no direct insert into customers is left in resolveCustomer", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/(app)/appointments/actions.ts", "utf8");
    const fn = src.slice(src.indexOf("async function resolveCustomer("), src.indexOf("export async function createAppointment("));
    expect(fn).toContain("matchOrCreateCustomer(supabase, userId,");
    expect(fn).not.toMatch(/from\("customers"\)/);
  });
});
