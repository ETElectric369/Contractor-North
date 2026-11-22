import { describe, it, expect, vi, beforeEach } from "vitest";
import { client, makeDb, type Db, type Row } from "@/lib/appointments/visit-db.test-util";

/**
 * THE NOT SOLD FOLD'S DELETE… HAS ONE SERVER DOOR (cn-v1181, I2b): deleteEndedVisit. It deletes an ENDED
 * visit that hangs on nobody only when nothing is on it, by Dismiss's own verdict (what was captured,
 * the answers through their view, invoices, a waiting time-pick link) plus an estimate written from it;
 * every fact read at the write; the delete lands only on the row as read, and is read back. Otherwise one
 * sentence says what is on it and that it stays on file. On a stand-in that honours every filter and
 * select list. Stand-ins only.
 */
const state = vi.hoisted(() => ({ db: null as unknown as Db }));
const sb = () => {
  const c = client(state.db) as any;
  c.auth = { getUser: async () => ({ data: { user: { id: "office-1" } } }) };
  return c;
};
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => sb()), createServiceClient: vi.fn(() => sb()) }));
vi.mock("@/lib/staff-guard", () => ({
  requireStaff: async () => ({ supabase: sb(), userId: "office-1", orgId: "org-1", role: "owner" }),
  requireMember: async () => ({ supabase: sb(), userId: "office-1", orgId: "org-1", role: "owner" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(async () => {}), deleteCalendarItem: vi.fn(async () => {}) }));
vi.mock("@/lib/notifications", () => ({ notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => {}) }));
vi.mock("@/lib/observe", () => ({ reportError: vi.fn() }));

const { deleteEndedVisit } = await import("./actions");

const visit = (over: Row = {}): Row => ({
  id: "v-1",
  org_id: "org-1",
  status: "completed",
  outcome: "lost",
  capture: null,
  inspection_answers: null,
  updated_at: "2026-11-08T19:00:00Z",
  inquiry_id: null,
  customer_id: null,
  job_id: null,
  ...over,
});

const load = (v: Row, more: { invoices?: Row[]; proposals?: Row[] } = {}) => {
  state.db = makeDb(
    {
      appointments: [v],
      // The answers are read through their view (the table's column is revoked from the signed-in role).
      appointment_answers: [{ id: v.id, inspection_answers: v.inspection_answers }],
      invoices: more.invoices ?? [],
      schedule_proposals: more.proposals ?? [],
      profiles: [{ id: "office-1", language: "en" }],
    },
    {
      appointments: Object.keys(visit()),
      appointment_answers: ["id", "inspection_answers"],
      invoices: ["id", "appointment_id"],
      schedule_proposals: ["id", "appointment_id", "status"],
    },
  );
};

describe("deleteEndedVisit", () => {
  beforeEach(() => load(visit()));

  it("an ended visit with nothing on it, hanging on nobody: deleted, on the row as read, and read back", async () => {
    expect(await deleteEndedVisit("v-1")).toEqual({ ok: true, did: "deleted" });
    expect(state.db.tables.appointments).toEqual([]);
    const w = state.db.writes.find((x) => x.table === "appointments" && x.op === "delete")!;
    expect(w.filters).toEqual(
      expect.arrayContaining([
        "eq id v-1",
        "eq status completed",
        "eq outcome lost",
        "eq updated_at 2026-11-08T19:00:00Z",
        "is inquiry_id null",
        "is customer_id null",
        "is job_id null",
        "eq org_id org-1",
      ]),
    );
  });

  it("a cancelled one (no outcome) is an ending too", async () => {
    load(visit({ status: "cancelled", outcome: null }));
    expect(await deleteEndedVisit("v-1")).toEqual({ ok: true, did: "deleted" });
  });

  it("notes, an answer, an estimate, an invoice, a waiting link: kept, and one sentence says what", async () => {
    load(visit({ capture: { notes: "Panel is 100A" } }));
    expect(await deleteEndedVisit("v-1")).toEqual({ ok: false, kept: true, error: "Not deleted: this visit has notes or answers on it. It stays on file." });
    load(visit({ inspection_answers: { amps: "200" } }));
    expect((await deleteEndedVisit("v-1")).error).toBe("Not deleted: this visit has notes or answers on it. It stays on file.");
    load(visit({ capture: { quote_id: "q-900" } }));
    expect((await deleteEndedVisit("v-1")).error).toBe("Not deleted: this visit has an estimate on it. It stays on file.");
    load(visit(), { invoices: [{ id: "inv-900", appointment_id: "v-1" }], proposals: [{ id: "p-1", appointment_id: "v-1", status: "pending" }] });
    expect((await deleteEndedVisit("v-1")).error).toBe("Not deleted: this visit has an invoice, a time-pick link on it. It stays on file.");
    expect(state.db.tables.appointments).toHaveLength(1);
    expect(state.db.writes.filter((w) => w.op === "delete")).toEqual([]);
  });

  it("a fact that can't be read counts as something there: kept, said", async () => {
    state.db.fail!.read!.add("invoices");
    expect(await deleteEndedVisit("v-1")).toEqual({ ok: false, kept: true, error: "Not deleted: part of this visit couldn't be checked. It stays on file." });
    expect(state.db.tables.appointments).toHaveLength(1);
  });

  it("not ended, or somebody's: refused, nothing moves", async () => {
    load(visit({ status: "scheduled", outcome: null }));
    expect((await deleteEndedVisit("v-1")).error).toBe("Only a visit that ended Not Sold or Cancelled is deleted here.");
    load(visit({ status: "completed", outcome: "won" }));
    expect((await deleteEndedVisit("v-1")).ok).toBe(false);
    for (const over of [{ inquiry_id: "inq-1" }, { customer_id: "cust-1" }, { job_id: "job-1" }]) {
      load(visit(over));
      expect((await deleteEndedVisit("v-1")).error, JSON.stringify(over)).toBe("This visit belongs to a lead, a customer or a job, so it stays on file with them.");
      expect(state.db.tables.appointments).toHaveLength(1);
    }
  });

  it("another company's visit is not there", async () => {
    load(visit({ org_id: "org-2" }));
    const r = await deleteEndedVisit("v-1");
    expect(r.ok).toBe(false);
    expect(state.db.tables.appointments).toHaveLength(1);
  });

  it("the delete lands on nothing (it changed after the read): said, never taken for done", async () => {
    // A stamp that moves between the read and the delete: the delete's updated_at filter misses.
    const row = state.db.tables.appointments[0];
    let reads = 0;
    Object.defineProperty(row, "updated_at", {
      get: () => (reads++ === 0 ? "2026-11-08T19:00:00Z" : "2026-11-22T10:00:00Z"),
      enumerable: true,
      configurable: true,
    });
    expect(await deleteEndedVisit("v-1")).toEqual({ ok: false, error: "This visit changed after it was read, so nothing was deleted. Try again." });
    expect(state.db.tables.appointments).toHaveLength(1);
  });
});
