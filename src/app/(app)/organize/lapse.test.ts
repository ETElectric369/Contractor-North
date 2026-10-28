import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * THE PAPER READER AND THE PLAN THAT HAS ENDED (cn-v1137, decision 3). readInto — the one reader
 * every office uses most — had no gate at all. Now it asks aiAllowed before the download: a paused
 * company's paper is NOT lost (it stays in the tray, the row says the reader is paused), the answer
 * says the one action, and the model is never reached. AI Review of a note asks the same gate.
 */
const state = vi.hoisted(() => ({
  gate: { ok: true } as { ok: true } | { ok: false; why: string; reason: "lapsed" | "ceiling" },
  updates: [] as { payload: Record<string, unknown>; eqs: [string, unknown][] }[],
  downloads: 0,
  modelCalls: 0,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/staff-guard", () => ({ requireStaff: vi.fn(async () => ({ supabase: client, userId: "user-1", orgId: "org-1" })) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client) }));
vi.mock("@/lib/ai-cost", () => ({ aiAllowed: vi.fn(async () => state.gate), modelFor: () => "test-model", recordAiUsage: async () => {} }));
vi.mock("@/lib/ai-json", () => ({ parseAiJson: async () => ({ kind: "note", confidence: "low" }) }));
vi.mock("@/lib/analytics/job-profitability", () => ({ listJobScopes: async () => [] }));
vi.mock("@/lib/observe", () => ({ reportError: () => {} }));
vi.mock("@/lib/anthropic", () => ({
  DEFAULT_MODEL: "test-model",
  getAnthropic: () => ({
    messages: {
      create: async () => {
        state.modelCalls++;
        return { model: "test-model", content: [{ type: "text", text: "{}" }], usage: {} };
      },
    },
  }),
}));

const PAPER = { id: "item-1", title: "receipt.jpg", file_url: "org-1/receipts/receipt.jpg", status: "needs_review", org_id: "org-1" };

/** organized_items: the row by id (select), and every update with its filters kept; other tables empty. */
const client = {
  auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
  storage: {
    from: () => ({
      download: async () => {
        state.downloads++;
        return { data: { arrayBuffer: async () => new ArrayBuffer(8) }, error: null };
      },
    }),
  },
  from: (table: string) => {
    let verb: "select" | "update" = "select";
    let payload: Record<string, unknown> = {};
    const eqs: [string, unknown][] = [];
    const answer = () => {
      if (table === "organized_items" && verb === "update") {
        state.updates.push({ payload, eqs });
        return { data: [{ id: "item-1" }], error: null };
      }
      if (table === "organized_items") return { data: PAPER, error: null };
      return { data: [], error: null };
    };
    const q: any = {
      select: () => q,
      update: (p: Record<string, unknown>) => ((verb = "update"), (payload = p), q),
      eq: (c: string, v: unknown) => (eqs.push([c, v]), q),
      in: () => q,
      is: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: async () => answer(),
      single: async () => answer(),
      then: (ok: (v: unknown) => void) => ok(answer()),
    };
    return q;
  },
};

import { aiReviewItem, readPaperworkItem } from "./actions";

const WHY = "This company's free trial has ended, so Nort is paused. Ask Larkspur to pick a plan.";

beforeEach(() => {
  state.gate = { ok: true };
  state.updates = [];
  state.downloads = 0;
  state.modelCalls = 0;
});

describe("Read Now and a plan that has ended", () => {
  it("refuses in words, keeps the paper waiting with the row saying so, downloads nothing and never reaches the model", async () => {
    state.gate = { ok: false, reason: "lapsed", why: WHY };
    expect(await readPaperworkItem("item-1")).toEqual({ ok: false, error: `${WHY} The paper is saved and waiting.` });
    expect(state.downloads).toBe(0);
    expect(state.modelCalls).toBe(0);
    // The row: still needs_review (the write is guarded on it), the proposal naming the pause.
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].payload).toEqual({ proposal: { readError: "the reader is paused" } });
    expect(state.updates[0].eqs).toContainEqual(["org_id", "org-1"]);
    expect(state.updates[0].eqs).toContainEqual(["status", "needs_review"]);
  });

  it("a standing company's paper is downloaded and read", async () => {
    await readPaperworkItem("item-1");
    expect(state.downloads).toBe(1);
    expect(state.modelCalls).toBe(1);
  });
});

describe("AI Review of a note and a plan that has ended", () => {
  it("answers the refusal as its message, and reaches no model", async () => {
    state.gate = { ok: false, reason: "lapsed", why: WHY };
    expect(await aiReviewItem("item-1")).toEqual({ ok: false, message: WHY });
    expect(state.modelCalls).toBe(0);
  });
});
