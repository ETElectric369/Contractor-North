import { describe, it, expect, vi, beforeEach } from "vitest";
import { getOrgSettings } from "@/lib/org-settings";

/**
 * THE PUBLIC SITE CHAT OF A COMPANY WHOSE PLAN HAS ENDED (cn-v1137, decision 3). A visitor on the
 * contractor's website is answered ONE line — "This company's assistant is paused." — as a normal
 * reply (200, done), and the model is never reached. A stranger is told nothing about plans. The
 * standing comes through the one gate (aiAllowed → orgAccess); a standing company still chats.
 */
const access = vi.hoisted(() => ({ active: true }));
const org = () => ({
  id: "org-1",
  name: "Fixture Co",
  phone: null,
  email: null,
  license: null,
  logo_url: null,
  city: null,
  state: null,
  updated_at: null,
  settings: getOrgSettings({ public_handle: "fixture" }),
});
vi.mock("@/lib/public-org", async (orig) => ({
  ...(await orig<typeof import("@/lib/public-org")>()),
  getPublicOrgByHandle: async (h: string) => (h === "fixture" ? org() : null),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: async () => false, clientIp: () => "203.0.113.9" }));
vi.mock("@/lib/org-access", async (orig) => ({
  ...(await orig<typeof import("@/lib/org-access")>()),
  orgAccess: vi.fn(async () => ({
    state: access.active
      ? { active: true, reason: "active", daysLeft: null, compedBy: null }
      : { active: false, reason: "canceled", daysLeft: null, compedBy: null },
    org: null,
    readFailed: false,
  })),
}));
const create = vi.fn(async (_args: unknown) => ({ content: [{ type: "text", text: "Hello." }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }));
vi.mock("@/lib/anthropic", () => ({ getAnthropic: () => ({ messages: { create } }) }));
vi.mock("@/lib/supabase/server", () => ({
  createServiceClient: () => ({
    rpc: async () => ({ data: 0, error: null }), // the ceiling RPC: nothing spent
    from: () => {
      const q: any = {
        select: () => q,
        eq: () => q,
        in: () => q,
        order: () => q,
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      };
      return q;
    },
  }),
}));

const { POST: chat } = await import("./route");

const ask = () => chat(new Request("https://x/api/site-chat", { method: "POST", body: JSON.stringify({ handle: "fixture", messages: [{ role: "user", content: "hi" }] }) }));

beforeEach(() => {
  access.active = true;
  create.mockClear();
});

describe("the public site chat and a plan that has ended", () => {
  it("a standing company's visitor is answered by the model", async () => {
    const res = await ask();
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("a lapsed company's visitor gets ONE line, as a finished reply, and the model is never reached", async () => {
    access.active = false;
    const res = await ask();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: "This company's assistant is paused.", done: true });
    expect(create).not.toHaveBeenCalled();
  });
});
