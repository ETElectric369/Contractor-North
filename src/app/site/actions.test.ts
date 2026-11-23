import { describe, it, expect, vi, beforeEach } from "vitest";
import { standIn } from "@/lib/inquiries/public-stand-in.test-support";

/**
 * THE CONTACT FORM HANDS BACK ONLY ITS OWN LEAD (cn-v1185, audit A6). The hosted site's contact form
 * now returns `leadId`, the key its thank-you's "Pick a Time for a Site Visit" attaches by. It may be
 * ONLY the id createTriagedInquiry returned to this very call: never a lead found by the phone or
 * e-mail the visitor typed (anyone can type somebody's phone). The create is stood in for, so what it
 * returns is known; the stand-in client logs every read, so a lookup of leads would show.
 */
const svc = vi.hoisted(() => ({ client: null as any, log: [] as { table: string }[] }));
const create = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: vi.fn(async () => false), clientIp: () => "203.0.113.9" }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => svc.client, createClient: vi.fn() }));
vi.mock("@/lib/inquiries/create-triaged-inquiry", () => ({ createTriagedInquiry: (...a: unknown[]) => create.fn(...a) }));

const { submitSiteContact } = await import("./actions");

const ORG = "0a0a0a0a-0000-4000-8000-000000000001";
const sam = { name: "Sam Tillery", phone: "555-0100", email: "sam@example.com", message: "A deck on Larkspur" };

beforeEach(() => {
  const db = standIn({
    organizations: [{ id: ORG, settings: { public_handle: "larkspur" } }],
    // A lead already on file with the same phone: it must never be the id handed back.
    inquiries: [{ id: "someone-elses-lead", org_id: ORG, phone: "555-0100", email: "sam@example.com" }],
  });
  svc.client = db.client;
  svc.log = db.log;
  create.fn.mockReset();
});

describe("submitSiteContact returns the lead id its own create returned", () => {
  it("hands back exactly what createTriagedInquiry returned to this call", async () => {
    create.fn.mockResolvedValue({ id: "lead-this-call", triage: {} });
    const res = await submitSiteContact(ORG, sam);
    expect(res).toEqual({ ok: true, leadId: "lead-this-call" });
    expect(create.fn).toHaveBeenCalledTimes(1);
    expect(create.fn.mock.calls[0][1]).toBe(ORG);
  });

  it("never reads a lead by the typed phone or e-mail", async () => {
    create.fn.mockResolvedValue({ id: "lead-this-call", triage: {} });
    await submitSiteContact(ORG, sam);
    expect(svc.log.some((l) => l.table === "organizations")).toBe(true); // the log is live
    expect(svc.log.filter((l) => l.table === "inquiries")).toEqual([]);
  });

  it("a failed create, a bot or a refusal hands back no id", async () => {
    create.fn.mockRejectedValue(new Error("down"));
    expect(await submitSiteContact(ORG, sam)).toEqual({ ok: false, error: "Couldn't send — please call us instead." });
    expect(await submitSiteContact(ORG, { ...sam, hp: "x" })).toEqual({ ok: true });
    expect(await submitSiteContact(ORG, { ...sam, phone: "", email: "" })).not.toHaveProperty("leadId");
  });
});
