import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * NORT DROPS THE LINK OFFER (bug-report triage 2026-09-27, Erik's 9/24 chat). Nort booked an
 * inspection for a man who wasn't in the book; on "Yes, add him as a contact" it created him and
 * asked "Want me to link him to tomorrow's inspection?"; Erik's next message was the phone number,
 * and the link never happened. These drive the REAL handlers with the server actions and the
 * database stubbed: the link is made in the same yes when it's certain, and an open offer survives
 * an answer that isn't a yes.
 */
const { createCustomer, patchCustomer, linkAppointmentTo, db } = vi.hoisted(() => ({
  createCustomer: vi.fn(),
  patchCustomer: vi.fn(),
  linkAppointmentTo: vi.fn(),
  db: {
    customer: null as null | { name: string; phone: string | null; email: string | null; address: string | null },
    visits: [] as { id: string; title: string | null; location: string | null; starts_at: string | null }[],
    visitFilters: [] as [string, unknown][],
  },
}));

vi.mock("@/app/(app)/crm/actions", () => ({ createCustomer, patchCustomer }));
vi.mock("@/app/(app)/appointments/actions", () => ({ linkAppointmentTo }));

/** customers → the row as stored; appointments → the recent customer-less visits; organizations → the zone. */
function fakeClient() {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const k of ["select", "limit", "order"]) chain[k] = () => chain;
      for (const k of ["eq", "is", "in", "gte"]) {
        chain[k] = (col: string, v: unknown) => {
          if (table === "appointments") db.visitFilters.push([`${k} ${col}`, v]);
          return chain;
        };
      }
      chain.maybeSingle = async () =>
        table === "organizations"
          ? { data: { settings: { timezone: "America/Los_Angeles" } }, error: null }
          : table === "customers"
            ? { data: db.customer, error: null }
            : { data: null, error: null };
      chain.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
        Promise.resolve({ data: table === "appointments" ? db.visits : [], error: null }).then(ok, err);
      return chain;
    },
  };
}
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => fakeClient()) }));

import { customerActions } from "./customer";

const ctx = { userId: "u1", orgId: "o1", role: "owner" };
const TOM_VISIT = { id: "78fa75b1-8384-4148-8895-242846abcce5", title: "Inspection — Tom Goodman", location: "3245 W. Lake Blvd, Homewood, CA 96141", starts_at: "2026-09-25T17:00:00.000Z" };
const create = (input: Record<string, unknown>) => customerActions["customer.create"].handler(customerActions["customer.create"].input.parse(input), ctx);
const update = (input: Record<string, unknown>) => customerActions["customer.update"].handler(customerActions["customer.update"].input.parse(input), ctx);

beforeEach(() => {
  vi.clearAllMocks();
  db.visits = [TOM_VISIT];
  db.visitFilters = [];
  db.customer = { name: "Tom Goodman", phone: null, email: null, address: null };
  createCustomer.mockResolvedValue({ ok: true, id: "cust-tom" });
  patchCustomer.mockResolvedValue({ ok: true });
  linkAppointmentTo.mockResolvedValue({ ok: true });
});

