import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * A VISIT'S NOT SOLD ENDS ITS LEAD (cn-v1170; setAppointmentOutcome + lib/leads/not-sold), against a
 * stand-in client that records every write: the lead is marked in the same deed only when it is open
 * and no OTHER visit from it still stands; the answer says leadMarked. Clearing the answer or
 * turning it to Won puts a Not Sold lead back, and the answer says leadReopened only when it went.
 */
type Row = Record<string, any>;
type Call = { table: string; op: "select" | "update"; cols?: string; patch?: Row; filters: [string, string, unknown][] };

const db = vi.hoisted(() => ({
  calls: [] as Call[],
  visit: { id: "a1", inquiry_id: "l1" } as Row,
  lead: null as Row | null,
  /** The lead's visits as the standing read sees them, after this visit's own outcome landed. */
  visits: [] as Row[],
  leadUpdated: [{ id: "l1" }] as Row[],
}));

function builder(table: string) {
  const call: Call = { table, op: "select", filters: [] };
  db.calls.push(call);
  const run = (single: boolean) => {
    if (table === "profiles") return { data: { language: "en" }, error: null };
    if (call.op === "update") return { data: table === "appointments" ? [db.visit] : db.leadUpdated, error: null };
    if (table === "inquiries") return { data: single ? db.lead : [db.lead], error: null };
    if (table === "appointments") return { data: db.visits, error: null };
    return { data: single ? null : [], error: null };
  };
  const b: any = {
    select: (cols?: string) => ((call.cols = cols), b),
    update: (p: Row) => ((call.op = "update"), (call.patch = p), b),
    maybeSingle: async () => run(true),
    single: async () => run(true),
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(run(false)).then(ok, bad),
  };
  for (const m of ["eq", "neq", "in", "is", "order", "limit"]) b[m] = (k: string, v: unknown) => (call.filters.push([m, k, v]), b);
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
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => {}) }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

const { setAppointmentOutcome } = await import("./actions");

const leadWrites = () => db.calls.filter((c) => c.table === "inquiries" && c.op === "update");

beforeEach(() => {
  db.calls = [];
  db.visit = { id: "a1", inquiry_id: "l1" };
  db.lead = { id: "l1", status: "contacted", converted_at: null, last_contacted_at: "2026-11-01T17:00:00Z" };
  db.visits = [{ inquiry_id: "l1", status: "completed", outcome: "lost" }];
  db.leadUpdated = [{ id: "l1" }];
});

describe("setAppointmentOutcome marks the lead Not Sold in the same deed", () => {
  it("an open lead with no other standing visit is marked, and the answer says so", async () => {
    expect(await setAppointmentOutcome("a1", "lost")).toEqual({ ok: true, leadMarked: true });
    const w = leadWrites()[0];
    expect(w.patch).toMatchObject({ status: "lost" });
    expect(w.filters).toEqual(expect.arrayContaining([["eq", "id", "l1"], ["neq", "status", "lost"], ["is", "converted_at", null]]));
    expect(w.cols).toBe("id");
    // The older ending counts too.
    db.calls = [];
    expect(await setAppointmentOutcome("a1", "no_bid")).toEqual({ ok: true, leadMarked: true });
  });

  it("another visit from the lead still stands: the lead is not touched", async () => {
    db.visits = [
      { inquiry_id: "l1", status: "completed", outcome: "lost" },
      { inquiry_id: "l1", status: "scheduled", outcome: null },
    ];
    expect(await setAppointmentOutcome("a1", "lost")).toEqual({ ok: true });
    expect(leadWrites()).toEqual([]);
  });

  it("a lead already converted or already Not Sold, or a visit with no lead: nothing to mark", async () => {
    db.lead = { id: "l1", status: "won", converted_at: "2026-11-02T00:00:00Z" };
    expect(await setAppointmentOutcome("a1", "lost")).toEqual({ ok: true });
    db.lead = { id: "l1", status: "lost", converted_at: null };
    expect(await setAppointmentOutcome("a1", "lost")).toEqual({ ok: true });
    db.visit = { id: "a1", inquiry_id: null };
    expect(await setAppointmentOutcome("a1", "lost")).toEqual({ ok: true });
    expect(leadWrites()).toEqual([]);
  });

  it("Won marks nothing Not Sold on an open lead", async () => {
    expect(await setAppointmentOutcome("a1", "won")).toEqual({ ok: true });
    expect(leadWrites()).toEqual([]);
  });
});

describe("taking the ending back: the lead follows (no option; the visit's answer is the lead's)", () => {
  it("clearing the outcome puts a Not Sold lead back where it was, and says leadReopened", async () => {
    db.lead = { id: "l1", status: "lost", converted_at: null, last_contacted_at: "2026-11-01T17:00:00Z" };
    expect(await setAppointmentOutcome("a1", null)).toEqual({ ok: true, leadReopened: true });
    const w = leadWrites()[0];
    expect(w.patch).toMatchObject({ status: "contacted" });
    expect(w.filters).toEqual(expect.arrayContaining([["eq", "status", "lost"], ["is", "converted_at", null]]));
    expect(w.cols).toBe("id");
  });

  it("turning it to Won reopens a Not Sold lead too", async () => {
    db.lead = { id: "l1", status: "lost", converted_at: null, last_contacted_at: null };
    expect(await setAppointmentOutcome("a1", "won")).toEqual({ ok: true, leadReopened: true });
    expect(leadWrites()[0].patch).toMatchObject({ status: "new" });
  });

  it("an open lead is not touched and leadReopened is not said", async () => {
    db.lead = { id: "l1", status: "contacted", converted_at: null, last_contacted_at: null };
    expect(await setAppointmentOutcome("a1", null)).toEqual({ ok: true });
    expect(leadWrites()).toEqual([]);
  });

  it("a lead that has moved on since (converted) is never pulled back", async () => {
    db.lead = { id: "l1", status: "won", converted_at: "2026-11-02T00:00:00Z", last_contacted_at: null };
    expect(await setAppointmentOutcome("a1", null)).toEqual({ ok: true });
    expect(leadWrites()).toEqual([]);
  });

  it("a reopen write that touched nothing is not called reopened", async () => {
    db.lead = { id: "l1", status: "lost", converted_at: null, last_contacted_at: null };
    db.leadUpdated = [];
    expect(await setAppointmentOutcome("a1", null)).toEqual({ ok: true });
  });

  it("the signature takes no option any more", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "src/app/(app)/appointments/actions.ts"), "utf8");
    expect(src).not.toContain("reopenLead?: boolean");
  });
});
