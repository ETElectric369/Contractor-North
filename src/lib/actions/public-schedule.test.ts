import { describe, it, expect, vi, beforeEach } from "vitest";
import { standIn, type Row } from "@/lib/inquiries/public-stand-in.test-support";

/**
 * THE SITE-VISIT TAP BELONGS TO THE LEAD THIS BROWSER JUST SENT, AND ANSWERS ONE WAY (cn-v1180,
 * audit A6), on a stand-in that honours filters and column lists. The tap used to attach to the
 * newest lead whose phone or e-mail equalled what was TYPED: a stranger with somebody's phone filed
 * a request under that person, pinged the office with their name and street, and was told "You're
 * on the schedule" when they were booked. And (A2) the ping opens the lead's own file.
 */
const svc = vi.hoisted(() => ({ client: null as any }));
const sent = vi.hoisted(() => ({ bell: [] as any[], push: [] as any[] }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: vi.fn(async () => false), clientIp: () => "203.0.113.9" }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => svc.client, createClient: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ createNotifications: vi.fn(async (...a: any[]) => void sent.bell.push(a)) }));
vi.mock("@/lib/push", () => ({
  orgStaffIds: vi.fn(async () => ["p-owner"]),
  sendPushToProfiles: vi.fn(async (...a: any[]) => void sent.push.push(a)),
}));

const { publicScheduleInspection } = await import("./public-schedule");

const ORG = "0a0a0a0a-0000-4000-8000-000000000001";
const OTHER = "0b0b0b0b-0000-4000-8000-000000000002";
const LEAD = "1a1a1a1a-0000-4000-8000-000000000011";
const THEIRS = "2b2b2b2b-0000-4000-8000-000000000022";
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

const lead = (over: Row = {}): Row => ({
  id: LEAD,
  org_id: ORG,
  name: "Sam Tillery",
  phone: "555-0101",
  email: null,
  address: "1 Larkspur Way",
  message: null,
  site_inspection_required: false,
  created_at: ago(1),
  updated_at: ago(1),
  ...over,
});

function world(leads: Row[], appointments: Row[] = []) {
  const db = standIn({
    organizations: [
      { id: ORG, settings: {} },
      { id: OTHER, settings: {} },
    ],
    inquiries: leads,
    appointments,
  });
  svc.client = db.client;
  return db;
}

const tap = (over: Record<string, unknown> = {}) =>
  publicScheduleInspection({ orgId: ORG, name: "Dana Rook", phone: "555-0101", address: "9 Bayberry Ct", ...over });

beforeEach(() => {
  sent.bell = [];
  sent.push = [];
});

describe("no typed key attaches", () => {
  it("another person's phone: a NEW lead is made, the ping carries the typed name, the other lead is untouched", async () => {
    const theirs = lead();
    const db = world([theirs]);
    const res = await tap();
    expect(res).toEqual({ ok: true });
    const made = db.tables.inquiries.filter((r) => r.id !== LEAD);
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ org_id: ORG, name: "Dana Rook", source: "schedule_button" });
    expect(theirs.site_inspection_required).toBe(false);
    expect(sent.bell[0][2].title).toBe("Dana Rook wants an inspection — send them times");
    expect(JSON.stringify(sent.bell)).not.toContain("Larkspur");
    expect(JSON.stringify(sent.bell)).not.toContain("Sam Tillery");
  });
});

