import { describe, it, expect, vi, beforeEach } from "vitest";

// The Tom Goodman booking (2026-09-24): Nort passed "tomorrow at 10 AM" as a wall-clock string,
// the handler handed it to a timestamptz column, and the row said 10:00 UTC (3 AM Pacific) while
// Nort said "Booked, tomorrow at 10 AM". These drive the REAL handlers with the server action and
// the database stubbed, and check both halves: what is stored, and what Nort is told was stored.

const { createAppointment, rescheduleAppointment, setAppointmentPlace, linkAppointmentTo, db } = vi.hoisted(() => ({
  createAppointment: vi.fn(),
  rescheduleAppointment: vi.fn(),
  setAppointmentPlace: vi.fn(),
  linkAppointmentTo: vi.fn(),
  db: { tz: "America/Los_Angeles", stored: null as null | { title: string; starts_at: string; ends_at: string | null; location?: string | null; customers: { name: string } | null } },
}));

vi.mock("@/app/(app)/appointments/actions", () => ({
  createAppointment,
  rescheduleAppointment,
  setAppointmentPlace,
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
    // The row keeps whatever else it holds (an address written a moment earlier), as the real one does.
    db.stored = { ...(db.stored ?? {}), title: "Inspection: Tom Goodman", starts_at: start, ends_at: end, customers: null };
    return { ok: true };
  });
  // The form's address door, stubbed: the row keeps its time and takes the typed line.
  setAppointmentPlace.mockImplementation(async (id: string, location: string) => {
    db.stored = { ...(db.stored ?? { title: "Inspection: Bayberry", starts_at: "2026-10-19T16:00:00.000Z", ends_at: null, customers: null }), location };
    return { ok: true, id };
  });
});

const create = (input: Record<string, unknown>) =>
  appointmentActions["appointment.create"].handler(appointmentActions["appointment.create"].input.parse(input), ctx);

