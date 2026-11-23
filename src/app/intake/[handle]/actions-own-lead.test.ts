import { describe, it, expect, vi } from "vitest";
import { standIn, type Row } from "@/lib/inquiries/public-stand-in.test-support";

/**
 * A LEAD ID LEAVES THE SERVER ONLY FOR A LEAD THIS CALL CREATED (skeptic #87, S1), the intake door.
 * The REAL createTriagedInquiry on the stand-in: a submit with the phone of an open lead comes back to
 * that lead (found by what was TYPED), and its id must never reach the browser. The sibling
 * actions.test.ts mocks the create and so cannot see this.
 */
const svc = vi.hoisted(() => ({ client: null as any }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: vi.fn(async () => false), clientIp: () => "203.0.113.9" }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => svc.client, createClient: vi.fn() }));
vi.mock("@/lib/plan-brief-run", () => ({ runPlanBrief: vi.fn(async () => undefined) }));
vi.mock("@/lib/notifications", () => ({ createNotifications: vi.fn(async () => undefined) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => undefined), orgStaffIds: vi.fn(async () => []) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => undefined) }));

const { submitIntake } = await import("./actions");

const ORG = "0a0a0a0a-0000-4000-8000-000000000001";
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const samsLead = (): Row => ({
  id: "lead-sam", org_id: ORG, name: "Sam Tillery", phone: "555-0100", email: null, status: "new", converted_at: null,
  created_at: ago(72), updated_at: ago(72), message: null, address: "1 Larkspur Way", intake: {},
});
const world = (leads: Row[]) => {
  const db = standIn({
    organizations: [{ id: ORG, name: "Larkspur Decks", settings: { public_handle: "larkspur" }, "settings->>public_handle": "larkspur" }],
    forms: [{ id: "form-1", org_id: ORG, is_public_intake: true, schema: null, playbook: null }],
    profiles: [],
    inquiries: leads,
  });
  svc.client = db.client;
  return db;
};
const stranger = { contact: { name: "Dana Rook", phone: "555 0100", address: "4 Snowbell Rd" }, answers: {} };

describe("the intake form, with the real createTriagedInquiry", () => {
  it("a submit that comes back to an open lead of the same phone hands back NO lead id", async () => {
    const db = world([samsLead()]);
    expect(await submitIntake("larkspur", stranger)).toEqual({ ok: true });
    expect(db.tables.inquiries).toHaveLength(1);
  });

  it("a fresh submit hands back the id of the lead it wrote", async () => {
    const db = world([]);
    const res = await submitIntake("larkspur", stranger);
    expect(db.tables.inquiries).toHaveLength(1);
    expect(res).toEqual({ ok: true, leadId: db.tables.inquiries[0].id });
  });
});
