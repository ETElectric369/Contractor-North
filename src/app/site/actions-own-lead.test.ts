import { describe, it, expect, vi, beforeEach } from "vitest";
import { standIn, type Row } from "@/lib/inquiries/public-stand-in.test-support";

/**
 * A LEAD ID LEAVES THE SERVER ONLY FOR A LEAD THIS CALL CREATED (skeptic #87, S1). The REAL
 * createTriagedInquiry runs here, on the stand-in that honours filters: it comes back to an open lead
 * of the same phone (audit v921, one person one lead), and that lead was found by what was TYPED.
 * Anyone can type somebody's phone, so its id must never reach the browser: the stranger would hold
 * Sam Tillery's lead and could book a visit at Sam's address. The sibling actions.test.ts mocks the
 * create and so cannot see this.
 */
const svc = vi.hoisted(() => ({ client: null as any }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: vi.fn(async () => false), clientIp: () => "203.0.113.9" }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => svc.client, createClient: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ createNotifications: vi.fn(async () => undefined) }));
vi.mock("@/lib/push", () => ({ sendPushToProfiles: vi.fn(async () => undefined), orgStaffIds: vi.fn(async () => []) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => undefined) }));

const { submitSiteContact } = await import("./actions");

const ORG = "0a0a0a0a-0000-4000-8000-000000000001";
const ago = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
const samsLead = (): Row => ({
  id: "lead-sam", org_id: ORG, name: "Sam Tillery", phone: "555-0100", email: null, status: "new", converted_at: null,
  created_at: ago(72), updated_at: ago(72), message: "A deck on Larkspur", address: "1 Larkspur Way", intake: {},
});
const world = (leads: Row[]) => {
  const db = standIn({ organizations: [{ id: ORG, name: "Larkspur Decks", settings: { public_handle: "larkspur" } }], profiles: [], inquiries: leads });
  svc.client = db.client;
  return db;
};
const stranger = { name: "Dana Rook", phone: "(555) 0100", message: "Hello" };

beforeEach(() => void world([]));

describe("the hosted site's contact form, with the real createTriagedInquiry", () => {
  it("a submit that comes back to an open lead of the same phone hands back NO lead id", async () => {
    const db = world([samsLead()]);
    const res = await submitSiteContact(ORG, stranger);
    expect(res).toEqual({ ok: true });
    expect(db.tables.inquiries).toHaveLength(1); // it came back to Sam's lead, wrote no new one
  });

  it("a fresh submit hands back the id of the lead it wrote", async () => {
    const db = world([]);
    const res = await submitSiteContact(ORG, stranger);
    expect(db.tables.inquiries).toHaveLength(1);
    expect(res).toEqual({ ok: true, leadId: db.tables.inquiries[0].id });
  });
});