describe("appointment.create — a spoken local time is stored as that local time", () => {
  it("10 AM Pacific in September is stored 17:00Z and read back as 10:00 AM", async () => {
    const r = await create({ title: "Inspection: Tom Goodman", type: "inspection", starts_at: "2026-09-25T10:00" });
    expect(r.ok).toBe(true);
    const fd = createAppointment.mock.calls[0][0] as FormData;
    expect(fd.get("starts_at_iso")).toBe("2026-09-25T17:00:00.000Z");
    expect(r.recorded).toBe('Booked: "Inspection: Tom Goodman", Fri Sep 25 at 10:00 AM PDT, no customer linked.');
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
    const r = await create({ title: "Inspection: Tom Goodman", starts_at: "2026-09-25T10:00:00Z" });
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

describe("appointment.create books one of the four kinds a person picks (W2-06)", () => {
  it("no type books Other, never an inspection or the old 'appointment'", async () => {
    await create({ title: "Dentist", starts_at: "2026-09-25T10:00" });
    expect((createAppointment.mock.calls[0][0] as FormData).get("type")).toBe("other");
  });

  it("each of the four goes through as given; a kind nobody picks any more is refused before anything is written", async () => {
    for (const type of ["inspection", "job", "call", "other"]) {
      createAppointment.mockClear();
      await create({ title: "x", type, starts_at: "2026-09-25T10:00" });
      expect((createAppointment.mock.calls[0][0] as FormData).get("type"), type).toBe(type);
    }
    for (const type of ["meeting", "quote", "appointment", "final_inspection"]) {
      expect(() => appointmentActions["appointment.create"].input.parse({ title: "x", type, starts_at: "2026-09-25T10:00" }), type).toThrow();
    }
  });

  it("the description names the five, sends the city's inspection to the permit, and books a meeting as Other", () => {
    const d = appointmentActions["appointment.create"].description;
    for (const k of ["'inspection' is an Inspection", "'job'", "'service_call'", "'call'", "'other'"]) expect(d).toContain(k);
    // The site visit and the city's share a word in English, so the sentence tells them apart by
    // the TYPE: Nort books 'inspection' here and sends 'final_inspection' to the job's permit.
    expect(d).toContain("THE CITY'S INSPECTION IS NOT THIS: it is the separate type 'final_inspection'");
    expect(d).toContain("goes on the job's permit, never here");
    expect(d).toContain("a meeting books as other");
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

/** THE ADDRESS DOOR (2026-10-16, the lock-screen round): "go ahead and fix the location … 16210
 *  Thistlewood Circle". Nort had only a time door, so he re-proposed the move he had just made with
 *  ends_at "null" (the word), the card read "ends at: null", and the yes failed on it while the
 *  address stayed in his sentence. */
describe("appointment.update — the address door, and the model's 'null' is nothing", () => {
  const def = appointmentActions["appointment.update"];
  const street = "16210 Thistlewood Circle, Truckee";

  it("changes the address alone through the form's own door and reads the stored address back", async () => {
    db.stored = { title: "Baseboard heater", starts_at: "2026-10-19T16:00:00.000Z", ends_at: null, location: "94248 Old Road, Bayberry", customers: null };
    const r = await def.handler(def.input.parse({ id: "a1", location: street }), ctx);
    expect(setAppointmentPlace).toHaveBeenCalledWith("a1", street);
    expect(rescheduleAppointment).not.toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.recorded).toBe(`Updated: "Baseboard heater", Mon Oct 19 at 9:00 AM PDT, at "${street}", no customer linked.`);
  });

  it("moves and re-addresses in one yes — the address first, so the move's calendar push carries it", async () => {
    const r = await def.handler(def.input.parse({ id: "a1", starts_at: "2026-10-19T09:00", location: street }), ctx);
    expect(setAppointmentPlace).toHaveBeenCalledWith("a1", street);
    expect(rescheduleAppointment).toHaveBeenCalledWith("a1", "2026-10-19T16:00:00.000Z", null);
    expect(setAppointmentPlace.mock.invocationCallOrder[0]).toBeLessThan(rescheduleAppointment.mock.invocationCallOrder[0]);
    expect(r.recorded).toMatch(/^Moved: "[^"]+", Mon Oct 19 at 9:00 AM PDT, at "16210 Thistlewood Circle, Truckee"/);
  });

  it("a partial deed is said: the address changed, the move failed", async () => {
    rescheduleAppointment.mockImplementationOnce(async () => ({ ok: false, error: "The end time has to be after the start." }));
    const r = await def.handler(def.input.parse({ id: "a1", starts_at: "2026-10-19T09:00", ends_at: "2026-10-19T08:00", location: street }), ctx);
    expect(setAppointmentPlace).toHaveBeenCalledWith("a1", street);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("The address was changed, but the time wasn't moved: The end time has to be after the start.");
    // And an address that could not be written stops the deed before the move.
    setAppointmentPlace.mockImplementationOnce(async () => ({ ok: false, error: "Appointment not found." }));
    const r2 = await def.handler(def.input.parse({ id: "a1", starts_at: "2026-10-19T09:00", location: street }), ctx);
    expect(r2).toEqual({ ok: false, error: "Appointment not found." });
    expect(rescheduleAppointment).toHaveBeenCalledTimes(1);
  });

  it("a move alone reads back without an address line (unchanged)", async () => {
    const r = await def.handler(def.input.parse({ id: "a1", starts_at: "2026-10-19T09:00" }), ctx);
    expect(setAppointmentPlace).not.toHaveBeenCalled();
    expect(r.recorded).not.toContain(" at \"");
  });

  it("the word 'null' (and 'none', '') is nothing: the card shows no such row and the yes runs", () => {
    const parsed = def.input.parse({ id: "a1", starts_at: "2026-10-19T09:00", ends_at: "null" });
    expect(parsed.ends_at).toBeNull();
    expect(def.input.parse({ id: "a1", starts_at: "2026-10-19T09:00", location: "none" }).location).toBeNull();
    expect(def.input.parse({ id: "a1", starts_at: "2026-10-19T09:00", ends_at: "" }).ends_at).toBeNull();
    const c = appointmentActions["appointment.create"].input.parse({ title: "Inspection: Bayberry", starts_at: "2026-10-19T09:00", ends_at: "null", location: "N/A", notes: "none", job_id: "null", customer_id: "" });
    expect([c.ends_at, c.location, c.notes, c.job_id, c.customer_id]).toEqual([null, null, null, null, null]);
  });

  it("refuses an update that names neither a time nor an address, and an end without a start", () => {
    expect(def.input.safeParse({ id: "a1" }).success).toBe(false);
    expect(def.input.safeParse({ id: "a1", starts_at: "null", location: "null" }).success).toBe(false);
    expect(def.input.safeParse({ id: "a1", ends_at: "2026-10-19T10:00", location: street }).success).toBe(false);
    expect(def.input.safeParse({ id: "a1", location: street }).success).toBe(true);
  });

  it("the read-back names the deed: the time, the address, or both", () => {
    expect(def.describe!(def.input.parse({ id: "a1", starts_at: "2026-10-19T09:00" }))).toBe("Move this appointment to Mon 10/19 at 9am? Check the details below before you confirm.");
    expect(def.describe!(def.input.parse({ id: "a1", location: street }))).toBe(`Change this appointment's address to "${street}"? Check the details below before you confirm.`);
    expect(def.describe!(def.input.parse({ id: "a1", starts_at: "2026-10-19T09:00", location: street }))).toBe(`Move this appointment to Mon 10/19 at 9am and change its address to "${street}"? Check the details below before you confirm.`);
  });

  it("the tool tells the model about the address and about leaving a field out", () => {
    expect(def.description).toContain("change its address");
    expect(def.description).toContain("Leave a field OUT rather than passing 'null'");
    expect(def.description).toContain("given only a street, ask which town before proposing");
    expect(def.label).toBe("Change appointment");
  });
});

describe("appointment.linkCustomer — the yes has a verb now", () => {
  it("links through the inspector's link door and reads the result back", async () => {
    linkAppointmentTo.mockResolvedValue({ ok: true, id: "a1" });
    db.stored = { title: "Inspection: Tom Goodman", starts_at: "2026-09-25T17:00:00.000Z", ends_at: null, customers: { name: "Tom Goodman" } };
    const def = appointmentActions["appointment.linkCustomer"];
    const cid = "0a8dfe84-f1a4-4a8b-b8bd-df250eeb23b2";
    const r = await def.handler(def.input.parse({ id: "a1", customer_id: cid }), ctx);
    expect(linkAppointmentTo).toHaveBeenCalledWith("a1", "customer", cid);
    expect(r.recorded).toBe('Linked: "Inspection: Tom Goodman", Fri Sep 25 at 10:00 AM PDT, customer "Tom Goodman".');
  });
});
