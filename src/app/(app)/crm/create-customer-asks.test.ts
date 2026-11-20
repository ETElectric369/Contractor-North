import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * NO DOOR MAKES A CUSTOMER BLIND (cn-v1171). createCustomer is the door the New Customer form, the quick
 * pickers and the assistant all go through, and it inserted without looking. Now it reads the book and
 * asks the one matcher (lib/crm/duplicates findCustomerMatch) on what will be STORED; on a match it makes
 * nothing and says who, in the reader's language, unless the form posted allow_duplicate=1. A book that
 * cannot be read is a refusal, never a blind insert. The CSV import skips by the same matcher. Driven
 * against a stand-in client; house stand-in people only.
 */
type Row = Record<string, any>;
const db = vi.hoisted(() => ({
  language: "en" as string,
  book: [] as Row[],
  bookError: null as null | { message: string },
  inserts: [] as Row[],
  updates: [] as Row[],
  bookReads: 0,
}));

function builder(table: string) {
  let op: "select" | "insert" | "update" = "select";
  let cols = "";
  let payload: any = null;
  let range: [number, number] | null = null;
  const run = () => {
    if (table === "profiles") return { data: { language: db.language }, error: null };
    if (table === "customers" && op === "update") {
      db.updates.push(payload);
      return { data: [{ id: "cust-sam" }], error: null };
    }
    if (table === "customers" && op === "insert") {
      db.inserts.push(...(Array.isArray(payload) ? payload : [payload]));
      return { data: { id: "cust-new" }, error: null };
    }
    if (table === "customers") {
      db.bookReads += 1;
      expect(cols).toBe("id, name, company_name, email, phone");
      // cn-v1171 (skeptic #74): the book is read whole, page by page (lib/crm/new-customer readCustomerBook).
      expect(range).not.toBeNull();
      return db.bookError ? { data: null, error: db.bookError } : { data: db.book.slice(range![0], range![1] + 1), error: null };
    }
    return { data: null, error: null };
  };
  const b: any = {
    select: (c?: string) => ((cols = c ?? ""), b),
    insert: (p: any) => ((op = "insert"), (payload = p), b),
    update: (p: any) => ((op = "update"), (payload = p), b),
    eq: () => b,
    order: () => b,
    limit: () => b,
    range: (from: number, to: number) => ((range = [from, to]), b),
    maybeSingle: async () => run(),
    single: async () => run(),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
  };
  return b;
}
const fresh = () => ({ from: (t: string) => builder(t), auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) } });

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => fresh()), createServiceClient: vi.fn(() => fresh()) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: async () => ({ supabase: fresh(), userId: "office-1", orgId: "org-1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/pdf-cache", () => ({ bustCustomerPdfs: vi.fn(async () => {}) }));

import { bulkImportCustomers, createCustomer, updateCustomer } from "./actions";

const SAM = { id: "cust-sam", name: "Sam Tillery", company_name: null, email: "sam@example.test", phone: "(530) 555-0100" };
const DANA = { id: "cust-dana", name: "Dana Rook", company_name: null, email: null, phone: null };
const form = (f: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(f)) fd.set(k, v);
  return fd;
};

beforeEach(() => {
  db.language = "en";
  db.book = [SAM, DANA];
  db.bookError = null;
  db.inserts = [];
  db.updates = [];
  db.bookReads = 0;
});

describe("updateCustomer writes the Pricing Level only when the form posted it (cn-v1171, skeptic #74)", () => {
  it("a door that draws no level (the job page, the estimate's card) leaves the column alone", async () => {
    expect(await updateCustomer("cust-sam", form({ name: "Sam Tillery" }))).toEqual({ ok: true });
    expect(db.updates[0]).not.toHaveProperty("pricing_level_id");
  });
  it("the customer page's own Edit: a level is written, and the Default choice clears it", async () => {
    await updateCustomer("cust-sam", form({ name: "Sam Tillery", pricing_level_id: "pl-1" }));
    await updateCustomer("cust-sam", form({ name: "Sam Tillery", pricing_level_id: "" }));
    expect(db.updates.map((u) => u.pricing_level_id)).toEqual(["pl-1", null]);
  });
});

