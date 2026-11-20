import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE LEAD'S SERVER DOORS (cn-v1170), against a stand-in client that records every call: Not Sold
 * waits for a standing visit, Reopen puts a Not Sold lead back where it was, and a lead's booking is
 * always an inspection with no follow-up day and no length.
 */
type Row = Record<string, any>;
type Call = { table: string; op: "select" | "update" | "insert" | "delete"; cols?: string; patch?: Row; filters: [string, string, unknown][] };

const db = vi.hoisted(() => ({
  calls: [] as Call[],
  lead: null as Row | null,
  visits: [] as Row[],
  updated: [{ id: "l1" }] as Row[],
}));

function builder(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  db.calls.push(call);
  const run = (single: boolean) => {
    if (table === "profiles") return { data: { language: "en" }, error: null };
    if (call.op === "update" || call.op === "delete") return { data: db.updated, error: null };
    if (call.op === "insert") return { data: single ? { id: "new-1" } : [{ id: "new-1" }], error: null };
    if (table === "inquiries") return { data: single ? db.lead : db.lead ? [db.lead] : [], error: null };
    if (table === "appointments") return { data: single ? (db.visits[0] ?? null) : db.visits, error: null };
    if (table === "organizations") return { data: { settings: { timezone: "America/Los_Angeles" }, phone: null }, error: null };
    return { data: single ? null : [], error: null };
  };
  const b: any = {
    select: (cols?: string) => ((call.cols = cols), b),
    update: (p: Row) => ((call.op = "update"), (call.patch = p), b),
    insert: (p: Row) => ((call.op = "insert"), (call.patch = p), b),
    delete: () => ((call.op = "delete"), b),
    maybeSingle: async () => run(true),
    single: async () => run(true),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run(false)).then(ok, bad),
  };
  for (const m of ["eq", "neq", "in", "is", "or", "not", "gte", "lt", "order", "limit"]) b[m] = (k: string, v: unknown) => (call.filters.push([m, k, v]), b);
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
vi.mock("@/lib/inquiries/carry-intake-answers", () => ({
  carryForInquiry: vi.fn(async () => ({ inspectionTemplateId: null, inspectionAnswers: {}, carried: [], briefCarried: [] })),
  carriedNote: () => null,
  briefNote: () => null,
}));
const proposals = vi.hoisted(() => [] as Row[]);
vi.mock("@/lib/appointments/proposal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/appointments/proposal")>()),
  createProposalCore: vi.fn(async (_db: unknown, p: Row) => (proposals.push(p), { ok: true, token: "tok-1" })),
}));

import { convertInquiry, reopenLead, scheduleLeadsOnDay, setInquiryStatus } from "./actions";

const writes = (table: string) => db.calls.filter((c) => c.table === table && (c.op === "update" || c.op === "insert"));

beforeEach(() => {
  db.calls = [];
  db.visits = [];
  db.updated = [{ id: "l1" }];
  db.lead = { id: "l1", name: "Sam Tillery", status: "contacted", converted_at: null, last_contacted_at: "2026-11-01T17:00:00Z", address: "4 Larkspur Ln", message: "Deck", notes: null, customer_id: null, work_kind: "job", planned_minutes: 960 };
  proposals.length = 0;
});

describe("setInquiryStatus: Not Sold waits for a standing visit", () => {
  it("refuses while a visit from the lead stands, in one sentence naming one action, and writes nothing", async () => {
    db.visits = [{ inquiry_id: "l1", status: "scheduled", outcome: null }];
    expect(await setInquiryStatus("l1", "lost")).toEqual({
      ok: false,
      error: "A visit from this lead is still on the books. Open the visit and mark it Not Sold or Dismiss it there.",
    });
    expect(writes("inquiries")).toEqual([]);
  });

  it("goes through once the visit has ended (Not Sold, cancelled or none)", async () => {
    db.visits = [{ inquiry_id: "l1", status: "completed", outcome: "lost" }];
    expect(await setInquiryStatus("l1", "lost")).toEqual({ ok: true });
    expect(writes("inquiries")[0].patch).toMatchObject({ status: "lost" });
  });

  it("the Undo's own status write is not held up by the visits", async () => {
    db.visits = [{ inquiry_id: "l1", status: "scheduled", outcome: null }];
    expect(await setInquiryStatus("l1", "contacted")).toEqual({ ok: true });
  });
});

