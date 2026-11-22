import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A NEW LEAD LINKS TO A CUSTOMER ONLY ON A SURE MATCH (cn-v1178, A1).
 *
 * New Lead ran the older name-only matcher: a caller typed as "Sam Tillery" with his own phone was linked
 * to the one other Sam Tillery in the book, that stranger's email was carried into the empty box, and
 * every later door (the estimate, the customer's own Accept, Won, Book It) trusted the link. createInquiry
 * now asks the one matcher every other door asks (lib/crm/duplicates sureCustomerMatch) over the same
 * book read: a phone, then an email, then a name that is no placeholder, the only one of its kind, and
 * contradicted by nothing typed. A name that is not sure links nothing and says why.
 *
 * The stand-in answers the book read with every customer of the company and records the lead it inserts;
 * a failed book read is a failed read, never "nobody".
 */
type Row = Record<string, any>;
const db = vi.hoisted(() => ({ customers: [] as Row[], inserted: null as Row | null, bookFails: false }));

function builder(table: string) {
  let op: "select" | "insert" = "select";
  let patch: Row | null = null;
  const run = () => {
    if (table === "profiles") return { data: { language: "en" }, error: null };
    if (op === "insert") {
      db.inserted = patch;
      return { data: { id: "lead-new" }, error: null };
    }
    if (table === "customers") return db.bookFails ? { data: null, error: { message: "timeout" } } : { data: db.customers.map((c) => ({ ...c })), error: null };
    return { data: [], error: null };
  };
  const b: any = {
    select: () => b,
    insert: (p: Row) => ((op = "insert"), (patch = p), b),
    maybeSingle: async () => {
      const r = run();
      return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: r.error };
    },
    single: async () => run(),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run()).then(ok, bad),
  };
  for (const m of ["eq", "neq", "in", "is", "or", "not", "gte", "lt", "order", "limit"]) b[m] = () => b;
  return b;
}
const client = () => ({ from: (t: string) => builder(t), auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) } });

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client()), createServiceClient: vi.fn(() => client()) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: async () => ({ supabase: client(), userId: "office-1", orgId: "org-1" }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: async () => false }));
vi.mock("../schedule/actions", () => ({ planDayTimes: vi.fn() }));
vi.mock("../quotes/actions", () => ({ saveQuote: vi.fn() }));
vi.mock("@/lib/plan-brief-run", () => ({ runPlanBrief: vi.fn() }));

import { createInquiry } from "./actions";

/** The Sam Tillery already on file: a phone and an email of his own, at Larkspur. */
const SAM_ON_FILE = { id: "c-sam", name: "Sam Tillery", phone: "(530) 555-0142", email: "sam.larkspur@example.test", address: "4 Larkspur Ln", city: "Thistlewood", state: "CA", zip: "96161", company_name: null };
const DANA = { id: "c-dana", name: "Dana Rook", phone: "(530) 555-0199", email: null, address: null, city: null, state: null, zip: null, company_name: null };
const UNKNOWN = { id: "c-unknown", name: "Unknown caller", phone: "(530) 555-0111", email: null, address: null, city: null, state: null, zip: null, company_name: null };

const form = (f: Record<string, string>) => {
  const d = new FormData();
  for (const [k, v] of Object.entries(f)) d.set(k, v);
  return d;
};

beforeEach(() => {
  db.customers = [SAM_ON_FILE, DANA, UNKNOWN];
  db.inserted = null;
  db.bookFails = false;
});

describe("createInquiry links a lead only on a sure match", () => {
  it("a same-name stranger with a DIFFERENT phone is not linked, nothing of theirs is carried, and the office is told why", async () => {
    const res = await createInquiry(form({ name: "Sam Tillery", phone: "(530) 555-0100" }));
    expect(res.ok).toBe(true);
    expect(db.inserted!.customer_id).toBeNull();
    expect(db.inserted!.email ?? null).toBeNull();
    expect(db.inserted!.address ?? null).toBeNull();
    expect(res.note).toBe(
      'A customer named "Sam Tillery" is already on file with a different phone or email, so this lead isn\'t linked to them. If they are one person, Find Duplicates shows the pair.',
    );
  });

  it("the same name with the SAME phone is the customer: linked, and their email carried into the empty box", async () => {
    const res = await createInquiry(form({ name: "Sam Tillery", phone: "530-555-0142" }));
    expect(db.inserted!.customer_id).toBe("c-sam");
    expect(db.inserted!.email).toBe("sam.larkspur@example.test");
    expect(res.note).toContain("Linked to Sam Tillery");
  });

  it("a phone on file links whatever name was typed (the phone is the person)", async () => {
    await createInquiry(form({ name: "Dana", phone: "5305550199" }));
    expect(db.inserted!.customer_id).toBe("c-dana");
  });

  it("a unique name with nothing typed to contradict it still links, as every other door's rule says", async () => {
    await createInquiry(form({ name: "dana rook" }));
    expect(db.inserted!.customer_id).toBe("c-dana");
  });

  it("a placeholder name never links, and the first caller's phone is not carried onto the second", async () => {
    const res = await createInquiry(form({ name: "Unknown caller", message: "call me back" }));
    expect(db.inserted!.customer_id).toBeNull();
    expect(db.inserted!.phone ?? null).toBeNull();
    expect(res.note).toBeUndefined();
  });

  it("two customers of that name and no phone or email: neither, said as before", async () => {
    db.customers = [SAM_ON_FILE, { ...SAM_ON_FILE, id: "c-sam-2", phone: null, email: null }];
    const res = await createInquiry(form({ name: "Sam Tillery" }));
    expect(db.inserted!.customer_id).toBeNull();
    expect(res.note).toContain('You have 2 customers named "Sam Tillery"');
  });

  it("a failed read of the book is said, and links nothing", async () => {
    db.bookFails = true;
    const res = await createInquiry(form({ name: "Dana Rook" }));
    expect(res.ok).toBe(true);
    expect(db.inserted!.customer_id).toBeNull();
    expect(res.note).toBe("Couldn't check your customers just now, so this lead isn't linked to anyone yet.");
  });
});
