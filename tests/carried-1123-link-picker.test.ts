import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "@/test/fake-supabase";

/**
 * CARRIED FROM audit v1120 (fix wave cn-v1123): the For picker's Add As A New Lead dropped the lead
 * door's own note, and Edit Details with New Lead cleared the visit's customer before the lead existed.
 */
type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({
  db: null as null | ReturnType<typeof import("@/test/fake-supabase").fakeDb>,
  seenAtLead: null as unknown,
}));

vi.mock("@/lib/staff-guard", () => ({
  requireStaff: vi.fn(async () => ({ supabase: s.db!.sb, userId: "u1", orgId: "o1", role: "owner" })),
  requireMember: vi.fn(async () => ({ supabase: s.db!.sb, userId: "u1", orgId: "o1", role: "owner" })),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => s.db!.sb), createServiceClient: vi.fn(() => s.db!.sb) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/calendar-sync", () => ({ pushCalendarItem: vi.fn(async () => {}), deleteCalendarItem: vi.fn(async () => {}) }));
vi.mock("@/lib/notifications", () => ({ notifyPeople: vi.fn(async () => ({ bell: true, pushed: [] })) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => {}) }));
const createInquiry = vi.fn(async (_fd: FormData) => ({ ok: true, id: "lead-1" }) as { ok: boolean; id?: string; error?: string; note?: string });
vi.mock("@/app/(app)/leads/actions", () => ({
  createInquiry: (fd: FormData) => {
    // What the visit's customer was at the moment the lead door ran: the lead must not wait on a cleared row.
    s.seenAtLead = s.db!.tables.appointments[0].customer_id;
    return createInquiry(fd);
  },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }));

import { updateAppointment } from "@/app/(app)/appointments/actions";
import { LINK_NO_SIGNAL_LINE, settleLink } from "@/app/(app)/appointments/[id]/link-picker";

const ROOT = path.resolve(__dirname, "..");
const picker = readFileSync(path.join(ROOT, "src/app/(app)/appointments/[id]/link-picker.tsx"), "utf8");
const actions = readFileSync(path.join(ROOT, "src/app/(app)/appointments/actions.ts"), "utf8");

describe("Add As A New Lead in the For picker drops the lead door's own note (duplicate-customer warning)", () => {
  it("a rejected action is a line in words, never a throw out of the transition", async () => {
    const out = await settleLink(Promise.reject(new Error("fetch failed")), "Couldn't make the lead.");
    expect(out).toEqual({ error: LINK_NO_SIGNAL_LINE });
    expect(LINK_NO_SIGNAL_LINE).toContain("didn't go through");
  });

  it("a refusal speaks in the action's own words, else the caller's fallback", async () => {
    expect(await settleLink(Promise.resolve({ ok: false, error: "Type the person's name first." }), "x")).toEqual({ error: "Type the person's name first." });
    expect(await settleLink(Promise.resolve({ ok: false }), "Couldn't make the lead.")).toEqual({ error: "Couldn't make the lead." });
    expect(await settleLink(Promise.resolve(undefined as unknown as { ok: boolean }), "Couldn't make the lead.")).toEqual({ error: "Couldn't make the lead." });
  });

  it("a write that landed hands its answer back whole, the lead door's note with it", async () => {
    const res = { ok: true, id: "lead-1", note: "You have 2 customers named Pat Thistlewood, so this lead isn't linked to either." };
    expect(await settleLink(Promise.resolve(res), "x")).toEqual({ res });
  });

  it("the lead button reads the note aloud as a sticky toast BEFORE the picker closes, and goes through settleLink", () => {
    expect(picker).toContain('settleLink(linkAppointmentToNewLead(appointmentId, typed), "Couldn\'t make the lead.")');
    const note = picker.indexOf('if (done.res.note) toast(done.res.note, "info", undefined, { sticky: true });');
    expect(note).toBeGreaterThan(-1);
    expect(picker.indexOf("setOpen(false);", note)).toBeGreaterThan(note);
    // No bare await left on either button: the old shape threw out of start() on a dead signal.
    expect(picker).not.toContain("const res = await linkAppointmentToNewLead(");
    expect(picker).not.toContain("const res = await linkAppointmentTo(");
  });

  it("a picked row says its refusal where the tap was, and reads a warning the way the lead button does", () => {
    expect(picker).toContain('settleLink(linkAppointmentTo(appointmentId, r.kind, r.id), "Couldn\'t connect it — try again.")');
    expect(picker).toContain('if (done.res.warning) toast(done.res.warning, "info", undefined, { sticky: true });');
  });
});

const VISIT: Row = {
  id: "a1",
  org_id: "o1",
  type: "inspection",
  title: "Pat Thistlewood",
  location: "12 Bayberry Ln, Thistlewood, CA 96100",
  city: "Thistlewood",
  state: "CA",
  zip: "96100",
  customer_id: "c1",
  inquiry_id: null,
  job_id: null,
  outcome: null,
};
const lead = (customer_id: string | null = null): Row => ({
  id: "lead-1",
  name: "Pat Thistlewood",
  address: "12 Bayberry Ln",
  city: "Thistlewood",
  state: "CA",
  zip: "96100",
  customer_id,
});

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  const base = {
    title: "Pat Thistlewood",
    date: "2026-10-20",
    start_time: "09:00",
    starts_at_iso: "2026-10-20T16:00:00.000Z",
    type: "inspection",
    location: "12 Bayberry Ln, Thistlewood, CA 96100",
    ...fields,
  };
  for (const [k, v] of Object.entries(base)) fd.set(k, v);
  return fd;
}

