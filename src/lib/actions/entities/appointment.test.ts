import { describe, it, expect, vi, beforeEach } from "vitest";

// The Tom Goodman booking (2026-09-24): Nort passed "tomorrow at 10 AM" as a wall-clock string,
// the handler handed it to a timestamptz column, and the row said 10:00 UTC (3 AM Pacific) while
// Nort said "Booked, tomorrow at 10 AM". These drive the REAL handlers with the server action and
// the database stubbed, and check both halves: what is stored, and what Nort is told was stored.

const { createAppointment, rescheduleAppointment, linkAppointmentTo, db } = vi.hoisted(() => ({
  createAppointment: vi.fn(),
  rescheduleAppointment: vi.fn(),
  linkAppointmentTo: vi.fn(),
  db: { tz: "America/Los_Angeles", stored: null as null | { title: string; starts_at: string; ends_at: string | null; customers: { name: string } | null } },
}));

vi.mock("@/app/(app)/appointments/actions", () => ({
  createAppointment,
  rescheduleAppointment,
  linkAppointmentTo,
  setAppointmentOutcome: vi.fn(),
  setAppointmentStatus: vi.fn(),
}));

/** A chainable fake: organizations → the org's timezone; appointments → the row "as stored". */
function fakeClient() {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const k of ["select", "eq", "limit", "is", "in", "gte", "order", "ilike", "or"]) chain[k] = () => chain;
      chain.maybeSingle = async () =>
        table === "organizations"
          ? { data: { settings: { timezone: db.tz } }, error: null }
          : table === "appointments"
            ? { data: db.stored, error: null }
            : { data: null, error: null };
      return chain;
    },
  };
}
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => fakeClient()) }));

import { appointmentActions, readbackWhen } from "./appointment";

const ctx = { userId: "u1", orgId: "o1", role: "owner" };

beforeEach(() => {
  vi.clearAllMocks();
  db.tz = "America/Los_Angeles";
  // Whatever the handler hands createAppointment is what "the database" stores.
  createAppointment.mockImplementation(async (fd: FormData) => {
    db.stored = {
      title: String(fd.get("title")),
      starts_at: String(fd.get("starts_at_iso")),
      ends_at: fd.get("ends_at_iso") ? String(fd.get("ends_at_iso")) : null,
      customers: null,
    };
    return { ok: true, id: "78fa75b1-8384-4148-8895-242846abcce5" };
  });
  rescheduleAppointment.mockImplementation(async (_id: string, start: string, end: string | null) => {
    db.stored = { title: "Inspection — Tom Goodman", starts_at: start, ends_at: end, customers: null };
    return { ok: true };
  });
});

const create = (input: Record<string, unknown>) =>
  appointmentActions["appointment.create"].handler(appointmentActions["appointment.create"].input.parse(input), ctx);