describe("reopenLead", () => {
  it("a Not Sold lead goes back to Contacted when somebody reached them, guarded at the write", async () => {
    db.lead = { id: "l1", status: "lost", converted_at: null, last_contacted_at: "2026-11-01T17:00:00Z" };
    expect(await reopenLead("l1")).toEqual({ ok: true });
    const w = writes("inquiries")[0];
    expect(w.patch).toMatchObject({ status: "contacted" });
    expect(w.filters).toEqual(expect.arrayContaining([["eq", "status", "lost"], ["is", "converted_at", null]]));
    expect(w.cols).toBe("id");
  });

  it("back to New when nobody was ever reached", async () => {
    db.lead = { id: "l1", status: "lost", converted_at: null, last_contacted_at: null };
    expect(await reopenLead("l1")).toEqual({ ok: true });
    expect(writes("inquiries")[0].patch).toMatchObject({ status: "new" });
  });

  it("a converted lead, an open one, or a write that touched nothing is said, never 'done'", async () => {
    const said = { ok: false, error: "This lead isn't Not Sold any more. Reload to see where it is." };
    db.lead = { id: "l1", status: "lost", converted_at: "2026-11-02T00:00:00Z", last_contacted_at: null };
    expect(await reopenLead("l1")).toEqual(said);
    db.lead = { id: "l1", status: "new", converted_at: null, last_contacted_at: null };
    expect(await reopenLead("l1")).toEqual(said);
    db.lead = { id: "l1", status: "lost", converted_at: null, last_contacted_at: null };
    db.updated = [];
    expect(await reopenLead("l1")).toEqual(said);
  });
});

describe("convertInquiry(…, 'inspection'): always an inspection, no follow-up day, no length", () => {
  it("Book It on a lead tagged job books an INSPECTION (the fork is gone) with no size or end", async () => {
    const res = await convertInquiry("l1", "inspection", { startDate: "2026-11-24" });
    expect(res.ok).toBe(true);
    expect(res.redirect).toBe("/schedule?view=day&date=2026-11-24");
    expect(writes("jobs")).toEqual([]);
    const visit = writes("appointments")[0].patch!;
    expect(visit.type).toBe("inspection");
    expect(visit.title).toBe("Inspection: Sam Tillery");
    expect(visit).not.toHaveProperty("planned_minutes");
    expect(visit).not.toHaveProperty("ends_at");
    const lead = writes("inquiries")[0].patch!;
    expect(lead).toMatchObject({ status: "contacted" });
    expect(lead).not.toHaveProperty("next_follow_up_at");
  });

  it("Let Them Pick: an inspection proposal with no length, and no follow-up day on the lead", async () => {
    const res = await convertInquiry("l1", "inspection", { slots: [{ date: "2026-11-24", time: "09:00" }] });
    expect(res).toMatchObject({ ok: true, token: "tok-1" });
    expect(proposals[0]).toMatchObject({ type: "inspection", title: "Inspection: Sam Tillery", plannedMinutes: null });
    expect(writes("inquiries")[0].patch).not.toHaveProperty("next_follow_up_at");
  });

  it("Let Them Pick revalidates no route: a refresh in the same answer would unmount the sheet holding the link", async () => {
    const { revalidatePath } = await import("next/cache");
    vi.mocked(revalidatePath).mockClear();
    const res = await convertInquiry("l1", "inspection", { slots: [{ date: "2026-11-24", time: "09:00" }] });
    expect(res).toMatchObject({ ok: true, token: "tok-1" });
    expect(revalidatePath).not.toHaveBeenCalled();
    // Book It still does (it navigates away, so nothing on screen is lost).
    await convertInquiry("l1", "inspection", { startDate: "2026-11-24" });
    expect(revalidatePath).toHaveBeenCalled();
  });

  it("the lead's kind and length are not read by the booking: the source has no work_kind or planned_minutes", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/app/(app)/leads/actions.ts"), "utf8");
    const convert = src.slice(src.indexOf("export async function convertInquiry("), src.indexOf("export async function refreshPlanBrief("));
    expect(convert).not.toMatch(/\.work_kind|\.planned_minutes|next_follow_up_at|placeJobOnDay/);
    expect(src).not.toContain("export async function snoozeInquiry(");
    expect(src).not.toContain("export async function sizeLead(");
    expect(src).toContain("export async function markInquiryContacted(id: string): Promise<Result>");
  });
});

describe("scheduleLeadsOnDay reads the one rule (cn-v1170)", () => {
  it("a reopened lead whose visit ended Not Sold can be placed from the rail", async () => {
    db.visits = [{ inquiry_id: "l1", status: "completed", outcome: "lost", starts_at: "2026-11-01T17:00:00Z" }];
    const res = await scheduleLeadsOnDay(["l1"], "2026-11-24", { times: ["10:00"] });
    expect(res).toMatchObject({ ok: true, booked: 1, failures: [] });
    expect(writes("appointments")[0].patch).toMatchObject({ type: "inspection", inquiry_id: "l1" });
  });

  it("a lead whose visit still stands is refused with its reason, and nothing is booked", async () => {
    db.visits = [{ inquiry_id: "l1", status: "scheduled", outcome: null, starts_at: "2026-11-30T17:00:00Z" }];
    const res = await scheduleLeadsOnDay(["l1"], "2026-11-24");
    expect(res.booked).toBe(0);
    expect(res.failures).toEqual([{ id: "l1", error: expect.any(String) }]);
    expect(writes("appointments")).toEqual([]);
  });

  it("the source keeps no copy of the rule", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/app/(app)/leads/actions.ts"), "utf8");
    const fn = src.slice(src.indexOf("export async function scheduleLeadsOnDay("), src.indexOf("export async function setLeadContact("));
    expect(fn).toContain("standingFor(ctx.supabase, ids)");
    expect(fn).not.toMatch(/from\("appointments"\)/);
  });
});