const visitNow = () => s.db!.tables.appointments[0];
const STAYS = "The lead was made, but the old customer is still on this visit — change it from the visit's For box.";

describe("Edit Details with New Lead clears the visit's customer before the lead exists", () => {
  beforeEach(() => {
    s.db = fakeDb({ appointments: [{ ...VISIT }], inquiries: [lead()], customers: [{ id: "c1", name: "Pat Thistlewood" }] });
    s.seenAtLead = null;
    createInquiry.mockReset();
    createInquiry.mockResolvedValue({ ok: true, id: "lead-1" });
  });

  it("the customer is still on the visit when the lead door runs, and goes only once the lead exists", async () => {
    const r = await updateAppointment("a1", form({ customer_id: "__lead__", new_customer_name: "Pat Thistlewood" }));
    expect(r).toEqual({ ok: true });
    expect(createInquiry).toHaveBeenCalledTimes(1);
    expect(s.seenAtLead).toBe("c1"); // the edit did not clear it first
    expect(visitNow().inquiry_id).toBe("lead-1");
    expect(visitNow().customer_id).toBeNull(); // the lead replaced the customer, as the pick said
  });

  it("a lead that cannot be made leaves the visit as it was, and says so in words", async () => {
    createInquiry.mockResolvedValue({ ok: false, error: "Add a name, phone, or note to save the lead." });
    const r = await updateAppointment("a1", form({ customer_id: "__lead__", new_customer_name: "Pat Thistlewood" }));
    expect(r.ok).toBe(true);
    expect(visitNow().customer_id).toBe("c1");
    expect(visitNow().inquiry_id).toBeNull();
    expect((r as { warning?: string }).warning).toBe("Saved, but the lead wasn't made: Add a name, phone, or note to save the lead. The visit keeps its customer.");
  });

  it("a name too short for the lead door is refused before any lead, and the customer stays", async () => {
    const r = await updateAppointment("a1", form({ customer_id: "__lead__", new_customer_name: "P" }));
    expect(createInquiry).not.toHaveBeenCalled();
    expect(visitNow().customer_id).toBe("c1");
    expect((r as { warning?: string }).warning).toContain("The visit keeps its customer.");
    expect((r as { warning?: string }).warning).toContain("Type the person's name first");
  });

  it("a lead that came with its own customer puts that one on the visit and nothing is taken off after", async () => {
    s.db = fakeDb({ appointments: [{ ...VISIT }], inquiries: [lead("c9")], customers: [] });
    const r = await updateAppointment("a1", form({ customer_id: "__lead__", new_customer_name: "Pat Thistlewood" }));
    expect(r).toEqual({ ok: true });
    expect(visitNow().customer_id).toBe("c9");
  });

  it("the lead's own note (a name shared by several customers) is still said, and the old customer still goes", async () => {
    createInquiry.mockResolvedValue({ ok: true, id: "lead-1", note: "You have 2 customers named Pat Thistlewood, so this lead isn't linked to either." });
    const r = await updateAppointment("a1", form({ customer_id: "__lead__", new_customer_name: "Pat Thistlewood" }));
    expect((r as { warning?: string }).warning).toBe("You have 2 customers named Pat Thistlewood, so this lead isn't linked to either.");
    expect(visitNow().customer_id).toBeNull();
  });

  it("an old customer that cannot be taken off is said, not left silent", async () => {
    s.db = fakeDb(
      { appointments: [{ ...VISIT }], inquiries: [lead()], customers: [] },
      { onUpdate: (table, patch) => (table === "appointments" && patch.customer_id === null ? { message: "write refused" } : undefined) },
    );
    const r = await updateAppointment("a1", form({ customer_id: "__lead__", new_customer_name: "Pat Thistlewood" }));
    expect(r.ok).toBe(true);
    expect(visitNow().inquiry_id).toBe("lead-1");
    expect((r as { warning?: string }).warning).toBe(STAYS);
  });

  it("a visit with no customer keeps the plain wording: there is nothing to keep", async () => {
    s.db = fakeDb({ appointments: [{ ...VISIT, customer_id: null }], inquiries: [lead()], customers: [] });
    createInquiry.mockResolvedValue({ ok: false, error: "Add a name, phone, or note to save the lead." });
    const r = await updateAppointment("a1", form({ customer_id: "__lead__", new_customer_name: "Pat Thistlewood" }));
    expect((r as { warning?: string }).warning).toBe("Saved, but the lead wasn't made: Add a name, phone, or note to save the lead.");
  });

  it("an edit that is not New Lead still writes the customer it picked, or none", async () => {
    await updateAppointment("a1", form({ customer_id: "c2" }));
    expect(visitNow().customer_id).toBe("c2");
    await updateAppointment("a1", form({ customer_id: "" }));
    expect(visitNow().customer_id).toBeNull();
    expect(createInquiry).not.toHaveBeenCalled();
  });

  it("the edit's patch leaves customer_id out for New Lead, and the row's own customer is read for it", () => {
    expect(actions).toContain("...(cust.lead ? {} : { customer_id: customerId }),");
    expect(actions).toContain('.select("type, city, state, zip, inquiry_id, customer_id")');
    expect(actions).toContain("attachNewLead(id, cust.lead, !!row?.customer_id)");
  });
});