describe("customer.create — the yes to adding him is the yes to his booking", () => {
  it("links the one visit booked for him in the same action, and says so", async () => {
    const r = await create({ name: "Tom Goodman" });
    expect(r.ok).toBe(true);
    expect(linkAppointmentTo).toHaveBeenCalledWith(TOM_VISIT.id, "customer", "cust-tom");
    expect(r.recorded).toBe('Saved: "Tom Goodman". Linked to the visit "Inspection — Tom Goodman", Fri Sep 25 at 10:00 AM PDT.');
    expect(r.data).toMatchObject({
      id: "cust-tom",
      linked: { appointment_id: TOM_VISIT.id, title: '"Inspection — Tom Goodman"', when: "Fri Sep 25 at 10:00 AM PDT" },
    });
    expect((r.data as Record<string, unknown>).link_offer).toBeUndefined();
    expect(String((r.data as Record<string, unknown>).next_step)).toContain("ALREADY linked");
  });

  it("only looks at customer-less visits THIS person booked lately, still to happen", async () => {
    await create({ name: "Tom Goodman" });
    expect(db.visitFilters).toEqual(
      expect.arrayContaining([
        ["is customer_id", null],
        ["eq created_by", "u1"],
        ["in status", ["scheduled", "proposed"]],
      ]),
    );
    expect(db.visitFilters.some(([f]) => f === "gte created_at")).toBe(true);
  });

  it("two visits name him: nothing is linked for him, both are offered and Nort asks which", async () => {
    db.visits = [TOM_VISIT, { ...TOM_VISIT, id: "second", title: "Final — Tom Goodman" }];
    const r = await create({ name: "Tom Goodman" });
    expect(linkAppointmentTo).not.toHaveBeenCalled();
    expect((r.data as { link_offer: unknown[] }).link_offer).toHaveLength(2);
    expect(String((r.data as Record<string, unknown>).next_step)).toContain("ask which of the visits in link_offer");
    expect(r.recorded).toBe('Saved: "Tom Goodman".');
  });

  it("a link that doesn't take is said, and the visit is offered instead — the customer is saved either way", async () => {
    linkAppointmentTo.mockResolvedValue({ ok: false, error: "Appointment not found." });
    const r = await create({ name: "Tom Goodman" });
    expect(r.ok).toBe(true);
    expect(r.recorded).toContain("Couldn't link the visit \"Inspection — Tom Goodman\" yet (Appointment not found.)");
    expect(r.data).toMatchObject({ link_failed: "Appointment not found." });
    expect((r.data as { link_offer: unknown[] }).link_offer).toHaveLength(1);
  });

  it("a first name alone, or a sub/supplier/inspector: nothing is linked for him, the visit is offered", async () => {
    for (const input of [{ name: "Tom" }, { name: "Tom Goodman", type: "subcontractor" }]) {
      linkAppointmentTo.mockClear();
      const r = await create(input);
      expect(linkAppointmentTo, JSON.stringify(input)).not.toHaveBeenCalled();
      expect((r.data as { link_offer: unknown[] }).link_offer).toHaveLength(1);
      expect(String((r.data as Record<string, unknown>).next_step)).toContain("In THIS answer, ask whether to link");
      expect(r.recorded).not.toContain("Linked");
    }
  });

  it("nobody booked: no link, no offer, just the saved customer", async () => {
    db.visits = [];
    const r = await create({ name: "Rita Moss" });
    expect(linkAppointmentTo).not.toHaveBeenCalled();
    expect(r.data).toEqual({ id: "cust-tom" });
  });

  it("a failed create links nothing", async () => {
    createCustomer.mockResolvedValue({ ok: false, error: "Name is required." });
    const r = await create({ name: "Tom Goodman" });
    expect(r).toEqual({ ok: false, error: "Name is required." });
    expect(linkAppointmentTo).not.toHaveBeenCalled();
  });
});

describe("customer.update — an open offer survives an answer that isn't a yes", () => {
  it("his phone number, while the visit is still customer-less: the update carries the offer again", async () => {
    // The create offered (two candidates, say); Erik answered with the number, not a pick.
    db.visits = [TOM_VISIT, { ...TOM_VISIT, id: "second", title: "Final — Tom Goodman" }];
    db.customer = { name: "Tom Goodman", phone: "(916) 992-4711", email: null, address: null };
    const r = await update({ id: "cust-tom", phone: "916 992 4711" });
    expect(r.ok).toBe(true);
    expect(r.recorded).toBe('Saved: "Tom Goodman" · (916) 992-4711.');
    const data = r.data as { link_offer: { appointment_id: string }[]; next_step: string };
    expect(data.link_offer.map((o) => o.appointment_id)).toEqual([TOM_VISIT.id, "second"]);
    expect(data.next_step).toContain("appointment.linkCustomer");
    // Carried, not new: ask only while nobody answered it.
    expect(data.next_step).toContain("ONLY if the person hasn't answered it yet");
  });

  it("after a no (declined_link), the update carries no offer and asks nothing; the flag never reaches the row", async () => {
    const r = await update({ id: "cust-tom", email: "tom@example.com", declined_link: true });
    expect(r).toEqual({ ok: true, recorded: 'Saved: "Tom Goodman".' });
    expect(linkAppointmentTo).not.toHaveBeenCalled();
    expect(patchCustomer).toHaveBeenCalledWith("cust-tom", { email: "tom@example.com" });
    expect(db.visitFilters).toEqual([]);
  });

  it("an update never links for them (they were editing the person), even when one visit certainly matches", async () => {
    const r = await update({ id: "cust-tom", phone: "916 992 4711" });
    expect(linkAppointmentTo).not.toHaveBeenCalled();
    expect((r.data as { link_offer: unknown[] }).link_offer).toHaveLength(1);
  });

  it("nothing pending: the update reads as it always did", async () => {
    db.visits = [];
    const r = await update({ id: "cust-tom", phone: "916 992 4711" });
    expect(r).toEqual({ ok: true, recorded: 'Saved: "Tom Goodman".' });
  });
});