describe("appointment.create — a spoken local time is stored as that local time", () => {
  it("10 AM Pacific in September is stored 17:00Z and read back as 10:00 AM", async () => {
    const r = await create({ title: "Inspection — Tom Goodman", type: "inspection", starts_at: "2026-09-25T10:00" });
    expect(r.ok).toBe(true);
    const fd = createAppointment.mock.calls[0][0] as FormData;
    expect(fd.get("starts_at_iso")).toBe("2026-09-25T17:00:00.000Z");
    expect(r.recorded).toBe('Booked: "Inspection — Tom Goodman", Fri Sep 25 at 10:00 AM PDT, no customer linked.');
  });

  it("10 AM Pacific in December (standard time) is stored 18:00Z", async () => {
    const r = await create({ title: "Final", starts_at: "2026-12-10T10:00", ends_at: "2026-12-10T11:30" });
    const fd = createAppointment.mock.calls[0][0] as FormData;
    expect(fd.get("starts_at_iso")).toBe("2026-12-10T18:00:00.000Z");
    expect(fd.get("ends_at_iso")).toBe("2026-12-10T19:30:00.000Z");
    expect(r.recorded).toContain("Thu Dec 10 at 10:00 AM PST, until 11:30 AM PST");
  });

  it("a time with an explicit offset is kept as given", async () => {
    await create({ title: "Call", starts_at: "2026-09-25T10:00:00-04:00" });
    expect((createAppointment.mock.calls[0][0] as FormData).get("starts_at_iso")).toBe("2026-09-25T14:00:00.000Z");
  });

  it("a stamped Z is honoured, and the read-back SAYS 3 AM, so it can't be confirmed as 10", async () => {
    const r = await create({ title: "Inspection — Tom Goodman", starts_at: "2026-09-25T10:00:00Z" });
    expect(r.recorded).toContain("3:00 AM PDT");
  });

  it("an unreadable time is refused before anything is written", async () => {
    const r = await create({ title: "x", starts_at: "tomorrow at 10" });
    expect(r.ok).toBe(false);
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it("the tool description tells the model to send local wall-clock time", () => {
    expect(appointmentActions["appointment.create"].description).toContain("NO Z and NO offset");
    expect(appointmentActions["appointment.update"].description).toContain("NO Z and NO offset");
  });
});

describe("appointment.update — the reschedule door converts the same way", () => {
  it("moves to 9 AM local and reads back the stored time", async () => {
    const def = appointmentActions["appointment.update"];
    const r = await def.handler(def.input.parse({ id: "a1", starts_at: "2026-09-26T09:00" }), ctx);
    expect(rescheduleAppointment).toHaveBeenCalledWith("a1", "2026-09-26T16:00:00.000Z", null);
    expect(r.recorded).toContain("Sat Sep 26 at 9:00 AM PDT");
  });

  it("an end on another day says its day; an end before the start is flagged, not read as normal (SI1)", async () => {
    const def = appointmentActions["appointment.update"];
    rescheduleAppointment.mockImplementationOnce(async (_id: string, start: string) => {
      db.stored = { title: "Inspection", starts_at: start, ends_at: "2026-09-22T17:00:00.000Z", customers: null };
      return { ok: true };
    });
    const r = await def.handler(def.input.parse({ id: "a1", starts_at: "2026-09-24T09:00" }), ctx);
    expect(r.recorded).toContain("Thu Sep 24 at 9:00 AM PDT, and its stored end (Tue Sep 22 at 10:00 AM PDT) is not after its start");
    rescheduleAppointment.mockImplementationOnce(async (_id: string, start: string) => {
      db.stored = { title: "Two-day", starts_at: start, ends_at: "2026-09-25T17:00:00.000Z", customers: null };
      return { ok: true };
    });
    const r2 = await def.handler(def.input.parse({ id: "a1", starts_at: "2026-09-24T09:00" }), ctx);
    expect(r2.recorded).toContain("Thu Sep 24 at 9:00 AM PDT, until Fri Sep 25 at 10:00 AM PDT");
  });

  it("the tool tells the model an omitted end keeps the visit's length", () => {
    expect(appointmentActions["appointment.update"].description).toContain("keeps its length");
  });

  it("the confirm card speaks a stamped offset out loud", () => {
    expect(readbackWhen("2026-09-26T09:00")).toBe("Sat 9/26 at 9am");
    expect(readbackWhen("2026-09-26T09:00:00Z")).toBe("Sat 9/26 at 9am UTC");
  });
});

describe("appointment.linkCustomer — the yes has a verb now", () => {
  it("links through the inspector's link door and reads the result back", async () => {
    linkAppointmentTo.mockResolvedValue({ ok: true, id: "a1" });
    db.stored = { title: "Inspection — Tom Goodman", starts_at: "2026-09-25T17:00:00.000Z", ends_at: null, customers: { name: "Tom Goodman" } };
    const def = appointmentActions["appointment.linkCustomer"];
    const cid = "0a8dfe84-f1a4-4a8b-b8bd-df250eeb23b2";
    const r = await def.handler(def.input.parse({ id: "a1", customer_id: cid }), ctx);
    expect(linkAppointmentTo).toHaveBeenCalledWith("a1", "customer", cid);
    expect(r.recorded).toBe('Linked: "Inspection — Tom Goodman", Fri Sep 25 at 10:00 AM PDT, customer "Tom Goodman".');
  });
});
