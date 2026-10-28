import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE VOICE GATE AND THE PLAN THAT HAS ENDED (cn-v1137, decision 3). /api/tts and /api/transcribe
 * both ride voiceGate: after the session and the per-person window, a company whose plan has ended
 * is answered 402 in the asker's words — no paid ElevenLabs or OpenAI call behind it. The standing
 * comes from orgAccess (the service client, the billing columns), which FAILS OPEN on a failed read.
 */
const db = vi.hoisted(() => ({
  user: { id: "user-1" } as { id: string } | null,
  me: { org_id: "org-1", role: "office" } as Record<string, unknown> | null,
  org: null as Record<string, unknown> | null,
  orgFails: false,
  meFails: false,
  limited: false,
}));
vi.mock("@/lib/stripe", async (orig) => ({ ...(await orig<typeof import("@/lib/stripe")>()), billingEnabled: true }));
vi.mock("@/lib/observe", async (orig) => ({ ...(await orig<typeof import("@/lib/observe")>()), reportError: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: vi.fn(async () => db.limited) }));
vi.mock("@/lib/supabase/server", () => {
  const chain = (table: string, byId: boolean) => {
    const q: any = {};
    for (const m of ["select", "order", "limit"]) q[m] = () => q;
    q.eq = (col: string) => (col === "id" ? chain(table, true) : q);
    q.maybeSingle = async () => {
      if (table === "organizations") {
        if (db.orgFails) throw new Error("connection reset");
        return { data: db.org, error: null };
      }
      if (table === "profiles") {
        if (byId && db.meFails) return { data: null, error: { message: "canceling statement due to statement timeout" } };
        return { data: byId ? db.me : { full_name: "Larkspur Owner" }, error: null };
      }
      return { data: null, error: null };
    };
    return q;
  };
  const client = { auth: { getUser: async () => ({ data: { user: db.user } }) }, from: (t: string) => chain(t, false) };
  return { createClient: async () => client, createServiceClient: () => client };
});

import { voiceGate } from "./voice-gate";
import { reportError } from "@/lib/observe";

const CANCELED = { id: "org-1", name: null, email: null, settings: {}, subscription_status: "canceled", trial_ends_at: null, current_period_end: null, comped_until: null, stripe_customer_id: null, stripe_subscription_id: null };

beforeEach(() => {
  db.user = { id: "user-1" };
  db.me = { org_id: "org-1", role: "office" };
  db.org = { ...CANCELED, subscription_status: "active" };
  db.orgFails = false;
  db.meFails = false;
  db.limited = false;
  vi.mocked(reportError).mockClear();
});

describe("voiceGate", () => {
  it("a signed-in person of a standing company passes (null), for TTS and STT alike", async () => {
    expect(await voiceGate("tts", 120)).toBeNull();
    expect(await voiceGate("stt", 90)).toBeNull();
  });

  it("no session is 401, and the per-person window is 429, before any standing is read", async () => {
    db.user = null;
    expect((await voiceGate("tts", 120))?.status).toBe(401);
    db.user = { id: "user-1" };
    db.limited = true;
    expect((await voiceGate("stt", 90))?.status).toBe(429);
  });

  it("a company whose plan has ended is 402, in the asker's words: the owner is told the door", async () => {
    db.org = CANCELED;
    db.me = { org_id: "org-1", role: "owner" };
    const res = await voiceGate("tts", 120);
    expect(res?.status).toBe(402);
    expect(await res?.text()).toBe("This company's plan has ended, so Nort is paused. Pick a plan in Settings › Getting Paid.");
  });

  it("… and the crew is told who holds the key", async () => {
    db.org = { ...CANCELED, subscription_status: "trialing", trial_ends_at: "2020-01-01T00:00:00Z" };
    db.me = { org_id: "org-1", role: "tech" };
    const res = await voiceGate("stt", 90);
    expect(res?.status).toBe(402);
    expect(await res?.text()).toBe("This company's free trial has ended, so Nort is paused. Ask Larkspur to pick a plan.");
  });

  it("FAILS OPEN: a standing read that fails is filed and the voice call goes through; so does a profile with no company", async () => {
    db.orgFails = true;
    expect(await voiceGate("tts", 120)).toBeNull();
    expect(reportError).toHaveBeenCalledWith("org-access:read", expect.any(Error), { orgId: "org-1" });
    db.orgFails = false;
    db.org = CANCELED;
    db.me = null;
    expect(await voiceGate("tts", 120)).toBeNull();
  });

  it("a profile read that FAILED is filed (voice-gate:profile-read) and falls open — never a 402 guessed from no company (skeptic #43, N7)", async () => {
    db.org = CANCELED;
    db.meFails = true;
    expect(await voiceGate("stt", 90)).toBeNull();
    expect(reportError).toHaveBeenCalledWith("voice-gate:profile-read", expect.objectContaining({ message: "canceling statement due to statement timeout" }), { userId: "user-1" });
    expect(reportError).not.toHaveBeenCalledWith("org-access:read", expect.anything(), expect.anything());
  });
});
