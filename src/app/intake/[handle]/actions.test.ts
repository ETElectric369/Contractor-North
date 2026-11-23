import { describe, it, expect, vi, beforeEach } from "vitest";
import { standIn } from "@/lib/inquiries/public-stand-in.test-support";

/**
 * THE INTAKE FORM HANDS BACK ONLY ITS OWN LEAD (cn-v1185, audit A6). submitIntake now returns
 * `leadId`, the key its thank-you's "Pick a Time for a Site Visit" attaches by: ONLY the id
 * createTriagedInquiry returned to this very call, never a lead found by a typed phone or e-mail.
 * The create is stood in for; the stand-in client logs every read, so a lookup of leads would show.
 * The organization row carries its handle under the filter's own key, because the stand-in matches
 * `settings->>public_handle` as a plain column name.
 */
const svc = vi.hoisted(() => ({ client: null as any, log: [] as { table: string }[] }));
const create = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: vi.fn(async () => false), clientIp: () => "203.0.113.9" }));
vi.mock("@/lib/supabase/server", () => ({ createServiceClient: () => svc.client, createClient: vi.fn() }));
vi.mock("@/lib/plan-brief-run", () => ({ runPlanBrief: vi.fn(async () => undefined) }));
vi.mock("@/lib/inquiries/create-triaged-inquiry", () => ({ createTriagedInquiry: (...a: unknown[]) => create.fn(...a) }));

const { submitIntake } = await import("./actions");

const ORG = "0a0a0a0a-0000-4000-8000-000000000001";
const dana = { contact: { name: "Dana Rook", phone: "555-0101", email: "dana@example.com", address: "3 Snowbell Way" }, answers: {} };

beforeEach(() => {
  const db = standIn({
    organizations: [{ id: ORG, settings: { public_handle: "larkspur" }, "settings->>public_handle": "larkspur" }],
    forms: [{ id: "form-1", org_id: ORG, is_public_intake: true, schema: null, playbook: null }],
    // A lead already on file with the same phone: it must never be the id handed back.
    inquiries: [{ id: "someone-elses-lead", org_id: ORG, phone: "555-0101", email: "dana@example.com" }],
  });
  svc.client = db.client;
  svc.log = db.log;
  create.fn.mockReset();
});

describe("submitIntake returns the lead id its own create returned", () => {
  it("hands back exactly what createTriagedInquiry returned to this call", async () => {
    create.fn.mockResolvedValue({ id: "lead-this-call", triage: {} });
    expect(await submitIntake("larkspur", dana)).toEqual({ ok: true, leadId: "lead-this-call" });
    expect(create.fn).toHaveBeenCalledTimes(1);
    expect(create.fn.mock.calls[0][1]).toBe(ORG);
  });

  it("never reads a lead by the typed phone or e-mail", async () => {
    create.fn.mockResolvedValue({ id: "lead-this-call", triage: {} });
    await submitIntake("larkspur", dana);
    expect(svc.log.some((l) => l.table === "forms")).toBe(true); // the log is live
    expect(svc.log.filter((l) => l.table === "inquiries")).toEqual([]);
  });

  it("a failed create, a bot or a refusal hands back no id", async () => {
    create.fn.mockRejectedValue(new Error("down"));
    expect(await submitIntake("larkspur", dana)).toEqual({ ok: false, error: "Something went wrong — please call us instead." });
    expect(await submitIntake("larkspur", { ...dana, hp: "x" })).toEqual({ ok: true });
    expect(await submitIntake("nobody", dana)).not.toHaveProperty("leadId");
  });
});
