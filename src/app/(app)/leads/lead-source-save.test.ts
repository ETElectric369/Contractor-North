import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * WHERE A LEAD CAME FROM, AS SAVED (cn-v1170). The form's Lead Source posts a label of the company's
 * list: create stores it trimmed and cut at 60, or 'manual' when nothing was picked; an edit with
 * nothing picked leaves the stored source alone (a website lead keeps its door). Neither door writes
 * work_kind or planned_minutes any more, nor a follow-up day. Sparse callers (the visit's New Lead,
 * the assistant) post no source and still save. Stand-in client in lead-type.test's style.
 */
type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({ inserts: [] as Row[], updates: [] as Row[] }));

function builder(table: string) {
  let patch: Row | null = null;
  let insert: Row | null = null;
  const run = () => {
    if (insert) {
      s.inserts.push(insert);
      return { data: { id: "lead-new" }, error: null };
    }
    if (patch) {
      s.updates.push(patch);
      return { data: [{ id: "lead-1" }], error: null };
    }
    if (table === "customers") return { data: [], error: null };
    if (table === "inquiries") return { data: { type: "residential" }, error: null };
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
  for (const m of ["eq", "in", "is", "neq", "or", "order", "limit"]) b[m] = () => b;
  return b;
}
const client = { from: (t: string) => builder(t), auth: { getUser: async () => ({ data: { user: { id: "office-1" } } }) } };

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client), createServiceClient: vi.fn(() => client) }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: client, userId: "office-1", orgId: "org-1" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/pdf-cache", () => ({ bustLeadPdfs: vi.fn(async () => {}), bustBillsOfQuotes: vi.fn(), bustDocPdf: vi.fn() }));

const { createInquiry, updateInquiry } = await import("./actions");

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

beforeEach(() => {
  s.inserts = [];
  s.updates = [];
});

const NEVER = ["work_kind", "planned_minutes", "next_follow_up_at"];

describe("createInquiry's source", () => {
  it("a picked label is stored trimmed; one not on the list is still taken", async () => {
    await createInquiry(form({ name: "Sam Tillery", source: "  Word   of Mouth " }));
    await createInquiry(form({ name: "Sam Tillery", source: "A Label Since Removed" }));
    expect(s.inserts.map((r) => r.source)).toEqual(["Word of Mouth", "A Label Since Removed"]);
  });

  it("cut at 60 characters", async () => {
    await createInquiry(form({ name: "Sam Tillery", source: "x".repeat(80) }));
    expect(s.inserts[0].source).toBe("x".repeat(60));
  });

  it("nothing picked, or a sparse caller that posts no source, stores 'manual'", async () => {
    await createInquiry(form({ name: "Sam Tillery", source: "" }));
    await createInquiry(form({ name: "Theo Vance", phone: "5305550101" })); // the visit sheet's New Lead
    await createInquiry(form({ name: "Casey Loam", address: "9 Bayberry Ct", city: "Testville", state: "CA", zip: "96161" }));
    expect(s.inserts.map((r) => r.source)).toEqual(["manual", "manual", "manual"]);
    expect(s.inserts[2]).toMatchObject({ address: "9 Bayberry Ct", city: "Testville", state: "CA", zip: "96161" });
  });

  it("writes no kind, no length and no follow-up day, even when an old form posts them", async () => {
    await createInquiry(form({ name: "Sam Tillery", work_kind: "service", planned_minutes: "120", message: "Swap a breaker" }));
    for (const k of NEVER) expect(s.inserts[0], k).not.toHaveProperty(k);
    expect(s.inserts[0]).toMatchObject({ message: "Swap a breaker" });
  });
});

describe("updateInquiry's source", () => {
  it("a picked label is written", async () => {
    expect(await updateInquiry("lead-1", form({ name: "Dana Rook", source: "Signage" }))).toEqual({ ok: true });
    expect(s.updates[0]).toMatchObject({ name: "Dana Rook", source: "Signage" });
  });

  it("nothing picked leaves the stored source alone (a website door keeps its value)", async () => {
    await updateInquiry("lead-1", form({ name: "Dana Rook", source: "" }));
    await updateInquiry("lead-1", form({ name: "Dana Rook" }));
    for (const u of s.updates) expect(u).not.toHaveProperty("source");
  });

  it("a website door's own value posted back unchanged is written as it was", async () => {
    await updateInquiry("lead-1", form({ name: "Dana Rook", source: "public_form" }));
    expect(s.updates[0].source).toBe("public_form");
  });

  it("writes no kind, no length and no follow-up day", async () => {
    await updateInquiry("lead-1", form({ name: "Dana Rook", work_kind: "job", planned_minutes: "480" }));
    for (const u of s.updates) for (const k of NEVER) expect(u, k).not.toHaveProperty(k);
  });
});
