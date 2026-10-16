import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE FORM'S NEW LEAD, DRIVEN (2026-10-15). A visit saved for a person not in the list, with New Lead
 * picked, is written with no customer and then made a lead through the visit page's own door
 * (linkAppointmentToNewLead → createInquiry + linkAppointmentTo "lead"), phone and all; the visit's
 * address parts (a pick) ride onto the row. A lead that could not be made is said, never silent.
 * An edit: a second New Lead on a visit that already has one is refused; a typed line that no longer
 * says the stored town drops the stored parts; one that still says them keeps them.
 */
type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({
  inserts: [] as { table: string; row: Row }[],
  updates: [] as { table: string; patch: Row }[],
  appt: {} as Row,
  inquiry: null as Row | null,
}));

function builder(table: string) {
  let patch: Row | null = null;
  let insert: Row | null = null;
  const run = () => {
    if (table === "organizations") return { data: { settings: { timezone: "America/Los_Angeles" } }, error: null };
    if (insert) {
      s.inserts.push({ table, row: insert });
      return { data: { id: table === "appointments" ? "appt-1" : "row-1" }, error: null };
    }
    if (patch) {
      s.updates.push({ table, patch });
      return { data: [{ id: "appt-1" }], error: null };
    }
    if (table === "appointments") return { data: s.appt, error: null };
    if (table === "inquiries") return { data: s.inquiry, error: null };
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
const createInquiry = vi.fn(async (_fd: FormData) => ({ ok: true, id: "lead-1" }) as { ok: boolean; id?: string; error?: string; note?: string });
vi.mock("@/app/(app)/leads/actions", () => ({ createInquiry: (fd: FormData) => createInquiry(fd) }));
const createProposalCore = vi.fn(async (_sb: unknown, input: Row) => ({ ok: true, token: "tok-1", appointmentId: "appt-9", input }));
vi.mock("@/lib/appointments/proposal", () => ({
  createProposalCore: (sb: unknown, input: Row) => createProposalCore(sb, input),
  cleanSlots: (v: unknown) => (Array.isArray(v) ? v : []),
}));

import { createAppointment, updateAppointment, createAppointmentProposal } from "./actions";

const APPT = { id: "appt-1", type: "other", title: "Pat Thistlewood", location: "12 Bayberry Ln, Thistlewood, CA 96100", city: "Thistlewood", state: "CA", zip: "96100", outcome: null, inquiry_id: null };
const LEAD = { id: "lead-1", name: "Pat Thistlewood", address: "12 Bayberry Ln", city: "Thistlewood", state: "CA", zip: "96100", customer_id: null };

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ title: "Pat Thistlewood", date: "2026-10-20", start_time: "09:00", type: "inspection", ...fields })) fd.set(k, v);
  return fd;
}

beforeEach(() => {
  s.inserts.length = 0;
  s.updates.length = 0;
  s.appt = { ...APPT };
  s.inquiry = { ...LEAD };
  createInquiry.mockClear();
  createProposalCore.mockClear();
});

