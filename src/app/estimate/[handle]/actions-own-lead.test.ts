import { describe, it, expect, vi } from "vitest";
import { standIn, type Row } from "@/lib/inquiries/public-stand-in.test-support";

/**
 * A LEAD ID LEAVES THE SERVER ONLY FOR A LEAD THIS CALL CREATED (skeptic #87, S1), the deck
 * configurator, which handed back a lead found by a typed phone since cn-v1180. The REAL
 * createTriagedInquiry on the stand-in: a submit with the phone of an open lead comes back to that
 * lead, and its id must never reach the browser (its site-visit tap would book at Sam's address).
 */
const svc = vi.hoisted(() => ({ client: null as any }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: vi.fn(async () => false), clientIp: () => "203.0.113.9" }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => svc.client, createClient: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ createNotifications: vi.fn(async () => undefined) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => undefined), orgStaffIds: vi.fn(async () => []) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => undefined) }));

const { submitEstimateLead } = await import("./actions");

const ORG = "0a0a0a0a-0000-4000-8000-000000000001";
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const samsLead = (): Row => ({
  id: "lead-sam", org_id: ORG, name: "Sam Tillery", phone: "555-0100", email: null, status: "new", converted_at: null,
  created_at: ago(72), updated_at: ago(72), message: null, address: "1 Larkspur Way", intake: {},
});
const world = (leads: Row[]) => {
  const settings = { public_handle: "larkspur", trade: "deck", estimating_mode: "catalog" };
  const db = standIn({
    organizations: [{ id: ORG, name: "Larkspur Decks", settings, "settings->>public_handle": "larkspur" }],
    price_list_items: [],
    profiles: [],
    inquiries: leads,
  });
  svc.client = db.client;
  return db;
};
const payload = () => ({
  answers: { projectType: "new_deck", material: "wood", lengthFt: 12, widthFt: 16, heightFt: 3, railingLf: 40, stairFlights: 1, stairSteps: 4, stairRailing: true, stairRailingLf: 8, shape: "rectangle", wrapAround: false, manDoors: 1, sliderDoors: 0, trpa: false } as any,
  qualifying: { hasPlans: false, plansApproved: null, noPlansPath: "dimensions" as const },
  contact: { name: "Dana Rook", phone: "555.0100" },
});

describe("the deck configurator, with the real createTriagedInquiry", () => {
  it("a submit that comes back to an open lead of the same phone hands back NO lead id", async () => {
    const db = world([samsLead()]);
    const res = await submitEstimateLead("larkspur", payload());
    expect(res.ok).toBe(true);
    expect(res).not.toHaveProperty("leadId");
    expect(db.tables.inquiries).toHaveLength(1);
  });

  it("a fresh submit hands back the id of the lead it wrote", async () => {
    const db = world([]);
    const res = await submitEstimateLead("larkspur", payload());
    expect(db.tables.inquiries).toHaveLength(1);
    expect(res.leadId).toBe(db.tables.inquiries[0].id);
  });
});