describe("the id the same browser's submit returned", () => {
  it("attaches: no new lead, the lead is stamped, and the ping opens its own file", async () => {
    const mine = lead();
    const db = world([mine]);
    expect(await tap({ leadId: LEAD, name: "Sam Tillery" })).toEqual({ ok: true });
    expect(db.tables.inquiries).toHaveLength(1);
    expect(mine.site_inspection_required).toBe(true);
    expect(sent.bell[0][2].url).toBe(`/leads/${LEAD}`);
    expect(sent.push[0][2].url).toBe(`/leads/${LEAD}`);
    const stamp = db.log.find((l) => l.op === "update" && l.table === "inquiries");
    expect(stamp?.filters).toEqual([`id=${LEAD}`, `org_id=${ORG}`]);
  });

  it("skeptic #83 (S2): the ping is built from the lead's OWN contact, never from what was typed", async () => {
    // A stranger holds this lead's id (the kept repeat rule hands it back) and types their own phone.
    world([lead({ phone: "555-0101", email: "lead@example.test", address: "1 Larkspur Way" })]);
    await tap({ leadId: LEAD, name: "Dana Rook", phone: "555-0199", email: "stranger@example.test", address: "9 Bayberry Ct" });
    for (const [, , p] of [...sent.bell, ...sent.push]) {
      expect(p.body).toBe("555-0101 · 1 Larkspur Way");
      expect(p.body).not.toContain("555-0199");
      expect(p.body).not.toContain("stranger@");
      expect(p.body).not.toContain("Bayberry");
    }
    expect(sent.bell).toHaveLength(1);
  });

  it("skeptic #83 (S2): a lead with no phone of its own gives its own e-mail, still never the typed phone", async () => {
    world([lead({ phone: null, email: "lead@example.test", address: null })]);
    await tap({ leadId: LEAD, phone: "555-0199" });
    expect(sent.bell[0][2].body).toBe("lead@example.test");
  });

  it("another company's lead id makes a new lead in THIS company and leaves theirs alone", async () => {
    const theirs = lead({ id: THEIRS, org_id: OTHER });
    const db = world([theirs]);
    expect(await tap({ leadId: THEIRS })).toEqual({ ok: true });
    expect(theirs.site_inspection_required).toBe(false);
    const made = db.tables.inquiries.filter((r) => r.id !== THEIRS);
    expect(made).toHaveLength(1);
    expect(made[0].org_id).toBe(ORG);
    expect(sent.bell[0][0]).toBe(ORG);
  });

  it("an id not touched in the last 24 hours attaches nothing: a new lead", async () => {
    const old = lead({ created_at: ago(50), updated_at: ago(30) });
    const db = world([old]);
    await tap({ leadId: LEAD });
    expect(old.site_inspection_required).toBe(false);
    expect(db.tables.inquiries).toHaveLength(2);
  });

  it("something that is not an id reads nothing at all and makes a new lead", async () => {
    const db = world([lead()]);
    await tap({ leadId: "x' or 1=1" });
    expect(db.log.filter((l) => l.table === "inquiries" && l.op === "select")).toEqual([]);
    expect(db.tables.inquiries).toHaveLength(2);
  });
});

describe("one answer either way", () => {
  it("is byte-identical with and without an inspection a person booked; only the booked one stamps and pings nothing", async () => {
    const free = lead();
    world([free]);
    const a = await tap({ leadId: LEAD });
    expect(free.site_inspection_required).toBe(true);
    expect(sent.bell).toHaveLength(1);

    sent.bell = [];
    const booked = lead();
    world([booked], [{ id: "appt-1", org_id: ORG, inquiry_id: LEAD, type: "inspection", status: "scheduled", created_by: "p-owner" }]);
    const b = await tap({ leadId: LEAD });
    expect(booked.site_inspection_required).toBe(false);
    expect(sent.bell).toEqual([]);

    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(a).toEqual({ ok: true });
  });

  it("both public forms read the one sentence, true either way, and neither reads `already`", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { SITE_VISIT_REQUESTED } = await import("@/app/inquire/site-visit-words");
    expect(SITE_VISIT_REQUESTED).toContain("If you're already on our schedule, you're all set");
    for (const rel of ["src/app/inquire/[org]/inquiry-form.tsx", "src/app/estimate/[handle]/configurator.tsx"]) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      expect(src, rel).toContain("SITE_VISIT_REQUESTED");
      expect(src, rel).toContain("leadId");
      expect(src, rel).not.toContain("res.already");
      expect(src, rel).not.toContain("You're on the schedule");
    }
  });
});