describe("New Lead on create", () => {
  it("writes the visit with no customer and the picked parts, then makes the lead with the phone and attaches the visit", async () => {
    const r = await createAppointment(form({ customer_id: "__lead__", new_customer_name: "Pat Thistlewood", new_customer_phone: "5305551234", location: "12 Bayberry Ln, Thistlewood, CA 96100", city: "Thistlewood", state: "CA", zip: "96100" }));
    expect(r).toMatchObject({ ok: true, id: "appt-1" });
    expect((r as { warning?: string }).warning).toBeUndefined();
    const visit = s.inserts.find((i) => i.table === "appointments")!.row;
    expect(visit).toMatchObject({ customer_id: null, city: "Thistlewood", state: "CA", zip: "96100" });
    // The lead door: the name and phone typed, the visit's street carried.
    expect(createInquiry).toHaveBeenCalledTimes(1);
    const fd = createInquiry.mock.calls[0][0];
    expect(fd.get("name")).toBe("Pat Thistlewood");
    expect(String(fd.get("phone"))).toContain("555");
    expect(fd.get("address")).toBe("12 Bayberry Ln");
    expect(fd.get("city")).toBe("Thistlewood");
    // The visit is attached to the lead.
    expect(s.updates.some((u) => u.table === "appointments" && u.patch.inquiry_id === "lead-1")).toBe(true);
  });

  it("a typed line sends no parts: none are written", async () => {
    await createAppointment(form({ customer_id: "", location: "12 Bayberry Ln" }));
    const visit = s.inserts.find((i) => i.table === "appointments")!.row;
    expect(visit).not.toHaveProperty("city");
    expect(createInquiry).not.toHaveBeenCalled();
  });

  it("a lead that could not be made is SAID: the visit stands, the warning names it", async () => {
    createInquiry.mockResolvedValueOnce({ ok: false, error: "Add a name, phone, or note to save the lead." });
    const r = await createAppointment(form({ customer_id: "__lead__", new_customer_name: "Pat Thistlewood" }));
    expect(r.ok).toBe(true);
    expect((r as { warning?: string }).warning).toBe("Saved, but the lead wasn't made: Add a name, phone, or note to save the lead.");
  });

  it("New Lead with no name is refused before anything is written", async () => {
    const r = await createAppointment(form({ customer_id: "__lead__", new_customer_name: "" }));
    expect(r).toEqual({ ok: false, error: "Enter a name for the new lead." });
    expect(s.inserts).toHaveLength(0);
  });
});

describe("New Lead on Propose Times", () => {
  it("the tentative visit carries the parts, and the lead is attached to it", async () => {
    const fd = form({ customer_id: "__lead__", new_customer_name: "Pat Thistlewood", location: "12 Bayberry Ln, Thistlewood, CA 96100", city: "Thistlewood", state: "CA", zip: "96100" });
    fd.set("slots_json", JSON.stringify([{ date: "2026-10-20", time: "09:00" }]));
    s.appt = { ...APPT, id: "appt-9" };
    const r = await createAppointmentProposal(fd);
    expect(r).toMatchObject({ ok: true, token: "tok-1" });
    expect(createProposalCore.mock.calls[0][1]).toMatchObject({ city: "Thistlewood", state: "CA", zip: "96100", customerId: null });
    expect(createInquiry).toHaveBeenCalledTimes(1);
    expect(s.updates.some((u) => u.table === "appointments" && u.patch.inquiry_id === "lead-1")).toBe(true);
  });
});

describe("edits", () => {
  it("a second New Lead on a visit that already has one is refused", async () => {
    s.appt = { ...APPT, inquiry_id: "lead-0" };
    const r = await updateAppointment("appt-1", form({ customer_id: "__lead__", new_customer_name: "Someone Else" }));
    expect(r).toEqual({ ok: false, error: "This visit already has a lead attached — change who it's for from the visit's page." });
    expect(s.updates).toHaveLength(0);
    expect(createInquiry).not.toHaveBeenCalled();
  });

  it("a typed line that no longer says the stored town drops the parts; one that still says them keeps them", async () => {
    await updateAppointment("appt-1", form({ customer_id: "", location: "40 Rowan Ct, Bayberry, GA 30301" }));
    expect(s.updates[0].patch).toMatchObject({ city: null, state: null, zip: null });
    s.updates.length = 0;
    await updateAppointment("appt-1", form({ customer_id: "", location: "12 Bayberry Ln, Thistlewood, CA 96100" }));
    expect(s.updates[0].patch).not.toHaveProperty("city");
  });

  it("a pick on edit writes its parts", async () => {
    await updateAppointment("appt-1", form({ customer_id: "", location: "40 Rowan Ct, Bayberry, GA 30301", city: "Bayberry", state: "GA", zip: "30301" }));
    expect(s.updates[0].patch).toMatchObject({ city: "Bayberry", state: "GA", zip: "30301" });
  });
});
