/**
 * A NAME TYPED FROM MEMORY STICKS (bug b5d65868, Erik 2026-10-14 00:53, the Catbird inspection):
 * "now ive typed in the owner's name multiple times from memory but it does not save to who is it
 * for". The visit's For box only searched existing leads, customers and jobs, so a new person's
 * name matched nothing and was dropped with "carry on, you can connect this later" — a dead end
 * dressed as reassurance. Now the box offers the name as a NEW LEAD (the record a person gets
 * before the win), the lead takes the visit's place, and the visit is linked to it in one tap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fakeDb } from "@/test/fake-supabase";

type Row = Record<string, unknown>;
const s = vi.hoisted(() => ({ db: null as null | ReturnType<typeof import("@/test/fake-supabase").fakeDb> }));

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

import { linkAppointmentToNewLead } from "@/app/(app)/appointments/actions";

const visit = (): Row => ({
  id: "a1",
  org_id: "o1",
  type: "inspection",
  title: "Bayberry - Tahoe City",
  location: "12 Bayberry Rd, Carnelian Bay, CA 96140, USA",
  city: "Carnelian Bay",
  state: "CA",
  zip: "96140",
  customer_id: null,
  inquiry_id: null,
  job_id: null,
  outcome: null,
});

describe("the For box: a typed name becomes the lead this visit is for", () => {
  beforeEach(() => {
    s.db = fakeDb({ appointments: [visit()], inquiries: [], customers: [] });
  });

  it("makes the lead with the visit's own place and links the visit to it; the person's title is untouched", async () => {
    const r = await linkAppointmentToNewLead("a1", "  Catbird   Bayberry ");
    expect(r.ok).toBe(true);
    const lead = s.db!.inserted.inquiries?.[0];
    expect(lead).toMatchObject({ name: "Catbird Bayberry", address: "12 Bayberry Rd", city: "Carnelian Bay", state: "CA", zip: "96140", status: "new", source: "manual", created_by: "u1" });
    const a = s.db!.tables.appointments[0];
    expect(a.inquiry_id).toBe(lead!.id);
    expect(a.title).toBe("Bayberry - Tahoe City"); // named by a person: never replaced
    expect(a.location).toBe("12 Bayberry Rd, Carnelian Bay, CA 96140, USA"); // fill, never overwrite
  });

  it("a known customer's name links the lead to that customer too (the Leads form's own match rides along)", async () => {
    s.db = fakeDb({
      appointments: [visit()],
      inquiries: [],
      customers: [{ id: "c9", name: "Catbird Bayberry", phone: "5305550133", email: null, address: null, city: null, state: null, zip: null, company_name: null }],
    });
    const r = await linkAppointmentToNewLead("a1", "Catbird Bayberry");
    expect(r.ok).toBe(true);
    // The phone is carried as the customer row holds it (carryFromCustomer copies, it never reformats).
    expect(s.db!.inserted.inquiries?.[0]).toMatchObject({ customer_id: "c9", phone: "5305550133" });
    expect(s.db!.tables.appointments[0].customer_id).toBe("c9");
  });

  it("refuses an empty or one-letter name, and a visit that is not there, in words", async () => {
    expect(await linkAppointmentToNewLead("a1", " ")).toEqual({ ok: false, error: "Type the person's name first." });
    expect(await linkAppointmentToNewLead("a1", "C")).toEqual({ ok: false, error: "Type the person's name first." });
    expect(await linkAppointmentToNewLead("nope", "Catbird")).toEqual({ ok: false, error: "Appointment not found." });
    expect(s.db!.inserted.inquiries ?? []).toEqual([]);
  });
});

describe("the picker offers it, pinned", () => {
  const picker = readFileSync("src/app/(app)/appointments/[id]/link-picker.tsx", "utf8");
  it("offers Add As A New Lead for what was TYPED only (never the address seed), where a lead may be picked, and not for a name already in the rows", () => {
    expect(picker).toContain('const offerLead = !searching && open && typed.length >= 2 && (!kinds || kinds.includes("lead")) && !rows.some((r) => r.name.trim().toLowerCase() === typed.toLowerCase());');
    expect(picker).toContain("const typed = q.replace(/\\s+/g, \" \").trim();");
    expect(picker).toContain(">Add As A New Lead<");
    expect(picker).toContain("linkAppointmentToNewLead(appointmentId, typed)");
    // Nothing silent: a refusal is shown where the tap was.
    expect(picker).toContain('<p role="alert" className="px-1 py-1 text-xs text-red-700">');
    // The old reassurance stays for the address seed; the typed-name case says the honest thing.
    expect(picker).toContain('offerLead ? "Nobody by that name yet." : "Nothing matches yet — carry on, you can connect this later."');
  });
  it("the ending card's Won · Pick The Job (jobs only) never offers a lead", () => {
    expect(readFileSync("src/app/(app)/appointments/[id]/visit-ending.tsx", "utf8")).toContain('kinds={["job"]}');
  });
});