describe("createCustomer asks the book first", () => {
  it("same phone, typed under another spelling: nothing made, the name ON FILE said, the match handed back", async () => {
    const r = await createCustomer(form({ name: "Sam Tilery", phone: "530-555-0100" }));
    expect(r).toEqual({ ok: false, error: "Sam Tillery is already a customer (same phone).", duplicate: { id: "cust-sam", name: "Sam Tillery", reason: "phone" } });
    expect(db.inserts).toEqual([]);
  });

  it("same email; same name (unique in the book); each in Spanish too", async () => {
    expect(await createCustomer(form({ name: "S. Tillery", email: "SAM@example.test " }))).toMatchObject({ error: "Sam Tillery is already a customer (same email).", duplicate: { reason: "email" } });
    expect(await createCustomer(form({ name: "dana rook" }))).toMatchObject({ error: "Dana Rook is already a customer (same name).", duplicate: { id: "cust-dana", reason: "name" } });
    db.language = "es";
    expect((await createCustomer(form({ name: "Sam Tilery", phone: "5305550100" }))).error).toBe("Sam Tillery ya es cliente (mismo teléfono).");
    expect((await createCustomer(form({ name: "Dana Rook" }))).error).toBe("Dana Rook ya es cliente (mismo nombre).");
    expect(db.inserts).toEqual([]);
  });

  it("a bare phone is matched on what would be stored (its name defaults to the phone)", async () => {
    expect(await createCustomer(form({ phone: "5305550100" }))).toMatchObject({ ok: false, duplicate: { id: "cust-sam", reason: "phone" } });
  });

  it("an empty name on file: the typed one is said", async () => {
    db.book = [{ ...SAM, name: null }];
    expect((await createCustomer(form({ name: "Theo Vance", phone: "5305550100" }))).error).toBe("Theo Vance is already a customer (same phone).");
  });

  it("allow_duplicate=1 makes the typed one without reading the book", async () => {
    const r = await createCustomer(form({ name: "Sam Tillery", phone: "5305550100", allow_duplicate: "1" }));
    expect(r).toEqual({ ok: true, id: "cust-new" });
    expect(db.bookReads).toBe(0);
    expect(db.inserts).toHaveLength(1);
  });

  it("sure_match_only=1 (the assistant): a same-name card with another phone is another person, and is made (cn-v1171, skeptic #74)", async () => {
    const r = await createCustomer(form({ name: "Sam Tillery", phone: "5305550199", sure_match_only: "1" }));
    expect(r).toEqual({ ok: true, id: "cust-new" });
    expect(db.inserts.map((x) => x.phone)).toEqual(["(530) 555-0199"]);
    // A sure hit is still a refusal, and without the field the doubtful hit is still ASKED.
    expect(await createCustomer(form({ name: "Sam Tilery", phone: "5305550100", sure_match_only: "1" }))).toMatchObject({ ok: false, duplicate: { reason: "phone" } });
    expect(await createCustomer(form({ name: "Sam Tillery", phone: "5305550199" }))).toMatchObject({ ok: false, duplicate: { id: "cust-sam", reason: "name", disagrees: true } });
  });

  it("a book past one page is read whole: a person on file after the first thousand is still found", async () => {
    db.book = [...Array.from({ length: 1000 }, (_, i) => ({ id: `cust-${String(i).padStart(4, "0")}`, name: `Filler ${i}`, company_name: null, email: null, phone: null })), SAM];
    expect(await createCustomer(form({ name: "Sam Tilery", phone: "5305550100" }))).toMatchObject({ ok: false, duplicate: { id: "cust-sam" } });
    expect(db.bookReads).toBe(2);
  });

  it("a book that cannot be read is a refusal, never a blind insert", async () => {
    db.bookError = { message: "down" };
    expect(await createCustomer(form({ name: "Casey Loam" }))).toEqual({ ok: false, error: "Couldn't check your customer list just now, so no customer was made. Try again." });
    expect(db.inserts).toEqual([]);
  });

  it("a new person is made, every column the insert writes pinned", async () => {
    const r = await createCustomer(
      form({ name: "Casey Loam", company_name: "Northline Supply", type: "commercial", status: "inactive", email: "casey@example.test", phone: "5305550199", address: "4 Catbird Ct", city: "bayberry", state: "ca", zip: "96161", notes: "Gate code at the office" }),
    );
    expect(r).toEqual({ ok: true, id: "cust-new" });
    expect(db.inserts).toEqual([
      {
        name: "Casey Loam",
        company_name: "Northline Supply",
        type: "commercial",
        status: "inactive",
        email: "casey@example.test",
        phone: "(530) 555-0199",
        address: "4 Catbird Ct",
        city: "Bayberry",
        state: "CA",
        zip: "96161",
        notes: "Gate code at the office",
        created_by: "office-1",
      },
    ]);
  });
});

describe("the CSV import skips by the same matcher", () => {
  it("a person on file by phone or email is skipped; one person listed twice is imported once", async () => {
    const r = await bulkImportCustomers([
      { name: "Sam Tilery", phone: "530 555 0100" },
      { name: "Somebody", email: "sam@example.test" },
      { name: "Theo Vance", phone: "5305550111" },
      { name: "T. Vance", phone: "(530) 555-0111" },
    ]);
    expect(r).toEqual({ ok: true, imported: 1, skipped: 3 });
    expect(db.inserts.map((x) => x.name)).toEqual(["Theo Vance"]);
  });

  it("a same-name row with another phone is another person and is imported; listed twice, once (cn-v1171, skeptic #74)", async () => {
    const r = await bulkImportCustomers([
      { name: "Sam Tillery", phone: "5305550199" },
      { name: "Sam Tillery", phone: "5305550199" },
      { name: "Sam Tillery" },
    ]);
    // The third has no phone: the name is now two cards in the book, so it is not taken for either.
    expect(r).toEqual({ ok: true, imported: 2, skipped: 1 });
    expect(db.inserts.map((x) => x.phone)).toEqual(["(530) 555-0199", null]);
  });

  it("a book that cannot be read imports nothing", async () => {
    db.bookError = { message: "down" };
    expect(await bulkImportCustomers([{ name: "Theo Vance" }])).toEqual({ ok: false, error: "Couldn't check your customer list just now, so nothing was imported. Try again." });
    expect(db.inserts).toEqual([]);
  });
});
