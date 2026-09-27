import { describe, it, expect, vi, beforeEach } from "vitest";

// THE NORT SWITCH GOVERNS THE SETUP AI (0352). setup:converse (talkSetup), setup:talk (hearSetup)
// and setup:draft (draftMyPlaybook) never asked the switch, so a company that turned Nort off still
// paid a model to phrase its setup. Off: the plain questions, and no model call at all.
const state = vi.hoisted(() => ({
  tables: {} as Record<string, { data: unknown; error: unknown }>,
  modelCalls: 0,
  hearCalls: 0,
  overCeiling: false,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("./settings/actions", () => ({ updateOrgSettings: vi.fn(async () => ({ ok: true })) }));
vi.mock("./forms/actions", () => ({ createStarterInspectionSheet: vi.fn(async () => ({ ok: true, id: "f1" })) }));
vi.mock("@/lib/ai-cost", () => ({
  recordAiUsage: vi.fn(async () => undefined),
  aiSpendExceeded: vi.fn(async () => state.overCeiling),
  currentOrgId: vi.fn(async () => "org-1"),
}));
vi.mock("@/lib/anthropic", () => ({
  DEFAULT_MODEL: "test-model",
  getAnthropic: () => ({
    messages: {
      create: vi.fn(async () => {
        state.modelCalls++;
        return { content: [{ type: "text", text: '{"say":"Got it.","fills":[],"needs":[]}' }], usage: {} };
      }),
    },
  }),
}));
vi.mock("@/lib/playbook/hear-run", () => ({
  runHear: vi.fn(async () => {
    state.hearCalls++;
    return { ok: true, answers: {}, filled: [], note: "" };
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) },
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) chain[m] = () => chain;
      chain.maybeSingle = async () => state.tables[table] ?? { data: null, error: null };
      return chain;
    },
  })),
}));

import { draftMyPlaybook, hearSetup, talkSetup } from "./setup-actions";

const SHEET = [{ key: "work_type", label: "What kind of work", type: "select", options: ["Repair", "Other"] }];
const org = (nort: boolean) => ({ data: { settings: { features: { nort } } }, error: null });

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  state.tables = {
    organizations: org(true),
    profiles: { data: { nort_humor: 1, nort_register: "clean" }, error: null },
    forms: { data: { id: "f1", schema: SHEET, playbook: null }, error: null },
  };
  state.modelCalls = 0;
  state.hearCalls = 0;
  state.overCeiling = false;
});

describe("Nort off: the plain questions, and no model call", () => {
  beforeEach(() => {
    state.tables.organizations = org(false);
  });

  it("talkSetup says so in plain words and calls nothing", async () => {
    const r = await talkSetup("trade", {}, "I'm a painter");
    expect(r).toEqual({ ok: false, error: expect.stringContaining("type your answers into the boxes") });
    expect(r.ok ? "" : r.error).not.toMatch(/\bI\b/);
    expect(state.modelCalls).toBe(0);
  });

  it("hearSetup never reaches the extraction model", async () => {
    const r = await hearSetup({}, "I'm a painter out of Reno");
    expect(r.ok).toBe(false);
    expect(state.hearCalls).toBe(0);
  });

  it("draftMyPlaybook hands back the company's own questions, undrafted", async () => {
    const r = await draftMyPlaybook();
    expect(r).toMatchObject({ ok: true, formId: "f1", wasDrafted: false });
    expect(r.ok && r.needs.map((n) => n.key)).toEqual(["work_type"]);
    expect(state.modelCalls).toBe(0);
  });

  it("a settings read that fails counts as off: the plain path, never a guess", async () => {
    state.tables.organizations = { data: null, error: { message: "boom" } };
    expect((await talkSetup("trade", {}, "hi")).ok).toBe(false);
    expect((await draftMyPlaybook())).toMatchObject({ ok: true, wasDrafted: false });
    expect(state.modelCalls).toBe(0);
  });
});

describe("Nort on: the same doors as before", () => {
  it("talkSetup replies through the model", async () => {
    const r = await talkSetup("trade", {}, "I'm a painter");
    expect(r.ok).toBe(true);
    expect(state.modelCalls).toBe(1);
  });

  it("hearSetup extracts", async () => {
    expect((await hearSetup({}, "I'm a painter")).ok).toBe(true);
    expect(state.hearCalls).toBe(1);
  });

  it("draftMyPlaybook drafts", async () => {
    expect((await draftMyPlaybook()).ok).toBe(true);
    expect(state.modelCalls).toBe(1);
  });

  it("...except past this month's ceiling, where the draft door now falls back like talkSetup does", async () => {
    state.overCeiling = true;
    expect(await draftMyPlaybook()).toMatchObject({ ok: true, wasDrafted: false });
    expect(state.modelCalls).toBe(0);
  });

  it("no stored switch board reads as on (0352's read rule)", async () => {
    state.tables.organizations = { data: { settings: {} }, error: null };
    expect((await talkSetup("trade", {}, "hi")).ok).toBe(true);
    expect(state.modelCalls).toBe(1);
  });
});
