import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * NORT AND THE PLAN THAT HAS ENDED (cn-v1137, decision 3). The chat route reads the company's
 * billing columns beside its settings (projection law: the standing check needs them on the same
 * read) and, when the plan has ended, answers the refusal as a NORMAL assistant turn — a 200 plain
 * text body, the shape a streamed answer has, so the phone renders it as Nort speaking — with the
 * one action in it: the owner is told the door, everyone else who holds the key, by name. No model
 * call, no ledger tick, no limiter tick. A standing company goes on to the limiters as before.
 *
 * Driven through the real POST with the two clients faked: the profile, the company row, the
 * owner's name, the ceiling RPC. The limiter is a spy that closes the door right after the gate, so
 * a standing company's turn is proven to pass the gate without running the whole stream.
 */
const db = vi.hoisted(() => ({
  prof: { language: "en", role: "office", nort_humor: 1, nort_register: "clean", nort_notes: null } as Record<string, unknown>,
  org: null as Record<string, unknown> | null,
  owner: "Larkspur Owner",
  selects: [] as string[],
  rpcs: [] as string[],
  limited: false,
}));
const model = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: vi.fn() }));
vi.mock("@/lib/stripe", async (orig) => ({ ...(await orig<typeof import("@/lib/stripe")>()), billingEnabled: true }));
vi.mock("@/lib/observe", async (orig) => ({ ...(await orig<typeof import("@/lib/observe")>()), reportError: vi.fn(), reportErrorAwaited: vi.fn(async () => {}) }));
vi.mock("@/lib/observe-blocker", () => ({ reportBlocker: vi.fn(), reportBlockerAwaited: vi.fn(async () => {}) }));
vi.mock("@/lib/rate-limit", () => ({ rateLimited: vi.fn(async () => db.limited), clientIp: () => "203.0.113.9" }));
vi.mock("@/lib/anthropic", () => ({
  DEFAULT_MODEL: "test-model",
  getAnthropic: () => ({ messages: { create: model.create } }),
  isModelDead: () => false,
  modelDeadError: (e: unknown) => e,
}));
vi.mock("@/lib/supabase/server", () => {
  const chain = (table: string, byId: boolean) => {
    const q: any = {};
    for (const m of ["order", "limit", "in", "is", "gte", "lte", "lt", "gt", "not", "or", "range"]) q[m] = () => q;
    q.select = (cols?: string) => {
      if (table === "organizations") db.selects.push(String(cols ?? ""));
      return q;
    };
    q.eq = (col: string) => (col === "id" ? chain(table, true) : q);
    const answer = () => {
      if (table === "organizations") return { data: db.org, error: null };
      if (table === "profiles") return { data: byId ? db.prof : { full_name: db.owner }, error: null };
      return { data: null, error: null };
    };
    q.maybeSingle = async () => answer();
    q.single = async () => answer();
    q.then = (ok: (v: unknown) => void) => ok({ data: [], error: null });
    return q;
  };
  const client = {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    from: (table: string) => chain(table, false),
    rpc: async (fn: string) => {
      db.rpcs.push(fn);
      return { data: 0, error: null };
    },
  };
  return { createClient: async () => client, createServiceClient: () => client };
});

import { POST } from "./route";
import { rateLimited } from "@/lib/rate-limit";

const BILLING = "subscription_status, trial_ends_at, current_period_end, comped_until";
const STANDING = { id: "org-1", settings: {}, subscription_status: "active", trial_ends_at: null, current_period_end: null, comped_until: null };
const ask = () => POST(new Request("https://app.test/api/chat", { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "what's on today?" }] }) }));

beforeEach(() => {
  db.prof = { language: "en", role: "office", nort_humor: 1, nort_register: "clean", nort_notes: null };
  db.org = STANDING;
  db.owner = "Larkspur Owner";
  db.selects = [];
  db.rpcs = [];
  db.limited = false;
  model.create.mockReset();
  vi.mocked(rateLimited).mockClear();
});

describe("POST /api/chat and a plan that has ended", () => {
  it("reads the billing columns, and the plan the usage meter budgets by, on the same trip as the settings (projection law)", async () => {
    db.limited = true; // the door right after the gate
    await ask();
    expect(db.selects).toHaveLength(1);
    expect(db.selects[0]).toBe(`id, settings, plan, ${BILLING}`);
  });

  it("a standing company passes the gate and reaches the limiters as before", async () => {
    db.limited = true;
    const res = await ask();
    expect(res.status).toBe(429);
    expect(await res.text()).toBe("Nort is catching up — give it a minute.");
    expect(rateLimited).toHaveBeenCalled();
  });

  it("the owner of a lapsed company is answered a normal turn — 200, plain text — naming the door; no model, no ledger, no limiter", async () => {
    db.org = { ...STANDING, subscription_status: "canceled" };
    db.prof = { ...db.prof, role: "owner" };
    const res = await ask();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(await res.text()).toBe("This company's plan has ended, so Nort is paused. Pick a plan in Settings › Getting Paid.");
    expect(model.create).not.toHaveBeenCalled();
    expect(db.rpcs).toEqual([]); // no ai_spend_since, no record_ai_usage
    expect(rateLimited).not.toHaveBeenCalled();
  });

  it("the crew of a lapsed company is told who holds the key, by the owner's first name (one small read)", async () => {
    db.org = { ...STANDING, subscription_status: "trialing", trial_ends_at: "2020-01-01T00:00:00Z" };
    db.prof = { ...db.prof, role: "tech" };
    const res = await ask();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("This company's free trial has ended, so Nort is paused. Ask Larkspur to pick a plan.");
    db.owner = "";
    expect(await (await ask()).text()).toBe("This company's free trial has ended, so Nort is paused. Ask the owner to pick a plan.");
    expect(model.create).not.toHaveBeenCalled();
  });

  it("a comped company (0400's column) is never lapsed, whatever Stripe says", async () => {
    db.org = { ...STANDING, subscription_status: "canceled", comped_until: "2099-01-01T00:00:00Z" };
    db.limited = true;
    expect((await ask()).status).toBe(429); // past the gate, at the limiter
  });

  it("Nort switched off still comes first: the 403 in the owner's words, before any standing", async () => {
    db.org = { ...STANDING, settings: { features: { nort: false } }, subscription_status: "canceled" };
    db.prof = { ...db.prof, role: "owner" };
    const res = await ask();
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Nort is off for your company. You can turn it on in Settings, under Features.");
  });
});
