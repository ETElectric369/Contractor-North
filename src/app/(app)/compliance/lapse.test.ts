import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * THE COMPLIANCE IMPORTS AND THE PLAN THAT HAS ENDED (cn-v1137, decision 3). Both doors read a
 * document with the model and had no gate at all. Now each asks aiAllowed first:
 *  - importPolicyDoc keeps the law "capture never requires typing": the upload is STILL filed as an
 *    Other item for review, with the refusal as its summary — the model is never reached;
 *  - importFromCslb has nothing to keep, so it refuses in words before CSLB is even fetched.
 */
const door = vi.hoisted(() => ({
  gate: { ok: true } as { ok: true } | { ok: false; why: string; reason: "lapsed" | "ceiling" },
  inserted: [] as Record<string, unknown>[],
  modelCalls: 0,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: client, userId: "user-1", orgId: "org-1" })) }));
vi.mock("@/lib/ai-cost", () => ({ aiAllowed: vi.fn(async () => door.gate), modelFor: () => "test-model", recordAiUsage: vi.fn(async () => {}) }));
vi.mock("@/lib/anthropic", () => ({
  DEFAULT_MODEL: "test-model",
  getAnthropic: () => ({
    messages: {
      create: async () => {
        door.modelCalls++;
        return { model: "test-model", content: [{ type: "text", text: '{"type":"Other","name":"x"}' }], usage: {} };
      },
    },
  }),
}));

/** compliance_items insert → .select("id").single(); the documents bucket hands back a small blob. */
const client = {
  from: (table: string) => {
    const q: any = {
      insert: (row: Record<string, unknown>) => {
        if (table === "compliance_items") door.inserted.push(row);
        return q;
      },
      select: () => q,
      eq: () => q,
      single: async () => ({ data: { id: "ci-1" }, error: null }),
      maybeSingle: async () => ({ data: null, error: null }),
      then: (ok: (v: unknown) => void) => ok({ data: [], error: null }),
    };
    return q;
  },
  storage: {
    from: () => ({
      download: async () => ({ data: new Blob([new Uint8Array([1, 2, 3])]), error: null }),
      remove: async () => ({ data: null, error: null }),
    }),
  },
};

import { importFromCslb, importPolicyDoc } from "./actions";

const WHY = "This company's free trial has ended, so Nort is paused. Pick a plan in Settings › Getting Paid.";
const fetchSpy = vi.fn(async () => new Response("<html>never</html>", { status: 200 }));

beforeEach(() => {
  door.gate = { ok: true };
  door.inserted = [];
  door.modelCalls = 0;
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => vi.unstubAllGlobals());

describe("importPolicyDoc and a plan that has ended", () => {
  it("files the upload for review with the refusal as its summary, and never reaches the model", async () => {
    door.gate = { ok: false, reason: "lapsed", why: WHY };
    const r = await importPolicyDoc({ path: "org-1/compliance/policy.pdf", mime: "application/pdf", fileName: "policy.pdf" });
    expect(r).toEqual({ ok: true, id: "ci-1", type: "Other", name: "policy", summary: WHY, reviewNeeded: true });
    expect(door.inserted).toHaveLength(1);
    expect(door.inserted[0]).toMatchObject({ type: "Other", name: "policy", file_url: "org-1/compliance/policy.pdf", notes: `Imported — not auto-read. ${WHY} Fill in the details.` });
    expect(door.modelCalls).toBe(0);
  });

  it("a standing company's upload is read", async () => {
    await importPolicyDoc({ path: "org-1/compliance/policy.pdf", mime: "application/pdf", fileName: "policy.pdf" });
    expect(door.modelCalls).toBe(1);
  });
});

describe("importFromCslb and a plan that has ended", () => {
  it("refuses in words before CSLB is fetched, and files nothing", async () => {
    door.gate = { ok: false, reason: "lapsed", why: WHY };
    expect(await importFromCslb("123456")).toEqual({ ok: false, error: WHY });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(door.inserted).toEqual([]);
    expect(door.modelCalls).toBe(0);
  });

  it("a bad number is still the first refusal: the gate is asked only of a real request", async () => {
    door.gate = { ok: false, reason: "lapsed", why: WHY };
    expect(await importFromCslb("12")).toMatchObject({ ok: false, error: expect.stringContaining("4–8 digits") });
  });
});
